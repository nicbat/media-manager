import path from 'node:path';
import * as fssync from 'node:fs';
import { readMediaTypeSettingsFileSync, type MediaTypeKind } from './settingsFile.js';

/**
 * On-disk layout (file-first classes + Item 18 records reorg):
 *
 *   <root>/
 *   ├─ settings.json        # app-wide UI prefs (grid size, nav, sort, verbose)
 *   ├─ media/
 *   │  ├─ manifest.json     # blob registry + derived membership index
 *   │  ├─ files/            # pure blob dir, any type
 *   │  ├─ classes/<id>.json # { schema, config, records } — source of truth per class
 *   │  └─ settings.json     # media-scoped: classOrder (dormant)
 *   ├─ globals/...          # the reserved `json` singleton — stays top-level
 *   └─ records/
 *      ├─ settings.json     # records-scoped: typeOrder (dormant)
 *      └─ <typeId>/...      # each `json`-kind record type (folder name = id)
 *
 * `media/` is the hub for **all blobs**; a *class* is an opt-in metadata table keyed by `file_id`.
 * `json`-kind record types live under `records/<typeId>/`; the reserved `globals` singleton stays at
 * `<root>/globals/`. The folder name **is** the id.
 */

/** Folder name under {@link getRootDir} that holds the whole media (blob + classes) subsystem. */
export const MEDIA_DIR_NAME = 'media' as const;
/** Folder name under {@link getMediaDir} where all blobs live. */
export const GLOBAL_FILES_DIR_NAME = 'files' as const;
/** Folder name under {@link getMediaDir} where per-class metadata files live. */
export const CLASSES_DIR_NAME = 'classes' as const;
/** Folder name under {@link getRootDir} that holds the `json`-kind record types (Item 18 reorg). */
export const RECORDS_DIR_NAME = 'records' as const;
/** Folder name under {@link getRootDir} that holds the markdown Posts sub-app (Item 14). */
export const POSTS_DIR_NAME = 'posts' as const;
/** The reserved `json` singleton's typeId. It stays top-level at `<root>/globals/`, not under `records/`. */
export const GLOBALS_TYPE_ID = 'globals' as const;

/**
 * Resolve the root directory for the workspace (env `MEDIA_MANAGER_ROOT`).
 *
 * Use case:
 * - Single source of truth for "where is the data root".
 */
export function getRootDir(): string {
	const configured = process.env.MEDIA_MANAGER_ROOT?.trim();
	// Fallback for build: vite build loads server modules but doesn't run them.
	return configured
		? path.resolve(configured)
		: path.resolve(process.cwd(), '.media-manager-build');
}

/** Absolute path to the media subsystem root (`<root>/media`). */
export function getMediaDir(): string {
	return path.join(getRootDir(), MEDIA_DIR_NAME);
}

/** Absolute path to the global blob directory (`<root>/media/files`). */
export function getGlobalFilesDir(): string {
	return path.join(getMediaDir(), GLOBAL_FILES_DIR_NAME);
}

/** Absolute path to the global blob manifest (`<root>/media/manifest.json`). */
export function getManifestPath(): string {
	return path.join(getMediaDir(), 'manifest.json');
}

/**
 * Absolute path to the Google Photos integration config (`<root>/media/google.json`).
 *
 * Holds the user's bring-your-own OAuth client id/secret + refresh token (Item 37). Written `0600`,
 * **never committed, never seeded into `test-fixtures/`** — it is a per-workspace secret.
 */
export function getGoogleConfigPath(): string {
	return path.join(getMediaDir(), 'google.json');
}

/** Absolute path to the classes directory (`<root>/media/classes`). */
export function getClassesDir(): string {
	return path.join(getMediaDir(), CLASSES_DIR_NAME);
}

/** Absolute path to a single class file (`<root>/media/classes/<id>.json`). */
export function getClassFilePath(classId: string): string {
	return path.join(getClassesDir(), `${classId}.json`);
}

/**
 * Absolute path to the **app-wide** settings file (`<root>/settings.json`).
 *
 * Holds UI preferences shared by every view (grid size, navigation, sort, verbose grid). Hoisted
 * out of the misnamed `media/settings.json` (Item 18) — that file now holds only the media-scoped
 * `classOrder`.
 */
export function getAppSettingsPath(): string {
	return path.join(getRootDir(), 'settings.json');
}

/**
 * Absolute path to the media-scoped settings file (`<root>/media/settings.json`).
 *
 * After the Item 18 reorg this holds **only** `classOrder` (the dormant cross-class ordering). App-wide
 * prefs live in {@link getAppSettingsPath}. Used by the migration + old-layout guard.
 */
export function getMediaSettingsPath(): string {
	return path.join(getMediaDir(), 'settings.json');
}

/** Absolute path to the records-scoped settings file (`<root>/records/settings.json`). */
export function getRecordsSettingsPath(): string {
	return path.join(getRootDir(), RECORDS_DIR_NAME, 'settings.json');
}

/**
 * List the ids (filename stems) of every class under `<root>/media/classes`.
 *
 * @returns Class ids in no guaranteed order (empty when the dir is absent).
 */
export function listClassIds(): string[] {
	let entries: fssync.Dirent[];
	try {
		entries = fssync.readdirSync(getClassesDir(), { withFileTypes: true });
	} catch (err) {
		const e = err as NodeJS.ErrnoException;
		if (e.code === 'ENOENT') return [];
		throw e;
	}
	return entries
		.filter((e) => e.isFile() && e.name.endsWith('.json') && !e.name.endsWith('.lock'))
		.map((e) => e.name.slice(0, -'.json'.length));
}

/**
 * Paths for a single `json`-kind media-type folder (the records side; classes use class paths).
 */
export interface MediaTypePaths {
	rootDir: string;
	baseDir: string;
	settingsPath: string;
	dataPath: string;
	kind: MediaTypeKind;
}

/**
 * Resolve the base directory for a `json`-kind media type (Item 18 reorg).
 *
 * Record types live under `<root>/records/<typeId>/`; the reserved {@link GLOBALS_TYPE_ID} singleton
 * stays top-level at `<root>/globals/`. This is the single place that encodes that asymmetry — every
 * other helper resolves through it.
 *
 * @param typeId - The media type id (folder name).
 */
export function getMediaTypeBaseDir(typeId: string): string {
	if (typeId === GLOBALS_TYPE_ID) return path.join(getRootDir(), GLOBALS_TYPE_ID);
	return path.join(getRootDir(), RECORDS_DIR_NAME, typeId);
}

/**
 * Get filesystem paths for a `json`-kind media type (by folder name / typeId).
 *
 * @param typeId - Media type id (e.g. 'notes', 'globals')
 * @returns Paths object; throws if folder is not a valid media-type folder
 */
export function getMediaTypePaths(typeId: string): MediaTypePaths {
	const rootDir = getRootDir();
	const baseDir = getMediaTypeBaseDir(typeId);
	const settingsPath = path.join(baseDir, 'settings.json');
	const settings = readMediaTypeSettingsFileSync(baseDir);
	if (!settings) {
		throw new Error(`Not a valid media-type folder: ${typeId}`);
	}
	// Data file is always `data.json` (the configurable `dataFileName` was dropped in Item 18).
	const dataPath = path.join(baseDir, 'data.json');
	return { rootDir, baseDir, settingsPath, dataPath, kind: settings.kind };
}

/**
 * List typeIds of all valid `json`-kind media types (Item 18 reorg).
 *
 * Scans `<root>/records/` for type subfolders, then folds in the reserved top-level
 * {@link GLOBALS_TYPE_ID} singleton if present. A folder is a type iff it carries a valid
 * media-type `settings.json`.
 *
 * @returns Array of typeIds (folder names), in no guaranteed order
 */
export function listMediaTypeIds(): string[] {
	const typeIds: string[] = [];
	const recordsDir = path.join(getRootDir(), RECORDS_DIR_NAME);
	let entries: fssync.Dirent[] = [];
	try {
		entries = fssync.readdirSync(recordsDir, { withFileTypes: true });
	} catch (err) {
		const e = err as NodeJS.ErrnoException;
		if (e.code !== 'ENOENT') throw e;
	}
	for (const ent of entries) {
		if (!ent.isDirectory()) continue;
		if (readMediaTypeSettingsFileSync(path.join(recordsDir, ent.name))) typeIds.push(ent.name);
	}
	// Fold in the reserved top-level globals singleton (it never lives under records/).
	if (readMediaTypeSettingsFileSync(getMediaTypeBaseDir(GLOBALS_TYPE_ID))) {
		typeIds.push(GLOBALS_TYPE_ID);
	}
	return typeIds;
}

/* ------------------------------------------------------------------------------------------------ *
 * Posts sub-app (Item 14) — markdown posts under `<root>/posts/<collection>/<slug>.md`.
 *
 * Structurally the records-side mirror: `posts/` is the hub, each **collection** is a folder holding
 * `.md` files (one per post; the filename stem **is** the slug), and `posts/settings.json` is the
 * collection registry (order + per-collection typed frontmatter hints). Unlike record types there is
 * no per-collection `settings.json` — a collection is just a directory of `.md` files; all collection
 * metadata lives centrally in `posts/settings.json`.
 * ------------------------------------------------------------------------------------------------ */

/** Absolute path to the Posts sub-app root (`<root>/posts`). */
export function getPostsDir(): string {
	return path.join(getRootDir(), POSTS_DIR_NAME);
}

/** Absolute path to the Posts collection registry (`<root>/posts/settings.json`). */
export function getPostsSettingsPath(): string {
	return path.join(getPostsDir(), 'settings.json');
}

/** Absolute path to a single collection's directory (`<root>/posts/<collection>`). */
export function getPostCollectionDir(collection: string): string {
	return path.join(getPostsDir(), collection);
}

/** Absolute path to a single post file (`<root>/posts/<collection>/<slug>.md`). */
export function getPostFilePath(collection: string, slug: string): string {
	return path.join(getPostCollectionDir(collection), `${slug}.md`);
}

/**
 * List the ids (folder names) of every post collection under `<root>/posts`.
 *
 * A collection is any subdirectory of `posts/` (the flat `settings.json` file is skipped). Mirrors
 * {@link listMediaTypeIds} but keyed off directory presence rather than a per-folder settings file.
 *
 * @returns Collection ids in no guaranteed order (empty when `posts/` is absent).
 */
export function listPostCollectionIds(): string[] {
	let entries: fssync.Dirent[] = [];
	try {
		entries = fssync.readdirSync(getPostsDir(), { withFileTypes: true });
	} catch (err) {
		const e = err as NodeJS.ErrnoException;
		if (e.code === 'ENOENT') return [];
		throw e;
	}
	return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

/**
 * List the slugs (filename stems) of every `.md` post in a collection.
 *
 * @param collection - The collection id (folder name).
 * @returns Slugs in no guaranteed order (empty when the collection dir is absent).
 */
export function listPostSlugs(collection: string): string[] {
	let entries: fssync.Dirent[] = [];
	try {
		entries = fssync.readdirSync(getPostCollectionDir(collection), { withFileTypes: true });
	} catch (err) {
		const e = err as NodeJS.ErrnoException;
		if (e.code === 'ENOENT') return [];
		throw e;
	}
	return entries
		.filter((e) => e.isFile() && e.name.endsWith('.md') && !e.name.endsWith('.lock'))
		.map((e) => e.name.slice(0, -'.md'.length));
}
