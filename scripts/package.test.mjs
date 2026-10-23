import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
// Do not inherit a real workspace or production-only build settings into disposable installs.
const env = { ...process.env, NODE_ENV: 'development' };
for (const key of Object.keys(env)) {
	if (key.startsWith('MEDIA_MANAGER_') || key === 'PORT' || key === 'HOST') delete env[key];
}

/** Run a real packaging command, preserving its output for actionable assertion failures. */
function run(command, args, cwd) {
	const result = spawnSync(command, args, {
		cwd,
		env,
		encoding: 'utf8',
		shell: process.platform === 'win32' && command === npm,
		timeout: 600_000,
		maxBuffer: 20 * 1024 * 1024
	});
	assert.ifError(result.error);
	assert.equal(
		result.status,
		0,
		`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`
	);
	return result.stdout;
}

/** Smoke-test the installed CLI over HTTP and terminate the CLI + server process tree on every path. */
async function serve(consumer) {
	const child = spawn(
		process.execPath,
		['node_modules/media-manager/bin/media-manager.js', '--no-open'],
		{ cwd: consumer, env: { ...env, HOST: '127.0.0.1' }, detached: true, stdio: 'pipe' }
	);
	const exited = once(child, 'exit');
	let output = '';
	child.stdout.on('data', (chunk) => (output += chunk));
	child.stderr.on('data', (chunk) => (output += chunk));
	try {
		const url = await new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`CLI startup timed out:\n${output}`)),
				30_000
			);
			const inspect = () => {
				const match = output.match(/Listening on (http:\/\/[^\s]+)/);
				if (match) {
					clearTimeout(timer);
					resolve(match[1]);
				}
			};
			child.stdout.on('data', inspect);
			child.once('error', (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child.once('exit', (code) => {
				clearTimeout(timer);
				reject(new Error(`CLI exited (${code}):\n${output}`));
			});
		});
		for (const route of ['/', '/files', '/api/files', '/api/classes']) {
			const response = await fetch(`${url}${route}`, { signal: AbortSignal.timeout(10_000) });
			const body = await response.text();
			assert.equal(response.status, 200, `${route}: ${body}\n${output}`);
			if (route.startsWith('/api/')) assert.ok(JSON.parse(body));
		}
		assert.doesNotMatch(output, /building once|vite build|Build failed/);
	} finally {
		if (child.exitCode === null && child.signalCode === null) {
			if (process.platform === 'win32') {
				spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
			} else {
				process.kill(-child.pid, 'SIGTERM');
			}
		}
		await exited;
	}
}

/** Check the actual consumer surface, without the source tree or any consumer dev dependencies. */
async function checkConsumer(consumer, source) {
	fs.mkdirSync(consumer);
	fs.writeFileSync(
		path.join(consumer, 'package.json'),
		JSON.stringify({ private: true, type: 'module' })
	);
	const npmMajor = Number(run(npm, ['--version'], consumer).split('.')[0]);
	// npm 12 requires explicit authorization for Git dependencies, including this local test snapshot.
	const gitFlags = npmMajor >= 12 && source.startsWith('git+') ? ['--allow-git=all'] : [];
	run(npm, ['install', '--omit=dev', '--no-audit', '--no-fund', ...gitFlags, source], consumer);
	const installed = path.join(consumer, 'node_modules/media-manager');
	for (const file of ['build/index.js', 'build/handler.js', 'build/server/index.js']) {
		assert.ok(fs.existsSync(path.join(installed, file)), `Missing ${file}`);
	}
	assert.ok(
		!fs.existsSync(path.join(installed, 'src')),
		'Consumer must exercise the files allowlist'
	);
	assert.ok(
		!fs.existsSync(path.join(consumer, 'node_modules/vite')),
		'Vite must not be needed at runtime'
	);
	const pkg = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
	for (const entry of Object.values(pkg.exports)) {
		if (!entry) continue;
		for (const file of typeof entry === 'string' ? [entry] : Object.values(entry)) {
			assert.ok(fs.existsSync(path.join(installed, file)), `Missing reader export ${file}`);
		}
	}
	fs.writeFileSync(
		path.join(consumer, 'reader-check.mjs'),
		`import assert from 'node:assert/strict';
import { MediaManager, SUPPORTED_MANIFEST_VERSION } from 'media-manager/reader';
import { MediaManager as ViteReader } from 'media-manager/reader/vite';
import 'media-manager/reader/posts-enhancer';
assert.equal(MediaManager, ViteReader);
assert.equal(MediaManager.fromParsed({ manifest: { version: SUPPORTED_MANIFEST_VERSION, files: {} } }).media().length, 0);
console.log('reader exports work');`
	);
	run(process.execPath, ['reader-check.mjs'], consumer);
	fs.cpSync(path.join(repo, 'test-fixtures'), path.join(consumer, 'workspace'), {
		recursive: true
	});
	fs.writeFileSync(path.join(consumer, 'media-manager.config.json'), '{"root":"./workspace"}\n');
	const doctor = run(
		process.execPath,
		['node_modules/media-manager/bin/media-manager.js', 'doctor'],
		consumer
	);
	assert.match(doctor, /build\s+present/);
	await serve(consumer);
}

test(
	'clean Git and packed installs ship a runnable editor and every reader export',
	{ timeout: 900_000 },
	async () => {
		const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-package-'));
		try {
			// Snapshot tracked source (plus new, nonignored files), never existing build/dist/node_modules.
			// A private local Git repo exercises npm's Git preparation without pushing or relying on GitHub.
			const source = path.join(scratch, 'source');
			fs.mkdirSync(source);
			const files = run(
				'git',
				['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
				repo
			).split('\0');
			for (const file of files.filter(Boolean)) {
				if (!fs.existsSync(path.join(repo, file))) continue;
				fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
				fs.copyFileSync(path.join(repo, file), path.join(source, file));
			}
			run('git', ['init', '-q'], source);
			run('git', ['add', '.'], source);
			run(
				'git',
				[
					'-c',
					'user.name=Packaging test',
					'-c',
					'user.email=packaging@example.invalid',
					'commit',
					'-qm',
					'Source snapshot'
				],
				source
			);

			console.log('Installing a clean Git dependency (no pre-existing editor or reader outputs)…');
			await checkConsumer(path.join(scratch, 'git-consumer'), `git+${pathToFileURL(source).href}`);

			console.log('Preparing a clean checkout, then packing with build/ and dist/ absent…');
			run(npm, ['ci', '--no-audit', '--no-fund'], source);
			fs.rmSync(path.join(source, 'build'), { recursive: true, force: true });
			fs.rmSync(path.join(source, 'dist'), { recursive: true, force: true });
			run(npm, ['pack', '--pack-destination', scratch], source);
			const tarball = fs.readdirSync(scratch).find((file) => file.endsWith('.tgz'));
			assert.ok(tarball, 'npm pack must produce a tarball');
			await checkConsumer(path.join(scratch, 'tarball-consumer'), path.join(scratch, tarball));
		} finally {
			fs.rmSync(scratch, { recursive: true, force: true });
		}
	}
);
