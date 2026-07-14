#!/usr/bin/env node
/**
 * Data folder upgrade / diagnostic tool for a media-manager root (MEDIA_MANAGER_ROOT).
 *
 * Scans every media-type folder under the given root and reports (and optionally applies)
 * the upgrades the current codebase expects:
 *
 *   1. `files/` group   → must be `kind: blob_store` (legacy auto-created group was `generic`).
 *   2. `globals/` group → must be `kind: json` with exactly ONE record whose id is the canonical
 *                         globals UUID (legacy ids such as `global-settings` are migrated).
 *   3. Shared blob store → all file-backed kinds (`images`, `generic`, `blob_store`) now read their
 *                         binaries from the single global `<root>/files/` directory. Blobs still
 *                         sitting in legacy per-type locations (an images type's `files/` subdir, or a
 *                         generic type's folder root) are relocated into `<root>/files/`. Basenames are
 *                         preserved so existing catalog `file_name` references keep resolving; files
 *                         whose name already exists in the global store (with different content) are
 *                         reported as conflicts and skipped.
 *   4. Stable file ids   → every blob in `<root>/files/` is registered in a global manifest
 *                         (`<root>/files/manifest.json`) with a UUID. File-backed catalog rows are
 *                         rekeyed to `{ id: <manifest id>, ... }` (the filename now lives only in the
 *                         manifest); `file`-typed schema field values and `settings.excludedFiles` are
 *                         migrated from filenames to ids. Handles both the original `{ id, file_name }`
 *                         layout and the interim `{ file_id }` layout. Idempotent and re-runnable; runs
 *                         after the blob relocation above so the manifest is built from the final store.
 *
 * Usage:
 *   node scripts/upgrade-data.mjs <root>           # dry run: report only (no writes)
 *   node scripts/upgrade-data.mjs <root> --apply   # perform the upgrades
 *   MEDIA_MANAGER_ROOT=/path node scripts/upgrade-data.mjs --apply
 *
 * Exit codes: 0 = ok (or fixes applied), 1 = pending upgrades found in dry-run, 2 = usage/IO error.
 *
 * Concerns / future improvements:
 * - This is intentionally dependency-free (plain Node) so it can run without building the app.
 * - It duplicates a couple of constants from `src/lib/storage` (kept in sync manually).
 * - Conflict resolution for relocation is conservative (skip + report); it never clobbers or
 *   silently renames, since renaming would require rewriting catalog `file_name` references.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Canonical globals singleton record id (mirrors GLOBALS_RECORD_ID in src/lib/storage/mediaTypes.ts). */
const GLOBALS_RECORD_ID = '00000000-0000-4000-8000-000000000001';
/** Folder name of the shared global blob store (mirrors GLOBAL_FILES_DIR_NAME in src/lib/storage/paths.ts). */
const GLOBAL_FILES_DIR_NAME = 'files';
/** Default per-type subfolder that legacy `images` types used for their blobs. */
const DEFAULT_FILES_SUBDIR = 'files';
/** Files that live in a type folder but are not blobs (never relocated). */
const NON_BLOB_NAMES = new Set(['settings.json', 'data.json', 'image-data.json', 'schema.json']);

/** ANSI color helpers for readable output (no-op when not a TTY). */
const useColor = process.stdout.isTTY;
const c = {
	bold: (s) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
	red: (s) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
	green: (s) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
	yellow: (s) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
	cyan: (s) => (useColor ? `\x1b[36m${s}\x1b[0m` : s),
	dim: (s) => (useColor ? `\x1b[2m${s}\x1b[0m` : s)
};

/**
 * Read and parse a JSON file, returning null on missing/invalid.
 * @param {string} filePath - Absolute path to the JSON file
 * @returns {any|null} Parsed value or null
 */
function readJsonSafe(filePath) {
	try {
		return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
	} catch {
		return null;
	}
}

/**
 * Write JSON to a file atomically (temp file + rename).
 * @param {string} filePath - Destination path
 * @param {any} value - JSON-serializable value
 */
function writeJsonAtomic(filePath, value) {
	const tmp = `${filePath}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
	fs.renameSync(tmp, filePath);
}

/**
 * Whether two files have identical content (size check first, then byte compare).
 * @param {string} a - First file path
 * @param {string} b - Second file path
 * @returns {boolean} true if both exist and are byte-identical
 */
function filesEqual(a, b) {
	try {
		const sa = fs.statSync(a);
		const sb = fs.statSync(b);
		if (sa.size !== sb.size) return false;
		return fs.readFileSync(a).equals(fs.readFileSync(b));
	} catch {
		return false;
	}
}

/**
 * List immediate files (not directories, not hidden) in a directory.
 * @param {string} dir - Directory to list
 * @returns {string[]} File basenames
 */
function listFiles(dir) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((e) => e.isFile() && !e.name.startsWith('.') && !e.name.endsWith('.lock'))
		.map((e) => e.name);
}

/**
 * Read a media-type settings.json, returning its parsed form or null when it is not a media type.
 * @param {string} baseDir - Media-type folder
 * @returns {{displayName?: string, kind: string, schema?: object, dataFileName?: string, filesSubdir?: string}|null}
 */
function readSettings(baseDir) {
	const settings = readJsonSafe(path.join(baseDir, 'settings.json'));
	if (!settings || typeof settings !== 'object') return null;
	const kind = settings.kind;
	if (kind !== 'images' && kind !== 'json' && kind !== 'generic' && kind !== 'blob_store')
		return null;
	return settings;
}

// ---- main ----------------------------------------------------------------

const rawArgs = process.argv.slice(2);
const apply = rawArgs.includes('--apply');
const rootArg = rawArgs.find((a) => !a.startsWith('--'));
const root = path.resolve(rootArg || process.env.MEDIA_MANAGER_ROOT || '');

if (!rootArg && !process.env.MEDIA_MANAGER_ROOT) {
	console.error(c.red('Error: no data root given.'));
	console.error('Usage: node scripts/upgrade-data.mjs <root> [--apply]');
	console.error('   or: MEDIA_MANAGER_ROOT=/path node scripts/upgrade-data.mjs [--apply]');
	process.exit(2);
}
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
	console.error(c.red(`Error: root is not a directory: ${root}`));
	process.exit(2);
}

console.log(
	c.bold(
		`\nmedia-manager data upgrade — ${apply ? c.yellow('APPLY mode') : c.cyan('dry run (report only)')}`
	)
);
console.log(c.dim(`root: ${root}\n`));

const globalFilesDir = path.join(root, GLOBAL_FILES_DIR_NAME);

/** Accumulated planned/performed actions, grouped for the summary. */
const planned = [];
/** Conflicts (need manual attention), never auto-resolved. */
const conflicts = [];
/** Informational notes. */
const notes = [];

/** Record a planned action. @param {string} msg @param {() => void} [fix] */
function plan(msg, fix) {
	planned.push({ msg, fix });
}

// Discover media-type folders.
const typeDirs = fs
	.readdirSync(root, { withFileTypes: true })
	.filter((e) => e.isDirectory())
	.map((e) => e.name)
	.filter((name) => readSettings(path.join(root, name)) !== null)
	.sort();

console.log(c.bold('Discovered media types:'));
for (const id of typeDirs) {
	const s = readSettings(path.join(root, id));
	console.log(`  ${c.cyan(id.padEnd(20))} ${c.dim(s.kind)}`);
}
console.log('');

// --- Check 1: files/ group must be blob_store ---
{
	const baseDir = path.join(root, GLOBAL_FILES_DIR_NAME);
	const s = readSettings(baseDir);
	if (!s) {
		notes.push(
			`No "${GLOBAL_FILES_DIR_NAME}" group yet — it is auto-created as blob_store on first app load.`
		);
	} else if (s.kind === 'generic' || s.kind === 'images') {
		plan(`Upgrade "${GLOBAL_FILES_DIR_NAME}" group: kind ${s.kind} → blob_store`, () => {
			const next = { ...s, kind: 'blob_store', displayName: s.displayName ?? 'Files', schema: {} };
			// blob_store does not use a per-type files subdir.
			delete next.filesSubdir;
			writeJsonAtomic(path.join(baseDir, 'settings.json'), next);
		});
	} else if (s.kind !== 'blob_store') {
		conflicts.push(
			`"${GLOBAL_FILES_DIR_NAME}" group has unexpected kind "${s.kind}" (expected blob_store).`
		);
	}
}

// --- Check 2: globals/ group heal ---
{
	const baseDir = path.join(root, 'globals');
	const settingsPath = path.join(baseDir, 'settings.json');
	const dataPath = path.join(baseDir, 'data.json');
	const s = readSettings(baseDir);
	if (!s) {
		notes.push('No "globals" group yet — it is auto-created/healed when the app loads it.');
	} else {
		if (s.kind !== 'json') {
			plan(`Fix "globals" group kind: ${s.kind} → json`, () => {
				writeJsonAtomic(settingsPath, {
					...s,
					kind: 'json',
					displayName: s.displayName ?? 'Globals',
					schema: {}
				});
			});
		}
		const data = readJsonSafe(dataPath);
		const records = data && Array.isArray(data.records) ? data.records : [];
		const canonical =
			records.find((r) => r && typeof r === 'object' && r.id === GLOBALS_RECORD_ID) ??
			(records[0] && typeof records[0] === 'object' ? records[0] : null);
		const needsHeal = records.length !== 1 || !records[0] || records[0].id !== GLOBALS_RECORD_ID;
		if (needsHeal) {
			const legacyId =
				canonical && canonical.id && canonical.id !== GLOBALS_RECORD_ID ? canonical.id : null;
			const detail =
				records.length === 0
					? 'create singleton record'
					: records.length > 1
						? `collapse ${records.length} records → 1 singleton`
						: legacyId
							? `migrate record id "${legacyId}" → canonical UUID`
							: 'normalize singleton record id';
			plan(`Heal "globals" data: ${detail}`, () => {
				const healed = {
					...(canonical ?? {}),
					id: GLOBALS_RECORD_ID,
					name:
						canonical && typeof canonical.name === 'string' && canonical.name.trim()
							? canonical.name
							: 'Global Settings'
				};
				writeJsonAtomic(dataPath, { records: [healed] });
			});
		}
	}
}

// --- Check 3: relocate blobs into the shared global files/ dir ---
/**
 * Plan relocation of one blob into the global files store.
 * @param {string} typeId - Owning media type (for messages)
 * @param {string} srcPath - Current absolute file path
 * @param {string} name - Basename (preserved at destination)
 */
function planRelocate(typeId, srcPath, name) {
	const destPath = path.join(globalFilesDir, name);
	if (fs.existsSync(destPath)) {
		if (filesEqual(srcPath, destPath)) {
			plan(`[${typeId}] duplicate blob already in files/: remove ${c.dim(srcPath)}`, () => {
				fs.rmSync(srcPath);
			});
		} else {
			conflicts.push(
				`[${typeId}] "${name}" exists in files/ with different content — left in place: ${srcPath}`
			);
		}
		return;
	}
	plan(`[${typeId}] move blob → files/${name} ${c.dim(`(from ${srcPath})`)}`, () => {
		fs.mkdirSync(globalFilesDir, { recursive: true });
		try {
			fs.renameSync(srcPath, destPath);
		} catch {
			// Cross-device fallback: copy then unlink.
			fs.copyFileSync(srcPath, destPath);
			fs.rmSync(srcPath);
		}
	});
}

for (const id of typeDirs) {
	const baseDir = path.join(root, id);
	const s = readSettings(baseDir);
	if (!s) continue;

	if (id === GLOBAL_FILES_DIR_NAME) {
		// The blob store itself: its root files are already in the destination. But a legacy
		// images-kind files group may have stored blobs in a nested <files>/<filesSubdir>/ dir —
		// pull those up into <root>/files/.
		if (s.kind === 'images') {
			const subdir = path.join(baseDir, s.filesSubdir || DEFAULT_FILES_SUBDIR);
			if (fs.existsSync(subdir) && path.resolve(subdir) !== path.resolve(globalFilesDir)) {
				for (const name of listFiles(subdir)) planRelocate(id, path.join(subdir, name), name);
				plan(`[${id}] remove empty legacy files subdir ${c.dim(subdir)}`, () => {
					try {
						if (fs.readdirSync(subdir).length === 0) fs.rmdirSync(subdir);
					} catch {
						/* ignore */
					}
				});
			}
		}
		continue;
	}

	if (s.kind === 'images') {
		// Legacy images stored blobs in <type>/<filesSubdir>/.
		const subdir = path.join(baseDir, s.filesSubdir || DEFAULT_FILES_SUBDIR);
		if (fs.existsSync(subdir) && subdir !== globalFilesDir) {
			for (const name of listFiles(subdir)) planRelocate(id, path.join(subdir, name), name);
			// Remove the now-empty legacy subdir on apply.
			plan(`[${id}] remove empty legacy files subdir ${c.dim(subdir)}`, () => {
				try {
					if (fs.readdirSync(subdir).length === 0) fs.rmdirSync(subdir);
				} catch {
					/* ignore */
				}
			});
		}
	} else if (s.kind === 'generic') {
		// Legacy generic stored blobs in the type folder root.
		for (const name of listFiles(baseDir)) {
			if (NON_BLOB_NAMES.has(name)) continue;
			planRelocate(id, path.join(baseDir, name), name);
		}
	}
}

// --- Check 4: stable file ids (manifest + file_id rekey) ---
/** Matches a canonical UUID (so we can tell an already-migrated value from a filename). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s) => typeof s === 'string' && UUID_RE.test(s);

/** Default data filename for a media type (mirrors settingsFile.ts defaults). */
function dataFileFor(s) {
	if (s.dataFileName) return s.dataFileName;
	return s.kind === 'images' || s.kind === 'blob_store' ? 'image-data.json' : 'data.json';
}

/** Schema field keys whose type is `file` (their values are blob references to migrate). */
function fileFieldKeys(s) {
	const schema = s.schema && typeof s.schema === 'object' ? s.schema : {};
	return Object.entries(schema)
		.filter(([, d]) => d && typeof d === 'object' && d.type === 'file')
		.map(([k]) => k);
}

{
	// Detect whether anything needs migrating (independent of where blobs currently sit on disk).
	let rowsToRekey = 0;
	let fileFieldsToMigrate = 0;
	let excludedToMigrate = 0;
	let fileBackedRowCount = 0;

	for (const id of typeDirs) {
		const baseDir = path.join(root, id);
		const s = readSettings(baseDir);
		if (!s) continue;
		const fileBacked = s.kind === 'images' || s.kind === 'generic' || s.kind === 'blob_store';
		const data = readJsonSafe(path.join(baseDir, dataFileFor(s)));
		const rows =
			data && Array.isArray(data.images)
				? data.images
				: data && Array.isArray(data.records)
					? data.records
					: [];
		const ffKeys = fileFieldKeys(s);
		for (const rec of rows) {
			if (!rec || typeof rec !== 'object') continue;
			if (fileBacked) {
				fileBackedRowCount++;
				// Needs rekey if it carries a filename (legacy) or a `file_id` (interim layout).
				if (typeof rec.file_name === 'string' || typeof rec.file_id === 'string') rowsToRekey++;
			}
			for (const k of ffKeys) {
				if (typeof rec[k] === 'string' && rec[k] && !isUuid(rec[k])) fileFieldsToMigrate++;
			}
		}
		if (Array.isArray(s.excludedFiles)) {
			for (const e of s.excludedFiles) if (!isUuid(e)) excludedToMigrate++;
		}
	}

	const manifestPath = path.join(globalFilesDir, 'manifest.json');
	const manifestMissing = !fs.existsSync(manifestPath);
	const blobsExist = listFiles(globalFilesDir).some(
		(n) => n !== 'manifest.json' && !NON_BLOB_NAMES.has(n)
	);

	const needsMigration =
		rowsToRekey > 0 ||
		fileFieldsToMigrate > 0 ||
		excludedToMigrate > 0 ||
		(manifestMissing && (blobsExist || fileBackedRowCount > 0));

	if (needsMigration) {
		const detailParts = [];
		if (manifestMissing) detailParts.push('build manifest.json');
		if (rowsToRekey > 0) detailParts.push(`rekey ${rowsToRekey} row(s) → id`);
		if (fileFieldsToMigrate > 0)
			detailParts.push(`migrate ${fileFieldsToMigrate} file-field value(s)`);
		if (excludedToMigrate > 0)
			detailParts.push(`migrate ${excludedToMigrate} excluded entr(y/ies)`);
		plan(`Stable file ids: ${detailParts.join(', ')}`, () => {
			fs.mkdirSync(globalFilesDir, { recursive: true });

			// 1. Build (or extend) the manifest from blobs currently in the global store.
			const manifest =
				readJsonSafe(manifestPath) && typeof readJsonSafe(manifestPath) === 'object'
					? readJsonSafe(manifestPath)
					: { version: 1, files: {} };
			if (!manifest.files || typeof manifest.files !== 'object') manifest.files = {};
			manifest.version = 1;
			const nameToId = new Map();
			for (const [fid, entry] of Object.entries(manifest.files)) {
				if (entry && typeof entry.file_name === 'string') nameToId.set(entry.file_name, fid);
			}
			const mint = (name) => {
				if (nameToId.has(name)) return nameToId.get(name);
				const fid = randomUUID();
				manifest.files[fid] = { file_name: name, created_at: new Date().toISOString() };
				nameToId.set(name, fid);
				return fid;
			};
			for (const name of listFiles(globalFilesDir)) {
				if (name === 'manifest.json' || NON_BLOB_NAMES.has(name)) continue;
				mint(name);
			}

			// 2-4. Rewrite each media type's rows / file-field values / excluded list.
			for (const id of typeDirs) {
				const baseDir = path.join(root, id);
				const s = readSettings(baseDir);
				if (!s) continue;
				const fileBacked = s.kind === 'images' || s.kind === 'generic' || s.kind === 'blob_store';
				const ffKeys = fileFieldKeys(s);
				const dataPath = path.join(baseDir, dataFileFor(s));
				const data = readJsonSafe(dataPath);

				const rewriteFileFields = (rec) => {
					let did = false;
					for (const k of ffKeys) {
						const v = rec[k];
						if (typeof v === 'string' && v && !isUuid(v)) {
							rec[k] = mint(v);
							did = true;
						}
					}
					return did;
				};

				if (data && fileBacked && Array.isArray(data.images)) {
					let changed = false;
					const kept = [];
					for (const rec of data.images) {
						if (!rec || typeof rec !== 'object') continue;
						// Resolve the row's manifest `id` from whichever layout it is in:
						//  - interim: a `file_id` value is already the manifest id → adopt it as `id`.
						//  - legacy: a `file_name` → mint/look up the manifest id (overwriting any old
						//    per-row random `id`, which was a workaround that predates the manifest).
						if (typeof rec.file_id === 'string' && rec.file_id) {
							rec.id = rec.file_id;
							changed = true;
						} else if (typeof rec.file_name === 'string' && rec.file_name) {
							// Mint an entry even when the blob is missing, so the row keeps a stable id.
							rec.id = mint(rec.file_name);
							changed = true;
						} else if (typeof rec.id !== 'string' || !rec.id) {
							conflicts.push(`[${id}] dropped a row with no id, file_id, or file_name.`);
							changed = true;
							continue;
						}
						if ('file_id' in rec) {
							delete rec.file_id;
							changed = true;
						}
						if ('file_name' in rec) {
							delete rec.file_name;
							changed = true;
						}
						if (rewriteFileFields(rec)) changed = true;
						kept.push(rec);
					}
					if (changed) writeJsonAtomic(dataPath, { ...data, images: kept });
				} else if (data && s.kind === 'json' && Array.isArray(data.records)) {
					let changed = false;
					for (const rec of data.records) {
						if (rec && typeof rec === 'object' && rewriteFileFields(rec)) changed = true;
					}
					if (changed) writeJsonAtomic(dataPath, data);
				}

				// Migrate settings.excludedFiles (filenames → file_ids; drop unresolved).
				if (Array.isArray(s.excludedFiles) && s.excludedFiles.length > 0) {
					const migrated = [];
					let exChanged = false;
					for (const e of s.excludedFiles) {
						if (isUuid(e)) {
							migrated.push(e);
							continue;
						}
						exChanged = true;
						const mapped = nameToId.get(e);
						if (mapped) migrated.push(mapped);
						else conflicts.push(`[${id}] dropped excluded entry "${e}" (no matching blob).`);
					}
					if (exChanged) {
						writeJsonAtomic(path.join(baseDir, 'settings.json'), { ...s, excludedFiles: migrated });
					}
				}
			}

			// Persist the manifest last (it may have gained entries from file-field / row minting).
			writeJsonAtomic(manifestPath, manifest);
		});
	} else if (manifestMissing && !blobsExist && fileBackedRowCount === 0) {
		notes.push('No blobs yet — the manifest is created on first upload / app load.');
	}
}

// --- Step 5: file-first classes reorg (move to <root>/media/, type folders → classes) ---
// Runs after the id-keying step above so it consumes the final file-id manifest layout. Idempotent:
// skipped once <root>/media/classes exists.
(function planMediaReorg() {
	const mediaDir = path.join(root, 'media');
	const mediaClassesDir = path.join(mediaDir, 'classes');
	const mediaFilesDir = path.join(mediaDir, 'files');
	const oldFilesDir = path.join(root, GLOBAL_FILES_DIR_NAME);
	const oldManifestPath = path.join(oldFilesDir, 'manifest.json');

	if (fs.existsSync(mediaClassesDir)) return; // already on the file-first layout

	// Only real catalogs become classes. The reserved `blob_store` (the global files dir itself) is the
	// hub and dissolves — its folder is the old store, removed below.
	const fileBackedTypes = typeDirs.filter((id) => {
		const s = readSettings(path.join(root, id));
		return s && (s.kind === 'images' || s.kind === 'generic');
	});
	const hasOldStore = fs.existsSync(oldManifestPath) || fs.existsSync(oldFilesDir);
	if (fileBackedTypes.length === 0 && !hasOldStore) return; // nothing file-backed to reorg

	plan(
		`reorganize to file-first layout: move files/ → media/files/, ${fileBackedTypes.length} catalog(s) → media/classes/*.json`,
		() => {
			fs.mkdirSync(mediaFilesDir, { recursive: true });
			fs.mkdirSync(mediaClassesDir, { recursive: true });

			// 1. Move blobs into media/files/ (skip manifest/settings/data files/locks — they are
			// bookkeeping, not blobs, and would otherwise be picked up as files).
			if (fs.existsSync(oldFilesDir)) {
				for (const name of fs.readdirSync(oldFilesDir)) {
					if (name === 'manifest.json' || NON_BLOB_NAMES.has(name) || name.endsWith('.lock'))
						continue;
					fs.renameSync(path.join(oldFilesDir, name), path.join(mediaFilesDir, name));
				}
			}

			// 2. Seed the v2 manifest from the old one (or empty).
			const old = readJsonSafe(oldManifestPath) || { files: {} };
			const manifest = { version: 2, files: {} };
			for (const [fid, entry] of Object.entries(old.files || {})) {
				manifest.files[fid] = {
					file_name: entry.file_name,
					classes: [],
					missing: false,
					...(entry.size != null ? { size: entry.size } : {}),
					...(entry.created_at ? { created_at: entry.created_at } : {})
				};
			}

			// 3. Convert each file-backed type folder into a class file + membership index.
			for (const id of fileBackedTypes) {
				const baseDir = path.join(root, id);
				const s = readSettings(baseDir);
				const schema = s.schema && typeof s.schema === 'object' ? s.schema : {};
				const data = readJsonSafe(path.join(baseDir, dataFileFor(s)));
				const rows = data && Array.isArray(data.images) ? data.images : [];
				const records = {};
				for (const rec of rows) {
					if (!rec || typeof rec !== 'object' || typeof rec.id !== 'string') continue;
					const { image_name, file_name, file_id, ...rest } = rec; // drop legacy/built-in keys
					void image_name;
					void file_name;
					void file_id;
					records[rec.id] = rest;
					if (manifest.files[rec.id]) {
						const set = new Set(manifest.files[rec.id].classes);
						set.add(id);
						manifest.files[rec.id].classes = [...set].sort();
					}
				}
				const displayField = Object.keys(schema).find((k) => schema[k]?.type === 'string');
				writeJsonAtomic(path.join(mediaClassesDir, `${id}.json`), {
					schema,
					config: { displayName: s.displayName || id, ...(displayField ? { displayField } : {}) },
					records
				});
				fs.rmSync(baseDir, { recursive: true, force: true });
			}

			// 4. Persist manifest + media settings, then drop the old store. `media/settings.json` holds
			// only the media-scoped classOrder (Item 18 — app-wide prefs live in <root>/settings.json).
			writeJsonAtomic(path.join(mediaDir, 'manifest.json'), manifest);
			if (!fs.existsSync(path.join(mediaDir, 'settings.json'))) {
				writeJsonAtomic(path.join(mediaDir, 'settings.json'), { classOrder: fileBackedTypes });
			}
			fs.rmSync(oldFilesDir, { recursive: true, force: true });
		}
	);
})();

// --- Step 6: records reorg + settings split (Item 18) ---
// Move top-level `json` record types under `records/`, hoist app-wide prefs from the misnamed
// `media/settings.json` to `<root>/settings.json`, strip the dead `dataFileName`, and create
// `records/settings.json`. The reserved `globals` singleton stays top-level. Idempotent: each
// sub-action is planned only while still needed, so a second run is a no-op.
(function planRecordsReorg() {
	const RECORDS_DIR = 'records';
	const APP_KEYS = [
		'gridSize',
		'autoAdvanceToNextUnlinked',
		'autoSaveOnAdvance',
		'railCollapsed',
		'sortField',
		'sortDir',
		'verbose',
		'verboseFields'
	];
	const recordsDir = path.join(root, RECORDS_DIR);

	/** Remove the dead `dataFileName` key from a type settings.json, if present. */
	const stripDataFileName = (settingsPath) => {
		const s = readJsonSafe(settingsPath);
		if (s && typeof s === 'object' && 'dataFileName' in s) {
			delete s.dataFileName;
			writeJsonAtomic(settingsPath, s);
		}
	};

	/** Move a directory, falling back to copy+remove across devices. */
	const moveDir = (src, dest) => {
		try {
			fs.renameSync(src, dest);
		} catch {
			fs.cpSync(src, dest, { recursive: true });
			fs.rmSync(src, { recursive: true, force: true });
		}
	};

	// Top-level `json` record types to relocate (globals stays top-level; media/ is the hub).
	const topLevelTypes = typeDirs.filter(
		(id) => id !== 'globals' && readSettings(path.join(root, id))?.kind === 'json'
	);

	// Collision guard: a pre-existing type literally named "records" can't share the new container.
	if (topLevelTypes.includes(RECORDS_DIR)) {
		conflicts.push(
			`A record type folder is named "${RECORDS_DIR}", which collides with the new records/ container. Rename it before migrating.`
		);
	}

	// 6a. Move each top-level json type → records/<id>/ (+ strip dataFileName).
	for (const id of topLevelTypes) {
		if (id === RECORDS_DIR) continue; // flagged as a conflict above
		const src = path.join(root, id);
		const dest = path.join(recordsDir, id);
		if (fs.existsSync(dest)) {
			conflicts.push(
				`[${id}] records/${id}/ already exists — left top-level copy in place: ${src}`
			);
			continue;
		}
		plan(`move record type "${id}" → records/${id}/ ${c.dim('(+ strip dataFileName)')}`, () => {
			fs.mkdirSync(recordsDir, { recursive: true });
			moveDir(src, dest);
			stripDataFileName(path.join(dest, 'settings.json'));
		});
	}

	// 6b. Strip the dead dataFileName from already-placed types (globals + anything under records/).
	const stripTargets = [path.join(root, 'globals', 'settings.json')];
	if (fs.existsSync(recordsDir)) {
		for (const ent of fs.readdirSync(recordsDir, { withFileTypes: true })) {
			if (ent.isDirectory()) stripTargets.push(path.join(recordsDir, ent.name, 'settings.json'));
		}
	}
	for (const sp of stripTargets) {
		const s = readJsonSafe(sp);
		if (s && typeof s === 'object' && 'dataFileName' in s) {
			plan(`strip dead dataFileName from ${path.relative(root, sp)}`, () => stripDataFileName(sp));
		}
	}

	// 6c. Hoist app-wide prefs out of media/settings.json → <root>/settings.json (keep only classOrder).
	const mediaSettingsPath = path.join(root, 'media', 'settings.json');
	const ms = readJsonSafe(mediaSettingsPath);
	if (ms && typeof ms === 'object' && APP_KEYS.some((k) => k in ms)) {
		plan('hoist app-wide prefs: media/settings.json → <root>/settings.json', () => {
			const appPatch = {};
			for (const k of APP_KEYS) if (k in ms) appPatch[k] = ms[k];
			const rootSettingsPath = path.join(root, 'settings.json');
			const existingRoot = readJsonSafe(rootSettingsPath) || {};
			writeJsonAtomic(rootSettingsPath, { ...existingRoot, ...appPatch });
			// media/settings.json keeps only classOrder (drop the file entirely if there is none).
			if (Array.isArray(ms.classOrder)) {
				writeJsonAtomic(mediaSettingsPath, { classOrder: ms.classOrder });
			} else {
				fs.rmSync(mediaSettingsPath, { force: true });
			}
		});
	}

	// 6d. Create records/settings.json (dormant typeOrder home) when there are record types.
	const recordsHasTypes =
		fs.existsSync(recordsDir) &&
		fs
			.readdirSync(recordsDir, { withFileTypes: true })
			.some((e) => e.isDirectory() && readSettings(path.join(recordsDir, e.name)));
	const recordsSettingsPath = path.join(recordsDir, 'settings.json');
	if ((topLevelTypes.length > 0 || recordsHasTypes) && !fs.existsSync(recordsSettingsPath)) {
		plan('create records/settings.json', () => {
			fs.mkdirSync(recordsDir, { recursive: true });
			writeJsonAtomic(recordsSettingsPath, {});
		});
	}

	// 6e. Ensure the Posts sub-app registry exists (Item 14). Only a diagnostic when there is post
	// content on disk but no registry — the app also creates `posts/settings.json` on first write, so
	// this just heals a hand-created `posts/<collection>/` folder into a listable collection. If a
	// `posts/` dir exists with collection subfolders but no settings.json, register them.
	const postsDir = path.join(root, 'posts');
	const postsSettingsPath = path.join(postsDir, 'settings.json');
	if (fs.existsSync(postsDir) && !fs.existsSync(postsSettingsPath)) {
		const collectionIds = fs
			.readdirSync(postsDir, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name);
		if (collectionIds.length > 0) {
			plan(`create posts/settings.json registering ${collectionIds.length} collection(s)`, () => {
				const collections = {};
				for (const id of collectionIds) collections[id] = { displayName: id };
				writeJsonAtomic(postsSettingsPath, { collectionOrder: collectionIds, collections });
			});
		}
	}
})();

// --- Report ---
console.log(c.bold('Pending upgrades:'));
if (planned.length === 0) {
	console.log(`  ${c.green('none — your setup is up to date.')}`);
} else {
	for (const a of planned) console.log(`  ${c.yellow('•')} ${a.msg}`);
}

if (conflicts.length > 0) {
	console.log(c.bold('\nConflicts (need manual attention, not auto-fixed):'));
	for (const m of conflicts) console.log(`  ${c.red('✗')} ${m}`);
}

if (notes.length > 0) {
	console.log(c.bold('\nNotes:'));
	for (const m of notes) console.log(`  ${c.dim('i')} ${c.dim(m)}`);
}

console.log('');

if (apply && planned.length > 0) {
	console.log(c.bold('Applying upgrades...'));
	let done = 0;
	for (const a of planned) {
		try {
			if (a.fix) {
				a.fix();
				done++;
			}
		} catch (err) {
			console.log(`  ${c.red('✗')} failed: ${a.msg}\n    ${err?.message ?? err}`);
		}
	}
	console.log(`  ${c.green(`applied ${done}/${planned.length} upgrade(s).`)}`);
	if (conflicts.length > 0)
		console.log(c.yellow(`  ${conflicts.length} conflict(s) still need manual attention.`));
	console.log('');
	process.exit(0);
}

if (planned.length > 0) {
	console.log(
		c.dim(`Re-run with ${c.bold('--apply')} to perform the ${planned.length} upgrade(s) above.\n`)
	);
	process.exit(1);
}

process.exit(0);
