import fs from 'node:fs/promises';
import { z } from 'zod';

import { getGlobalFilesDir, getManifestPath, isStaticAssetsMode } from './paths.js';
import { readJsonFile, writeJsonFileAtomic } from './json.js';
import { withFileLock } from './lock.js';
import { newFileId, type FileId } from '$lib/core/ids.js';
import type { SchemaDefinition } from '$lib/core/types.js';

/** Names in the global `files/` dir that are bookkeeping, not blobs (never minted a file_id). */
const NON_BLOB_NAMES = new Set(['manifest.json', 'settings.json', 'data.json', 'image-data.json']);

/**
 * Global blob manifest (`<root>/media/manifest.json`): the single registry giving every binary in the
 * shared `media/files/` store a stable, workspace-scoped identity (`file_id`), plus a **derived**
 * membership index (`classes[]`) so the All Files grid can render every thumbnail + its class chips
 * from one read without loading any class file.
 *
 * Source-of-truth rule: class files (`media/classes/<id>.json`) own membership; `classes[]` here is a
 * cache that heals toward them on drift (mtime-gated resync, driven by the files repo).
 *
 * Single point of failure + lock-ordering rule:
 * - Every mutation is atomic ({@link writeJsonFileAtomic}) under a single coarse `.lock` (single-node).
 *   When an operation needs both the manifest lock and a class lock, it must take the **manifest lock
 *   first**.
 */

/** One blob's manifest entry. `file_name` is canonical; `classes[]` is a derived membership index. */
export const ManifestEntrySchema = z.object({
	file_name: z.string().min(1),
	classes: z.array(z.string()).default([]),
	missing: z.boolean().default(false),
	size: z.number().optional(),
	created_at: z.string().optional(),
	/** Intrinsic image dimensions, backfilled lazily on listing (best-effort; absent for non-images). */
	width: z.number().optional(),
	height: z.number().optional()
});
export type ManifestEntry = z.infer<typeof ManifestEntrySchema>;

/** The whole manifest document. */
export const ManifestSchema = z.object({
	version: z.literal(2).default(2),
	files: z.record(ManifestEntrySchema).default({})
});
export type Manifest = z.infer<typeof ManifestSchema>;

/** Lock path guarding all manifest mutations. */
function manifestLockPath(): string {
	return `${getManifestPath()}.lock`;
}

/**
 * Read and validate the manifest. Returns an empty manifest (in memory, not written) when absent, so
 * reads are side-effect free.
 */
export async function readManifest(): Promise<Manifest> {
	try {
		const raw = await readJsonFile(getManifestPath());
		return ManifestSchema.parse(raw);
	} catch (err) {
		const e = err as NodeJS.ErrnoException;
		if (e.code === 'ENOENT') return { version: 2, files: {} };
		throw err;
	}
}

/** Resolve a `file_id` to its current filename, or null if unknown. */
export async function getFilenameForFileId(
	fileId: string,
	manifest?: Manifest
): Promise<string | null> {
	const m = manifest ?? (await readManifest());
	return m.files[fileId]?.file_name ?? null;
}

/** Find the id mapped to a name within an already-loaded manifest. */
function findIdByName(manifest: Manifest, fileName: string): string | null {
	for (const [id, entry] of Object.entries(manifest.files)) {
		if (entry.file_name === fileName) return id;
	}
	return null;
}

/**
 * Get (or create) the `file_id` for a filename. Idempotent by name.
 *
 * @param fileName - Basename of a blob in the global store.
 * @param size - Optional byte size to record.
 */
export async function mintFileId(fileName: string, size?: number): Promise<FileId> {
	return await withFileLock(manifestLockPath(), async () => {
		const manifest = await readManifest();
		const existing = findIdByName(manifest, fileName);
		if (existing) return existing as FileId;
		const id = newFileId();
		manifest.files[id] = {
			file_name: fileName,
			classes: [],
			missing: false,
			...(size != null ? { size } : {}),
			created_at: new Date().toISOString()
		};
		await writeJsonFileAtomic(getManifestPath(), manifest);
		return id;
	});
}

/** Update only the `file_name` of an existing entry (the O(1) rename primitive). */
export async function renameFileId(fileId: string, newName: string): Promise<void> {
	await withFileLock(manifestLockPath(), async () => {
		const manifest = await readManifest();
		const entry = manifest.files[fileId];
		if (!entry) throw new Error(`Unknown file_id: ${fileId}`);
		manifest.files[fileId] = { ...entry, file_name: newName };
		await writeJsonFileAtomic(getManifestPath(), manifest);
	});
}

/** Remove a manifest entry entirely (used only when a blob is deleted from disk). */
export async function removeFileId(fileId: string): Promise<void> {
	await withFileLock(manifestLockPath(), async () => {
		const manifest = await readManifest();
		if (!(fileId in manifest.files)) return;
		delete manifest.files[fileId];
		await writeJsonFileAtomic(getManifestPath(), manifest);
	});
}

/**
 * Add or remove a class id in a blob's derived `classes[]` index (called right after the class file
 * is written, so steady state stays fresh). No-op if the entry is unknown.
 *
 * @param fileId - Blob identity.
 * @param classId - Class to add/remove.
 * @param member - true to add membership, false to remove.
 */
export async function setClassMembership(
	fileId: string,
	classId: string,
	member: boolean
): Promise<void> {
	await withFileLock(manifestLockPath(), async () => {
		const manifest = await readManifest();
		const entry = manifest.files[fileId];
		if (!entry) return;
		const set = new Set(entry.classes);
		if (member) set.add(classId);
		else set.delete(classId);
		manifest.files[fileId] = { ...entry, classes: [...set].sort() };
		await writeJsonFileAtomic(getManifestPath(), manifest);
	});
}

/** Strip a class id from every blob's `classes[]` index (used when a class is deleted). */
export async function removeClassFromIndex(classId: string): Promise<void> {
	await withFileLock(manifestLockPath(), async () => {
		const manifest = await readManifest();
		let changed = false;
		for (const [id, entry] of Object.entries(manifest.files)) {
			if (!entry.classes.includes(classId)) continue;
			manifest.files[id] = { ...entry, classes: entry.classes.filter((c) => c !== classId) };
			changed = true;
		}
		if (changed) await writeJsonFileAtomic(getManifestPath(), manifest);
	});
}

/**
 * Overwrite the entire derived membership index from an authoritative map (class files → file_ids).
 * Used by the mtime-gated resync when class files were edited out-of-band.
 *
 * @param membership - file_id → set of class ids that currently have a record for it.
 */
export async function applyMembershipIndex(
	membership: Map<string, Set<string>>
): Promise<Manifest> {
	return await withFileLock(manifestLockPath(), async () => {
		const manifest = await readManifest();
		let changed = false;
		for (const [id, entry] of Object.entries(manifest.files)) {
			const next = [...(membership.get(id) ?? new Set<string>())].sort();
			if (next.length !== entry.classes.length || next.some((c, i) => c !== entry.classes[i])) {
				manifest.files[id] = { ...entry, classes: next };
				changed = true;
			}
		}
		if (changed) await writeJsonFileAtomic(getManifestPath(), manifest);
		return manifest;
	});
}

/**
 * Persist lazily-read intrinsic image dimensions onto manifest entries (best-effort; ignores unknown
 * ids). Written only when something changed.
 *
 * @param dims - file_id → measured width/height.
 */
export async function setEntryDimensions(
	dims: Map<string, { width?: number; height?: number }>
): Promise<void> {
	if (dims.size === 0) return;
	await withFileLock(manifestLockPath(), async () => {
		const manifest = await readManifest();
		let changed = false;
		for (const [id, d] of dims) {
			const entry = manifest.files[id];
			if (!entry) continue;
			if (entry.width === d.width && entry.height === d.height) continue;
			manifest.files[id] = { ...entry, width: d.width, height: d.height };
			changed = true;
		}
		if (changed) await writeJsonFileAtomic(getManifestPath(), manifest);
	});
}

/**
 * Read the stored intrinsic dimensions of a single blob, or undefined values if the id is unknown or
 * the dimensions were never backfilled.
 *
 * @param fileId - Blob id (manifest key).
 * @returns `{ width, height }` (either may be undefined).
 */
export async function getEntryDimensions(
	fileId: string
): Promise<{ width: number | undefined; height: number | undefined }> {
	const manifest = await readManifest();
	const entry = manifest.files[fileId];
	return { width: entry?.width, height: entry?.height };
}

/**
 * Explicitly set the intrinsic dimensions of a single blob (the Item 13 "correct / swap dimensions"
 * write). Unlike {@link setEntryDimensions} (a best-effort backfill), this is a deliberate user
 * correction, so it overwrites whatever is stored.
 *
 * @param fileId - Blob id (manifest key).
 * @param dims - The width/height to persist.
 * @throws If the id is unknown.
 *
 * Concerns / future improvements:
 * - The lazy backfill in the files repo only fills entries whose dims are absent, so these corrected
 *   values survive subsequent listings (it won't clobber them).
 */
export async function setBlobDimensions(
	fileId: string,
	dims: { width: number; height: number }
): Promise<void> {
	await withFileLock(manifestLockPath(), async () => {
		const manifest = await readManifest();
		const entry = manifest.files[fileId];
		if (!entry) throw new Error(`Unknown file_id: ${fileId}`);
		if (entry.width === dims.width && entry.height === dims.height) return;
		manifest.files[fileId] = { ...entry, width: dims.width, height: dims.height };
		await writeJsonFileAtomic(getManifestPath(), manifest);
	});
}

/** Result of {@link reconcile}: what changed, plus the up-to-date manifest. */
export interface ReconcileResult {
	/** Blobs newly seen on disk that were minted a `file_id`. */
	added: { file_id: string; file_name: string }[];
	/** Manifest entries whose blob is no longer on disk (flagged `missing`, not removed). */
	missing: { file_id: string; file_name: string }[];
	manifest: Manifest;
}

/**
 * Reconcile the manifest against the blob filenames currently on disk, in one locked critical section.
 * New disk files are minted ids; entries whose blob vanished are flagged `missing: true` (kept so
 * missing-file rows still resolve a name); entries that reappear clear the flag. Written only on change.
 *
 * **Adoption gating (static-assets mode):** auto-adopting every unknown disk basename is correct when
 * the blob dir is the workspace's private `media/files/`, but *dangerous* when it points at a host's
 * shared static folder — the site's own `favicon.png` / `og-image.jpg` would silently enter the
 * manifest on the next list. So adoption defaults **off** whenever {@link isStaticAssetsMode} is true;
 * in that mode blobs enter the manifest only via explicit registration (upload → `registerBlob`) or a
 * future import. Missing-flagging always runs (an entry whose blob is gone is still flagged). Pass
 * `{ adopt }` to force either behavior (tests, `export`).
 *
 * @param diskNames - Basenames of real blobs currently in the global store.
 * @param opts.adopt - Override the default adoption policy (`!isStaticAssetsMode()`).
 */
export async function reconcile(
	diskNames: string[],
	opts?: { adopt?: boolean }
): Promise<ReconcileResult> {
	const adopt = opts?.adopt ?? !isStaticAssetsMode();
	return await withFileLock(manifestLockPath(), async () => {
		const manifest = await readManifest();
		const diskSet = new Set(diskNames);
		let changed = false;

		const knownNames = new Set(Object.values(manifest.files).map((e) => e.file_name));
		const added: { file_id: string; file_name: string }[] = [];
		if (adopt) {
			for (const name of diskNames) {
				if (knownNames.has(name)) continue;
				const id = newFileId();
				manifest.files[id] = {
					file_name: name,
					classes: [],
					missing: false,
					created_at: new Date().toISOString()
				};
				knownNames.add(name);
				added.push({ file_id: id, file_name: name });
				changed = true;
			}
		}

		const missing: { file_id: string; file_name: string }[] = [];
		for (const [id, entry] of Object.entries(manifest.files)) {
			const isMissing = !diskSet.has(entry.file_name);
			if (isMissing) missing.push({ file_id: id, file_name: entry.file_name });
			if (entry.missing !== isMissing) {
				manifest.files[id] = { ...entry, missing: isMissing };
				changed = true;
			}
		}

		if (changed) await writeJsonFileAtomic(getManifestPath(), manifest);
		return { added, missing, manifest };
	});
}

/**
 * Read the basenames of real blobs currently in `media/files/` (excludes manifest/settings, lock
 * files, and dotfiles).
 */
export async function readGlobalBlobNames(): Promise<string[]> {
	const dirents = await fs.readdir(getGlobalFilesDir(), { withFileTypes: true }).catch(() => []);
	return dirents
		.filter(
			(d) =>
				d.isFile() &&
				!d.name.startsWith('.') &&
				!d.name.endsWith('.lock') &&
				!NON_BLOB_NAMES.has(d.name)
		)
		.map((d) => d.name);
}

/**
 * Reconcile against disk and return the manifest plus the set of **available** file ids (registered and
 * actually present on disk). Single source of truth for whether a `file`-field reference resolves.
 */
export async function getAvailableFileIds(): Promise<{
	manifest: Manifest;
	available: Set<string>;
}> {
	const diskNames = await readGlobalBlobNames();
	const { manifest } = await reconcile(diskNames);
	return { manifest, available: availableFromManifest(manifest, new Set(diskNames)) };
}

/** Build the available-id set from an already-loaded manifest and on-disk name set. */
export function availableFromManifest(manifest: Manifest, diskNames: Set<string>): Set<string> {
	const available = new Set<string>();
	for (const [id, entry] of Object.entries(manifest.files)) {
		if (diskNames.has(entry.file_name)) available.add(id);
	}
	return available;
}

/**
 * The `file`-type field keys on `record` whose referenced blob id is not currently available.
 */
export function missingFileFields(
	record: Record<string, unknown>,
	schema: SchemaDefinition,
	available: Set<string>
): string[] {
	const out: string[] = [];
	for (const [key, def] of Object.entries(schema)) {
		if (def?.type !== 'file') continue;
		const ids = fileRefIds(record[key]);
		if (ids.length === 0) continue;
		if (ids.some((id) => !available.has(id))) out.push(key);
	}
	return out;
}

/**
 * The `file`-type field keys whose referenced blob is registered (not missing) but is **not a member**
 * of the field's `classId` scope. A separate concern from {@link missingFileFields} (the blob exists;
 * it's just out of the required class) — only meaningful for class-scoped file fields.
 */
export function outOfClassFields(
	record: Record<string, unknown>,
	schema: SchemaDefinition,
	manifest: Manifest
): string[] {
	const out: string[] = [];
	for (const [key, def] of Object.entries(schema)) {
		if (def?.type !== 'file') continue;
		const classId = (def as { classId?: string }).classId;
		if (!classId) continue;
		const ids = fileRefIds(record[key]);
		if (
			ids.some((id) => {
				const entry = manifest.files[id];
				return entry && !(entry.classes ?? []).includes(classId);
			})
		)
			out.push(key);
	}
	return out;
}

/**
 * Map of `file`-field key → the required `classId` for each out-of-class reference on `record`, or
 * undefined when none. The UI resolves the classId to the class's display name in the hint.
 */
export function outOfClassMap(
	record: Record<string, unknown>,
	schema: SchemaDefinition,
	manifest: Manifest
): Record<string, string> | undefined {
	const keys = outOfClassFields(record, schema, manifest);
	if (keys.length === 0) return undefined;
	const out: Record<string, string> = {};
	for (const key of keys) out[key] = (schema[key] as { classId?: string }).classId ?? '';
	return out;
}

/** Normalize a `file`-field value (single id or id[]) to an id array, dropping empties. */
function fileRefIds(val: unknown): string[] {
	if (Array.isArray(val)) return val.filter((v): v is string => typeof v === 'string' && v !== '');
	return typeof val === 'string' && val !== '' ? [val] : [];
}

/**
 * Map of `file`-field key → expected filename(s) for each broken file reference on `record`, or
 * undefined when nothing is broken. Multiselect file fields join the missing names with a comma.
 */
export function missingFilesMap(
	record: Record<string, unknown>,
	schema: SchemaDefinition,
	manifest: Manifest,
	available: Set<string>
): Record<string, string> | undefined {
	const keys = missingFileFields(record, schema, available);
	if (keys.length === 0) return undefined;
	const out: Record<string, string> = {};
	for (const key of keys) {
		const missing = fileRefIds(record[key]).filter((id) => !available.has(id));
		out[key] = missing.map((id) => manifest.files[id]?.file_name ?? '').join(', ');
	}
	return out;
}
