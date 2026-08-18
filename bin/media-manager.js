#!/usr/bin/env node
import { spawn, spawnSync, exec } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * CLI for running media-manager against a data root.
 *
 * Usage:
 *   media-manager [serve] [root] [--port N] [--body-size-limit N] [--no-open] [--rebuild]
 *   media-manager init [dir]            scaffold a new empty workspace + config (auto-detects static assets)
 *   media-manager config [dir]          write a config for a workspace you already have (--force to overwrite)
 *                                       [--classic | --assets-dir <dir> --assets-base-url <url>]
 *   media-manager export <dest>         copy the workspace + reunite blobs into one self-contained folder
 *   media-manager build                 (re)build build/ and exit, without serving
 *   media-manager doctor
 *
 * Root discovery (Item 30) — precedence:
 *   1. explicit positional arg
 *   2. MEDIA_MANAGER_ROOT env
 *   3. media-manager.config.json (walked up from cwd; `root` resolved relative to the config file)
 *   4. friendly error (see `doctor`)
 *
 * Port (Item 31): binds an ephemeral OS-assigned port by default (no fixed 3000) so it never collides
 * with a host project's dev server; auto-opens the actually-bound URL on the server's readiness signal.
 * Pass `--port N` (or export `PORT`) to pin.
 *
 * Build (Item 30): if `build/` is absent it is built on demand; `--rebuild` forces a fresh build.
 * When this package is published, `build/` ships in the tarball, so consumers never build — the
 * on-demand path only fires in a git-clone / local-dep checkout.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, '..');
const buildPath = path.join(pkgRoot, 'build');
const CONFIG_NAME = 'media-manager.config.json';
const VERBS = new Set(['serve', 'init', 'doctor', 'config', 'build', 'export']);
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);

let verb = 'serve';
let sawVerb = false;
let rootArg;
let bodySizeLimit;
/** Explicit port pin via --port (optional); otherwise we probe an ephemeral one. */
let portFlag;
let noOpen = false;
let rebuild = false;
let force = false;
/** `config`/`init`: skip static-assets auto-detection (write a plain classic config). */
let classic = false;
/** `config`/`init`: explicit static-assets overrides (skip / override auto-detection). */
let assetsDirFlag;
let assetsBaseUrlFlag;
const passthrough = [];

for (let i = 0; i < argv.length; i++) {
	const arg = argv[i];
	if (arg === '--help' || arg === '-h' || arg === 'help') {
		printHelp();
		process.exit(0);
	}
	if (arg === '--body-size-limit') {
		bodySizeLimit = argv[++i];
		continue;
	}
	if (arg === '--port') {
		portFlag = argv[++i];
		continue;
	}
	if (arg === '--no-open') {
		noOpen = true;
		continue;
	}
	if (arg === '--rebuild') {
		rebuild = true;
		continue;
	}
	if (arg === '--force') {
		force = true;
		continue;
	}
	if (arg === '--classic') {
		classic = true;
		continue;
	}
	if (arg === '--assets-dir') {
		assetsDirFlag = argv[++i];
		continue;
	}
	if (arg === '--assets-base-url') {
		assetsBaseUrlFlag = argv[++i];
		continue;
	}
	if (arg.startsWith('--')) {
		passthrough.push(arg);
		continue;
	}
	// Positionals: an optional leading verb, then the root dir.
	if (!sawVerb && !rootArg && VERBS.has(arg)) {
		verb = arg;
		sawVerb = true;
		continue;
	}
	if (!rootArg) {
		rootArg = arg;
	} else {
		passthrough.push(arg);
	}
}

// ---------------------------------------------------------------------------
// Root discovery
// ---------------------------------------------------------------------------

/**
 * Walk up from `startDir` to the nearest `media-manager.config.json`, returning its absolute path or
 * null if none exists up to the filesystem root.
 *
 * @param {string} startDir - Directory to begin the upward search from.
 * @returns {string | null}
 */
function findConfig(startDir) {
	let dir = path.resolve(startDir);
	for (;;) {
		const candidate = path.join(dir, CONFIG_NAME);
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * Read + JSON-parse the nearest `media-manager.config.json` (walking up from `startDir`). Returns the
 * raw parsed object plus its path, or null if none exists. Throws only on malformed JSON — callers
 * decide whether that is fatal (it is when `root` comes from the config; it is best-effort when
 * reading the optional `assets` block for an arg/env-resolved root).
 *
 * @param {string} startDir - Where to begin the upward search.
 * @returns {{ configPath: string, parsed: any } | null}
 */
function readConfigRaw(startDir) {
	const configPath = findConfig(startDir);
	if (!configPath) return null;
	let parsed;
	try {
		parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
	} catch (e) {
		throw new Error(`Invalid JSON in ${configPath}: ${e.message}`);
	}
	return { configPath, parsed };
}

/**
 * Parse the optional `assets` block from a raw config object. Static-assets mode — blobs stored in the
 * host's served static folder instead of inside the workspace — is **opt-in**: it activates only when
 * `assets.dir` is a non-empty string. `dir` is resolved **relative to the config file's directory**
 * (like `root`); `baseUrl` is the web-address prefix the reader uses (defaults to `/media`).
 *
 * @param {any} parsed - The parsed config JSON.
 * @param {string} configDir - Directory containing the config file (base for the relative `dir`).
 * @returns {{ dir: string, baseUrl: string } | null} Absolute assets config, or null for classic mode.
 */
function parseAssetsBlock(parsed, configDir) {
	const a = parsed && typeof parsed === 'object' ? parsed.assets : null;
	if (!a || typeof a !== 'object') return null;
	if (typeof a.dir !== 'string' || a.dir.trim() === '') return null;
	const dir = path.resolve(configDir, a.dir);
	const baseUrl =
		typeof a.baseUrl === 'string' && a.baseUrl.trim() !== '' ? a.baseUrl.trim() : '/media';
	return { dir, baseUrl };
}

/**
 * Auto-detect a host project's served static folder, to propose a static-assets config. Recognizes
 * SvelteKit (`svelte.config.*` + `static/`), Next.js / Astro (`*.config.*` + `public/`), and a bare
 * `static/` or `public/`. Always proposes a **dedicated `media` subfolder** (never the shared root of
 * `static/`/`public/`) so the manifest reconcile can't adopt the site's own assets.
 *
 * @param {string} projectDir - The host repo root (where the config file lives = cwd for `config`/`init`).
 * @returns {{ framework: string, dir: string, baseUrl: string } | null} A suggestion (relative POSIX
 *   `dir`) or null when nothing looks like a static host.
 */
function detectAssets(projectDir) {
	const has = (p) => fs.existsSync(path.join(projectDir, p));
	let names = [];
	try {
		names = fs.readdirSync(projectDir);
	} catch {
		return null;
	}
	const hasConfig = (re) => names.some((n) => re.test(n));
	const svelte = hasConfig(/^svelte\.config\./);
	const next = hasConfig(/^next\.config\./);
	const astro = hasConfig(/^astro\.config\./);

	let base = null;
	let framework = 'static host';
	if (svelte && has('static')) {
		base = 'static';
		framework = 'SvelteKit';
	} else if ((next || astro) && has('public')) {
		base = 'public';
		framework = next ? 'Next.js' : 'Astro';
	} else if (has('static')) {
		base = 'static';
	} else if (has('public')) {
		base = 'public';
	}
	if (!base) return null;
	return { framework, dir: `./${base}/media`, baseUrl: '/media' };
}

/**
 * Decide the static-assets config to write for `config`/`init`: `--classic` disables it; explicit
 * `--assets-dir` (+ optional `--assets-base-url`) overrides detection; otherwise auto-detect from the
 * project dir. Returns null for classic (in-workspace) storage.
 *
 * @param {string} projectDir - Where the config lives (cwd).
 * @returns {{ framework?: string, dir: string, baseUrl: string } | null}
 */
function chooseAssets(projectDir) {
	if (classic) return null;
	if (assetsDirFlag) {
		const dir = assetsDirFlag.startsWith('.') ? assetsDirFlag : `./${assetsDirFlag}`;
		return { dir, baseUrl: assetsBaseUrlFlag || '/media' };
	}
	const detected = detectAssets(projectDir);
	if (detected && assetsBaseUrlFlag) detected.baseUrl = assetsBaseUrlFlag;
	return detected;
}

/**
 * Resolve the data root by the documented precedence: arg → env → config file → null. Also resolves
 * the optional static-`assets` block, which lives **only** in the config file — so it is read
 * regardless of how `root` resolved (fixing a short-circuit where an arg/env root skipped the config
 * entirely, silently disabling static mode). To avoid mis-routing blobs, `assets` is applied **only
 * when the config's own `root` resolves to the same workspace** we are about to serve — an unrelated
 * up-tree config can't hijack an explicit arg/env root.
 *
 * @param {string | undefined} explicitArg - A positional root path, if given.
 * @returns {{ root: string, source: 'arg' | 'env' | 'config', configPath?: string,
 *            assets?: { dir: string, baseUrl: string } } | null}
 * @throws If `root` comes from the config and the config is malformed / missing a non-empty `root`.
 */
function resolveRoot(explicitArg) {
	// Read the config once (best-effort). Malformed JSON throws here; that is only fatal if `root` ends
	// up coming from the config — otherwise we proceed in classic mode.
	let cfg = null;
	let cfgError = null;
	try {
		cfg = readConfigRaw(process.cwd());
	} catch (e) {
		cfgError = e;
	}

	let root;
	let source;
	let configPath;
	if (explicitArg) {
		root = path.resolve(explicitArg);
		source = 'arg';
	} else if (process.env.MEDIA_MANAGER_ROOT) {
		root = path.resolve(process.env.MEDIA_MANAGER_ROOT);
		source = 'env';
	} else {
		if (cfgError) throw cfgError;
		if (!cfg) return null;
		const r = cfg.parsed?.root;
		if (typeof r !== 'string' || r.trim() === '') {
			throw new Error(`${cfg.configPath} must set a non-empty "root" string.`);
		}
		root = path.resolve(path.dirname(cfg.configPath), r);
		source = 'config';
		configPath = cfg.configPath;
	}

	// Resolve the assets block from that same config — but apply it only when the config describes the
	// very workspace we resolved (guards against an unrelated up-tree config hijacking an arg/env root).
	let assets;
	if (cfg && !cfgError) {
		const configDir = path.dirname(cfg.configPath);
		const parsedAssets = parseAssetsBlock(cfg.parsed, configDir);
		const cfgRoot =
			typeof cfg.parsed?.root === 'string' ? path.resolve(configDir, cfg.parsed.root) : null;
		if (parsedAssets && cfgRoot && cfgRoot === root) {
			assets = parsedAssets;
			if (!configPath) configPath = cfg.configPath;
		}
	}

	return { root, source, configPath, assets };
}

/** Print CLI usage (for `--help` / `-h` / `help`). */
function printHelp() {
	console.log(
		`media-manager — local-first media metadata manager

Usage:
  media-manager [serve] [root] [options]   Run the app (default verb)
  media-manager init [dir]                 Scaffold a NEW empty workspace + config
  media-manager config [dir]               Write a config for a workspace you ALREADY have
  media-manager export <dest>              Copy the workspace + reunite blobs into one folder
  media-manager build                      (Re)build build/ and exit, without serving
  media-manager doctor                     Diagnose root / config / build / assets (no server)

Root resolution (serve · doctor · export):
  explicit arg → MEDIA_MANAGER_ROOT env → ${CONFIG_NAME} (walked up from cwd) → friendly error

Static assets (optional, in ${CONFIG_NAME}):
  { "root": "…", "assets": { "dir": "./static/media", "baseUrl": "/media" } }
  Stores blobs in the host's served static folder (CDN-served, not bundled) instead of
  <root>/media/files. Opt-in; omit "assets" for classic in-workspace storage.
  config · init auto-detect it (SvelteKit static/, Next/Astro public/); override with
  --assets-dir <dir> / --assets-base-url <url>, or --classic to force in-workspace storage.

Options:
  --port N             Pin a fixed port (default: an ephemeral OS-assigned port)
  --no-open            Do not open the browser on start
  --rebuild            Force a fresh build even if build/ already exists
  --force              (init · config) overwrite an existing ${CONFIG_NAME}
  --body-size-limit N  Upload request body size limit in bytes (default ~100 MiB)
  -h, --help           Show this help

Examples:
  media-manager ./my-data            Serve a folder directly
  media-manager config ./src/assets/media_manager   Write a config for existing data, then:
  media-manager                      Serve via the discovered config (ephemeral port, auto-open)`
	);
}

/** Print the shared "no workspace found" guidance (used by serve + doctor). */
function printNoRoot() {
	console.error(
		'✘ Could not find a workspace.\n' +
			'  Tried: no path arg · MEDIA_MANAGER_ROOT unset · no ' +
			CONFIG_NAME +
			' found\n' +
			`  (searched ${process.cwd()} upward)\n\n` +
			'  Fix one of:\n' +
			'    • run  media-manager ./path/to/data\n' +
			`    • drop a ${CONFIG_NAME} with { "root": "…" }\n` +
			'    • run  media-manager init  to scaffold a fresh workspace'
	);
}

// ---------------------------------------------------------------------------
// Build-on-demand
// ---------------------------------------------------------------------------

/**
 * Ensure the SvelteKit node build exists, building it once on demand when absent (or always when
 * `--rebuild`). Exits the process on build failure.
 *
 * @param {boolean} force - Rebuild even if `build/` already exists.
 */
function ensureBuilt(force) {
	const exists = fs.existsSync(buildPath);
	if (exists && !force) return;
	console.log(
		force ? '[media-manager] building…' : '[media-manager] build/ not found — building once…'
	);
	const res = spawnSync(npmCmd, ['run', 'build'], {
		cwd: pkgRoot,
		stdio: 'inherit',
		shell: process.platform === 'win32'
	});
	if (res.status !== 0) {
		console.error('[media-manager] Build failed.');
		process.exit(res.status ?? 1);
	}
}

// ---------------------------------------------------------------------------
// Port helpers (Item 31)
// ---------------------------------------------------------------------------

/**
 * Ask the OS for a free TCP port by binding port 0 and reading back the assigned port, then closing.
 * There is a tiny TOCTOU window between this close and the child binding — acceptable for a local,
 * single-user tool.
 *
 * @returns {Promise<number>} an available port number.
 */
function findFreePort() {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.unref();
		srv.once('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
	});
}

/** Open a URL in the default browser (best-effort, cross-platform). */
function openUrl(url) {
	const cmd =
		process.platform === 'darwin'
			? `open "${url}"`
			: process.platform === 'win32'
				? `start "" "${url}"`
				: `xdg-open "${url}"`;
	exec(cmd, (err) => {
		if (err) console.warn('[media-manager] Could not open browser:', err.message);
	});
}

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------

/** `serve` (default): resolve root, build if needed, bind an ephemeral port, open on readiness. */
async function serve() {
	const resolved = resolveRoot(rootArg);
	if (!resolved) {
		printNoRoot();
		process.exit(1);
	}
	if (!fs.existsSync(resolved.root)) {
		console.error(`✘ Root does not exist: ${resolved.root} (from ${resolved.source})`);
		process.exit(1);
	}

	ensureBuilt(rebuild);

	const env = { ...process.env };
	env.MEDIA_MANAGER_ROOT = resolved.root;

	// Tell the server which config file backs this session, so the in-app Storage settings can rewrite
	// its `assets` block (or CREATE it on first save when none exists yet). Always a concrete path: the
	// resolved config when one was consulted, else the conventional `<root>/media-manager.config.json`.
	env.MEDIA_MANAGER_CONFIG_PATH = resolved.configPath ?? path.join(resolved.root, CONFIG_NAME);

	// Static-assets mode: point the blob subsystem at the configured host static dir. Create it once,
	// visibly, up front — never let a lazy upload `mkdir` silently materialize a mistyped path.
	if (resolved.assets) {
		env.MEDIA_MANAGER_ASSETS_DIR = resolved.assets.dir;
		env.MEDIA_MANAGER_ASSETS_BASE_URL = resolved.assets.baseUrl;
		if (!fs.existsSync(resolved.assets.dir)) {
			fs.mkdirSync(resolved.assets.dir, { recursive: true });
			console.log(`[media-manager] created static assets dir: ${resolved.assets.dir}`);
		}
		console.log(
			`[media-manager] static assets: blobs in ${resolved.assets.dir} (reader baseUrl ${resolved.assets.baseUrl})`
		);
	}

	if (bodySizeLimit) {
		env.BODY_SIZE_LIMIT = bodySizeLimit;
	} else if (!env.BODY_SIZE_LIMIT) {
		const defaultLimitBytes = 100 * 1024 * 1024;
		env.BODY_SIZE_LIMIT = String(defaultLimitBytes);
		console.warn(
			[
				'[media-manager] BODY_SIZE_LIMIT was not set;',
				`defaulting to ${defaultLimitBytes} bytes (~100 MiB) for uploads.`,
				'This is intended for local use only. If you expose this server publicly,',
				'please set a smaller BODY_SIZE_LIMIT or run behind a reverse proxy with its',
				'own upload limits.'
			].join(' ')
		);
	}

	// Port precedence: --port flag → an already-exported PORT → probe an ephemeral one.
	const boundPort = String(portFlag || env.PORT || (await findFreePort()));
	env.PORT = boundPort;
	const url = `http://localhost:${boundPort}`;

	// Pipe the child's stdout so we can detect the real readiness signal while still forwarding logs.
	const child = spawn(process.execPath, [buildPath, ...passthrough], {
		stdio: ['inherit', 'pipe', 'inherit'],
		env
	});

	let opened = false;
	const openOnce = () => {
		if (opened || noOpen) return;
		opened = true;
		openUrl(url);
	};

	// adapter-node logs "Listening on http://<host>:<port>" once bound — open on that signal, not a guess.
	child.stdout.on('data', (chunk) => {
		process.stdout.write(chunk);
		if (!opened && /Listening on/i.test(chunk.toString())) openOnce();
	});

	// Fallback: if the readiness line never appears, open anyway after a short grace period.
	const fallback = setTimeout(openOnce, 8000);
	fallback.unref?.();

	child.on('exit', (code, signal) => {
		clearTimeout(fallback);
		if (signal) process.kill(process.pid, signal);
		process.exit(code ?? 0);
	});
}

/**
 * Write `media-manager.config.json` in the current directory pointing at `target`. Leaves an existing
 * config untouched unless `force`. `root` is stored **relative to cwd** (POSIX-style, `./`-prefixed)
 * so it stays portable.
 *
 * @param {string} target - Absolute path to the workspace the config should point at.
 * @param {boolean} overwrite - Overwrite an existing config.
 * @returns {{ configPath: string, root: string, wrote: boolean }}
 */
function writeConfigFile(target, overwrite, assets) {
	const configPath = path.join(process.cwd(), CONFIG_NAME);
	const rel = path.relative(process.cwd(), target) || '.';
	const relPosix = rel.split(path.sep).join('/');
	const root = relPosix.startsWith('.') ? relPosix : `./${relPosix}`;
	if (fs.existsSync(configPath) && !overwrite) return { configPath, root, wrote: false };
	const doc = assets ? { root, assets: { dir: assets.dir, baseUrl: assets.baseUrl } } : { root };
	fs.writeFileSync(configPath, JSON.stringify(doc, null, 2) + '\n');
	return { configPath, root, wrote: true };
}

/**
 * Create the dedicated static-assets subfolder (relative `dir` resolved against cwd) so blobs have a
 * home the moment the editor runs — enforcing a **dedicated** dir rather than a shared `static/` root.
 *
 * @param {{ dir: string, baseUrl: string, framework?: string }} assets
 */
function ensureAssetsDir(assets) {
	const absDir = path.resolve(process.cwd(), assets.dir);
	fs.mkdirSync(absDir, { recursive: true });
	const detail = assets.framework ? `detected ${assets.framework}` : 'explicit';
	console.log(`✔ assets      ${assets.dir}  (served at ${assets.baseUrl}; ${detail})`);
}

/** Does `dir` look like an already-initialized media-manager workspace? */
function looksLikeWorkspace(dir) {
	return (
		fs.existsSync(path.join(dir, 'media')) ||
		fs.existsSync(path.join(dir, 'globals')) ||
		fs.existsSync(path.join(dir, 'records'))
	);
}

/**
 * `init [dir]`: scaffold an **empty** workspace directory and a config pointing at it. The app's own
 * first-launch healing fills in `media/` etc. on the first `serve`. To point at a workspace you
 * **already have** (without scaffolding), use `config` instead.
 */
function init() {
	const target = path.resolve(rootArg || './media_manager');
	fs.mkdirSync(target, { recursive: true });

	const assets = chooseAssets(process.cwd());
	const { configPath, wrote } = writeConfigFile(target, force, assets);
	console.log(`✔ workspace   ${target}`);
	console.log(
		wrote
			? `✔ config      ${configPath}`
			: `· config      ${configPath} already exists, left as-is`
	);
	if (wrote && assets) ensureAssetsDir(assets);
	console.log(
		'\nNext: run  media-manager  to start (it will build + heal the workspace on first launch).'
	);
}

/**
 * `config [dir]`: generate a `media-manager.config.json` (in cwd) pointing at a workspace you
 * **already have** (`dir`, default cwd). Unlike `init` it never scaffolds; it refuses to clobber an
 * existing config unless `--force`.
 */
function config() {
	const target = path.resolve(rootArg || '.');
	if (!fs.existsSync(target)) {
		console.error(
			`✘ ${target} does not exist. Pass an existing workspace dir, or use \`init\` to scaffold one.`
		);
		process.exit(1);
	}

	const assets = chooseAssets(process.cwd());
	const { configPath, root, wrote } = writeConfigFile(target, force, assets);
	if (!wrote) {
		console.error(`✘ ${configPath} already exists. Re-run with --force to overwrite.`);
		process.exit(1);
	}

	console.log(`✔ config      ${configPath}  → root: ${root}`);
	if (assets) ensureAssetsDir(assets);
	if (!looksLikeWorkspace(target)) {
		console.log(
			`· note: ${target} has no media/ · globals/ · records/ yet — it'll be healed on first serve.`
		);
	}
	console.log('\nNext: run  media-manager  to start.');
}

/** `doctor`: diagnose root/config/build without starting the server. */
function doctor() {
	let resolved = null;
	try {
		resolved = resolveRoot(rootArg);
	} catch (e) {
		console.error(`✘ config      ${e.message}`);
		process.exit(1);
	}

	if (!resolved) {
		printNoRoot();
		process.exit(1);
	}

	const tick = (ok) => (ok ? '✔' : '✘');
	if (resolved.source === 'config') console.log(`✔ config      ${resolved.configPath}`);
	else if (resolved.configPath)
		console.log(`· config      root via ${resolved.source}; assets via ${resolved.configPath}`);
	else console.log(`· config      (using ${resolved.source}; no ${CONFIG_NAME} consulted)`);

	const rootExists = fs.existsSync(resolved.root);
	let writable = false;
	try {
		fs.accessSync(resolved.root, fs.constants.W_OK);
		writable = true;
	} catch {
		writable = false;
	}
	console.log(
		`${tick(rootExists)} root        ${resolved.root}` +
			(rootExists ? ` (${writable ? 'writable' : 'NOT writable'})` : ' (does not exist — run init)')
	);

	if (rootExists) {
		const hasHub = fs.existsSync(path.join(resolved.root, 'media'));
		console.log(
			`${hasHub ? '✔' : '·'} workspace   ${hasHub ? 'media/ hub present' : 'empty — will heal on first serve'}`
		);
	}

	// Static-assets mode (opt-in): report where blobs live and validate the dir against the manifest.
	// A missing-on-disk blob is a hard failure (it becomes a runtime 404 — the build-time existence
	// check the bundler used to give us); foreign files hint the dir isn't dedicated (reconcile-safe).
	let assetsProblems = 0;
	if (resolved.assets) {
		const dir = resolved.assets.dir;
		const dirExists = fs.existsSync(dir);
		console.log(
			`${dirExists ? '✔' : '!'} assets      static mode — blobs in ${dir}` +
				(dirExists ? '' : ' (missing — created on first serve)')
		);
		console.log(`            served at ${resolved.assets.baseUrl} (reader baseUrl)`);

		if (dirExists && rootExists) {
			const manifestNames = new Set();
			try {
				const m = JSON.parse(
					fs.readFileSync(path.join(resolved.root, 'media', 'manifest.json'), 'utf-8')
				);
				for (const e of Object.values(m.files || {})) {
					if (e && typeof e.file_name === 'string') manifestNames.add(e.file_name);
				}
			} catch {
				/* no manifest yet — first serve will create it */
			}
			const diskNames = fs
				.readdirSync(dir, { withFileTypes: true })
				.filter((d) => d.isFile() && !d.name.startsWith('.') && !d.name.endsWith('.lock'))
				.map((d) => d.name);
			const diskSet = new Set(diskNames);
			const missingOnDisk = [...manifestNames].filter((n) => !diskSet.has(n));
			const foreign = diskNames.filter((n) => !manifestNames.has(n));
			const lower = diskNames.map((n) => n.toLowerCase());
			const collisions = lower.filter((n, i) => lower.indexOf(n) !== i);

			if (missingOnDisk.length) {
				assetsProblems++;
				console.log(
					`✘ assets      ${missingOnDisk.length} manifest blob(s) absent from the dir — these 404 at runtime` +
						`\n            e.g. ${missingOnDisk.slice(0, 3).join(', ')}`
				);
			}
			if (collisions.length) {
				assetsProblems++;
				console.log(
					`✘ assets      case-insensitive filename collision(s): ${[...new Set(collisions)].slice(0, 3).join(', ')}`
				);
			}
			if (foreign.length) {
				console.log(
					`! assets      ${foreign.length} file(s) in the dir are not manifest blobs — is this a dedicated media/ subfolder?` +
						`\n            e.g. ${foreign.slice(0, 3).join(', ')}`
				);
			}
			if (!missingOnDisk.length && !collisions.length && !foreign.length && manifestNames.size) {
				console.log(`✔ assets      ${manifestNames.size} blob(s) present, no strays`);
			}
		}
	} else {
		console.log('· assets      classic mode — blobs in <root>/media/files');
	}

	const built = fs.existsSync(buildPath);
	console.log(
		`${built ? '✔' : '!'} build       ${built ? 'present' : 'missing — will build on first serve (or --rebuild)'}`
	);
	console.log('✔ port        ephemeral (OS-assigned; pin with --port N)');

	process.exit(rootExists && assetsProblems === 0 ? 0 : 1);
}

/** `build`: (re)build the Node server (`build/`) and exit, without starting the server. */
function build() {
	ensureBuilt(true);
	console.log('✔ build complete.');
}

/**
 * `export <dest>`: write a **canonical, re-openable** copy of the current workspace to `<dest>` —
 * reuniting the blobs (which in static-assets mode live outside the workspace) back into
 * `<dest>/media/files/`, so the result is a self-contained classic-layout tree you can archive, hand
 * off, or open with `media-manager <dest>`.
 *
 * Source resolution: the workspace is resolved from the env/config (the workspace you're "in"), and the
 * single positional is the **destination**. Blobs are copied **by manifest** (not by scanning the dir),
 * so a shared static folder's foreign files never leak into the export; a manifest blob absent from the
 * source is reported (and exits non-zero) rather than silently dropped. The per-workspace Google secret
 * (`media/google.json`) and `.lock` files are excluded.
 */
function exportWorkspace() {
	const dest = rootArg ? path.resolve(rootArg) : null;
	if (!dest) {
		console.error('✘ export needs a destination:  media-manager export <dest>');
		process.exit(1);
	}

	let resolved;
	try {
		resolved = resolveRoot(undefined); // source = env/config, never the positional (that's the dest)
	} catch (e) {
		console.error(`✘ config      ${e.message}`);
		process.exit(1);
	}
	if (!resolved) {
		printNoRoot();
		process.exit(1);
	}
	const root = resolved.root;
	if (!fs.existsSync(root)) {
		console.error(`✘ Root does not exist: ${root} (from ${resolved.source})`);
		process.exit(1);
	}

	const blobDir = resolved.assets ? resolved.assets.dir : path.join(root, 'media', 'files');

	// Reject a destination that overlaps EITHER the workspace or (in static mode) the served assets dir
	// — exporting into the CDN-served static folder would dump the JSON tree into it.
	const overlaps = (a, b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
	if (overlaps(dest, root) || overlaps(dest, blobDir)) {
		console.error(`✘ destination overlaps the source workspace or its assets dir: ${dest}`);
		process.exit(1);
	}
	if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0 && !force) {
		console.error(`✘ destination is not empty: ${dest} (re-run with --force to overwrite)`);
		process.exit(1);
	}

	// Copy the JSON tree, excluding the in-workspace blob subtree (populated below), the Google secret,
	// and lock files.
	const filesSubtree = path.join(root, 'media', 'files');
	const derivedSubtree = path.join(root, 'media', 'derived');
	const googleSecret = path.join(root, 'media', 'google.json');
	fs.cpSync(root, dest, {
		recursive: true,
		force: true,
		filter: (src) => {
			if (src === filesSubtree || src.startsWith(filesSubtree + path.sep)) return false;
			// Compressed derivatives (Item 15) are copied by manifest below, exactly like blobs — in
			// static-assets mode they live outside the workspace entirely, so a tree copy would miss them.
			if (src === derivedSubtree || src.startsWith(derivedSubtree + path.sep)) return false;
			if (src === googleSecret) return false;
			if (src.endsWith('.lock')) return false;
			return true;
		}
	});
	console.log(`✔ workspace   JSON tree → ${dest}`);

	// Reunite blobs by manifest.
	let manifestNames = [];
	/** `<preset>/<name>` paths of every derivative the manifest currently references. */
	let derivedRel = [];
	try {
		const m = JSON.parse(fs.readFileSync(path.join(root, 'media', 'manifest.json'), 'utf-8'));
		for (const e of Object.values(m.files || {})) {
			if (!e || typeof e.file_name !== 'string') continue;
			manifestNames.push(e.file_name);
			for (const [presetId, d] of Object.entries(e.derived || {})) {
				if (d && typeof d.file_name === 'string') derivedRel.push(`${presetId}/${d.file_name}`);
			}
		}
	} catch {
		console.log('· manifest    none found — exporting JSON only (no blobs)');
	}

	const destFiles = path.join(dest, 'media', 'files');
	fs.mkdirSync(destFiles, { recursive: true });
	const missing = [];
	const seenLower = new Map();
	const collisions = new Set();
	let copied = 0;
	for (const name of manifestNames) {
		const srcBlob = path.join(blobDir, name);
		if (!fs.existsSync(srcBlob)) {
			missing.push(name);
			continue;
		}
		const key = name.toLowerCase();
		if (seenLower.has(key) && seenLower.get(key) !== name) collisions.add(key);
		seenLower.set(key, name);
		fs.copyFileSync(srcBlob, path.join(destFiles, name));
		copied++;
	}

	console.log(`✔ blobs       ${copied}/${manifestNames.length} copied from ${blobDir}`);
	if (collisions.size) {
		console.log(
			`! blobs       case-insensitive collision(s) may clobber on a case-insensitive FS: ${[...collisions].slice(0, 3).join(', ')}`
		);
	}
	if (missing.length) {
		console.log(
			`✘ blobs       ${missing.length} manifest blob(s) absent from the source: ${missing.slice(0, 5).join(', ')}`
		);
	}

	// Compressed derivatives (Item 15). Copied by manifest for the same reason blobs are, and resolved
	// from the *blob* dir's derived root: classic keeps them at `<root>/media/derived` (a sibling of
	// `media/files`), static-assets mode at `<assetsDir>/derived` (inside the published root). They are
	// regenerable, so a missing one is a note, never a non-zero exit.
	if (derivedRel.length) {
		const srcDerived = resolved.assets
			? path.join(blobDir, 'derived')
			: path.join(root, 'media', 'derived');
		const destDerived = path.join(dest, 'media', 'derived');
		let derivedCopied = 0;
		for (const rel of derivedRel) {
			const srcFile = path.join(srcDerived, rel);
			if (!fs.existsSync(srcFile)) continue;
			const dstFile = path.join(destDerived, rel);
			fs.mkdirSync(path.dirname(dstFile), { recursive: true });
			fs.copyFileSync(srcFile, dstFile);
			derivedCopied++;
		}
		console.log(
			`${derivedCopied === derivedRel.length ? '✔' : '!'} derived     ${derivedCopied}/${derivedRel.length} compressed derivative(s) copied` +
				(derivedCopied === derivedRel.length
					? ''
					: ' — run a backfill in the export to regenerate the rest')
		);
	}

	const openRel = path.relative(process.cwd(), dest) || dest;
	console.log(`\nRe-open with:  media-manager ${openRel}`);
	process.exit(missing.length ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function main() {
	if (verb === 'init') return init();
	if (verb === 'config') return config();
	if (verb === 'doctor') return doctor();
	if (verb === 'build') return build();
	if (verb === 'export') return exportWorkspace();
	return serve();
}

main().catch((err) => {
	console.error('[media-manager]', err?.message || err);
	process.exit(1);
});
