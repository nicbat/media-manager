import fs from 'node:fs';
import path from 'node:path';

import {
	getRootDir,
	getMediaDir,
	getClassesDir,
	getManifestPath,
	GLOBAL_FILES_DIR_NAME,
	RECORDS_DIR_NAME,
	GLOBALS_TYPE_ID
} from '$lib/storage/paths.js';

/**
 * Server-side glue for the storage-location UI (the counterpart to the {@link migrateBlobs} byte-move):
 * resolving/validating a destination, **persisting** the choice to `media-manager.config.json`, and
 * **applying** it live to the running server's env so no restart is needed.
 *
 * Source of truth is the config file — the same `assets` block the CLI reads at launch. The CLI passes
 * its resolved path via `MEDIA_MANAGER_CONFIG_PATH` in `serve()`; when that's absent (a bare `node build`
 * / dev run) we fall back to `<root>/media-manager.config.json`, so the UI works in every launch mode.
 * "No config yet" isn't a dead-end — the first save *creates* the file (root + assets), exactly what the
 * `config` CLI verb emits.
 */

const CONFIG_NAME = 'media-manager.config.json';

/** Absolute static-assets config the UI can set (null = classic in-workspace `media/files`). */
export interface AssetsConfig {
	/** Absolute destination directory for the blobs. */
	dir: string;
	/** Web-address prefix the reader uses to synthesize blob URLs. */
	baseUrl: string;
}

/**
 * The config file the storage UI reads/writes. Prefers the CLI-provided `MEDIA_MANAGER_CONFIG_PATH`
 * (which points at the actual config backing this session, even when launched from a different cwd),
 * else the conventional `<root>/media-manager.config.json`. Always returns a concrete path.
 */
export function getConfigPath(): string {
	const provided = process.env.MEDIA_MANAGER_CONFIG_PATH?.trim();
	return provided ? path.resolve(provided) : path.join(getRootDir(), CONFIG_NAME);
}

/** Does a config file already exist at {@link getConfigPath}? (false ⇒ first save will create it). */
export function configExists(): boolean {
	return fs.existsSync(getConfigPath());
}

/**
 * Can the storage change be persisted? True when the config file (if it exists) is writable, or — when
 * it doesn't yet exist — its parent directory is writable so it can be created. The only case this is
 * false is a genuinely read-only filesystem.
 */
export function configWritable(): boolean {
	const configPath = getConfigPath();
	try {
		if (fs.existsSync(configPath)) {
			fs.accessSync(configPath, fs.constants.W_OK);
		} else {
			fs.accessSync(path.dirname(configPath), fs.constants.W_OK);
		}
		return true;
	} catch {
		return false;
	}
}

/** POSIX, `./`-prefixed path from `fromDir` to `target` (portable config storage, matches the CLI). */
function toRel(fromDir: string, target: string): string {
	const rel = path.relative(fromDir, target) || '.';
	const posix = rel.split(path.sep).join('/');
	return posix.startsWith('.') ? posix : `./${posix}`;
}

/** The structural workspace folders a blob dir must never collide with (they hold JSON, not blobs). */
function forbiddenTargets(): string[] {
	const root = getRootDir();
	return [
		root,
		getMediaDir(),
		getClassesDir(),
		path.join(root, RECORDS_DIR_NAME),
		path.join(root, GLOBALS_TYPE_ID),
		path.dirname(getManifestPath())
	].map((p) => path.resolve(p));
}

/**
 * Validate a proposed static-assets destination. The move itself is manifest-authoritative (so it can't
 * corrupt unrelated files wherever it points), but pointing blobs *at* a structural JSON folder — or at
 * a parent of the workspace — is almost certainly a mistake, so we reject those up front.
 *
 * @throws With a user-facing message when the target is unsafe.
 */
function assertSaneTarget(toDir: string): void {
	const norm = path.resolve(toDir);
	// `<root>/media/files` (classic) is allowed; the other structural dirs are not.
	const classicFiles = path.join(getMediaDir(), GLOBAL_FILES_DIR_NAME);
	if (norm !== path.resolve(classicFiles)) {
		for (const f of forbiddenTargets()) {
			if (norm === f) throw new Error(`That folder is used by the workspace itself: ${toDir}`);
		}
	}
	if (getRootDir().startsWith(norm + path.sep)) {
		throw new Error(`That folder contains the workspace — pick a subfolder instead: ${toDir}`);
	}
	if (fs.existsSync(norm) && !fs.statSync(norm).isDirectory()) {
		throw new Error(`Not a directory: ${toDir}`);
	}
}

/**
 * Resolve a UI storage request into an absolute destination dir + the `assets` config to persist.
 *
 * - `classic` → blobs return to `<root>/media/files`; `assets` is null (block removed from config).
 * - `static` → `dir` (required) resolved **relative to the config file's dir**, like the CLI; `baseUrl`
 *   defaults to `/media`.
 *
 * @throws With a user-facing message on an invalid or unsafe request.
 */
export function resolveStorageTarget(input: {
	mode: 'static' | 'classic';
	dir?: string;
	baseUrl?: string;
}): { toDir: string; assets: AssetsConfig | null } {
	if (input.mode === 'classic') {
		return { toDir: path.join(getMediaDir(), GLOBAL_FILES_DIR_NAME), assets: null };
	}
	const raw = (input.dir ?? '').trim();
	if (!raw) throw new Error('A destination folder is required for static-assets mode.');
	const configDir = path.dirname(getConfigPath());
	const toDir = path.resolve(configDir, raw);
	assertSaneTarget(toDir);
	const baseUrl = (input.baseUrl ?? '').trim() || '/media';
	return { toDir, assets: { dir: toDir, baseUrl } };
}

/**
 * Persist the storage choice to the config file, creating it if absent. Preserves other keys and ensures
 * a valid `root` (stored relative to the config dir). `assets` null removes the block (classic mode).
 *
 * @returns The config path and whether it was newly created.
 */
export function persistStorageConfig(assets: AssetsConfig | null): {
	configPath: string;
	created: boolean;
} {
	const configPath = getConfigPath();
	const configDir = path.dirname(configPath);
	const existed = fs.existsSync(configPath);

	let doc: Record<string, unknown> = {};
	if (existed) {
		try {
			const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
			if (parsed && typeof parsed === 'object') doc = parsed as Record<string, unknown>;
		} catch {
			doc = {};
		}
	}
	if (typeof doc.root !== 'string' || (doc.root as string).trim() === '') {
		doc.root = toRel(configDir, getRootDir());
	}
	if (assets) {
		doc.assets = { dir: toRel(configDir, assets.dir), baseUrl: assets.baseUrl };
	} else {
		delete doc.assets;
	}

	fs.mkdirSync(configDir, { recursive: true });
	fs.writeFileSync(configPath, JSON.stringify(doc, null, 2) + '\n');
	return { configPath, created: !existed };
}

/**
 * Apply the storage choice to the **running** server's env. Because {@link getGlobalFilesDir} /
 * `isStaticAssetsMode` read these vars on every call, the very next request serves from the new folder —
 * no restart, no cache to bust.
 */
export function applyStorageEnv(assets: AssetsConfig | null): void {
	if (assets) {
		process.env.MEDIA_MANAGER_ASSETS_DIR = assets.dir;
		process.env.MEDIA_MANAGER_ASSETS_BASE_URL = assets.baseUrl;
	} else {
		delete process.env.MEDIA_MANAGER_ASSETS_DIR;
		delete process.env.MEDIA_MANAGER_ASSETS_BASE_URL;
	}
}
