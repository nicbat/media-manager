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

/**
 * Why a derivative has no file: it was attempted (or deliberately not attempted) and produced nothing.
 *
 * - `unsupported` — not a still image sharp can read (video, PDF, animated GIF).
 * - `larger` — the re-encode came out bigger than the original, so it was discarded.
 * - `error` — the encoder threw (a corrupt or truncated source).
 */
export const DerivedSkipReasonSchema = z.enum(['unsupported', 'larger', 'error']);
export type DerivedSkipReason = z.infer<typeof DerivedSkipReasonSchema>;

/**
 * One generated derivative of a blob, under one preset (Item 15 compression).
 *
 * Two shapes share this schema: a **generated** entry carries `file_name` + measurements, and a
 * **skipped** entry carries `skipped` and no file. Both always carry `recipe` — staleness is a recipe
 * *comparison*, so a skip with no recipe would mismatch every preset and be retried on every backfill
 * forever, which is exactly what the skip exists to prevent.
 *
 * `width`/`height` are the **derivative's** dimensions, not the original's (a 400px-wide thumbnail has
 * `width: 400`) — the reader hands these to `<img>` and using the original's would be wrong by
 * construction.
 */
export const DerivedEntrySchema = z.object({
	/** Basename within `derived/<preset>/`. Absent iff the derivative was skipped. */
	file_name: z.string().optional(),
	/** Byte size of the derivative. */
	size: z.number().optional(),
	/** The derivative's own pixel dimensions (differ from the original's for a width-bearing preset). */
	width: z.number().optional(),
	height: z.number().optional(),
	/** Structural-similarity score vs. the original, 0–1, three decimals. See `server/compression/ssim.ts`. */
	ssim: z.number().optional(),
	/** The preset recipe this was generated from (e.g. `webp:q80`) — the staleness key. */
	recipe: z.string(),
	/** The original's byte size at generation time — detects an overwritten re-upload. */
	source_size: z.number().optional(),
	generated_at: z.string().optional(),
	/** Set iff no file was produced; see {@link DerivedSkipReasonSchema}. */
	skipped: DerivedSkipReasonSchema.optional()
});
export type DerivedEntry = z.infer<typeof DerivedEntrySchema>;

/** One blob's manifest entry. `file_name` is canonical; `classes[]` is a derived membership index. */
export const ManifestEntrySchema = z.object({
	file_name: z.string().min(1),
	classes: z.array(z.string()).default([]),
	missing: z.boolean().default(false),
	size: z.number().optional(),
	created_at: z.string().optional(),
	/** Intrinsic image dimensions, backfilled lazily on listing (best-effort; absent for non-images). */
	width: z.number().optional(),
	height: z.number().optional(),
	/**
	 * Generated compressed derivatives, keyed by preset id (Item 15).
	 *
	 * **This schema is a bare `z.object`, so zod *strips* anything not declared here** and every mutator
	 * round-trips `readManifest() → parse → mutate → write`. A `derived` block that wasn't declared on
	 * this schema would survive only until the next unrelated membership/rename/dimension write, then
	 * vanish with no error. Same reason the reader's hand-rolled `parseManifest` whitelists it.
	 */
	derived: z.record(DerivedEntrySchema).optional()
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
		if (existing) {
			// An overwrite re-upload reuses the name: refresh `size` rather than returning early with the
			// previous blob's byte count. Compression staleness compares `derived.source_size` against this,
			// so a stale size here means a re-uploaded original never regenerates its derivative.
			const entry = manifest.files[existing];
			if (size != null && entry && entry.size !== size) {
				manifest.files[existing] = { ...entry, size };
				await writeJsonFileAtomic(getManifestPath(), manifest);
			}
			return existing as FileId;
		}
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
 * Persist lazily-stat'ed byte sizes onto manifest entries (the size counterpart of
 * {@link setEntryDimensions}). Written only when something changed; unknown ids ignored.
 *
 * Use case:
 * - `size` was historically written **only at mint**, so blobs adopted by {@link reconcile} (anything
 *   hand-dropped into the blob dir) had no size at all — visible today as an empty `file:size` cell,
 *   and fatal for the compression page's savings total, which sums original bytes.
 *
 * @param sizes - file_id → byte size measured on disk.
 */
export async function setEntrySizes(sizes: Map<string, number>): Promise<void> {
	if (sizes.size === 0) return;
	await withFileLock(manifestLockPath(), async () => {
		const manifest = await readManifest();
		let changed = false;
		for (const [id, size] of sizes) {
			const entry = manifest.files[id];
			if (!entry || entry.size === size) continue;
			manifest.files[id] = { ...entry, size };
			changed = true;
		}
		if (changed) await writeJsonFileAtomic(getManifestPath(), manifest);
	});
}

/**
 * Write a batch of generated/skipped derivative results onto their blobs' entries, in **one** locked
 * manifest write (Item 15).
 *
 * Use case:
 * - The compression worker completes derivatives concurrently. Writing each result individually would
 *   mean one full manifest rewrite *and* one lock acquisition per file — and since every grid read goes
 *   through `listAllFiles → reconcile`, which takes the same lock, a 400-file backfill doing that would
 *   start failing user requests once {@link withFileLock}'s ~4.3s retry budget runs out. So the worker
 *   batches and calls this once per batch.
 *
 * @param results - file_id → (preset id → the derivative record to store).
 *
 * Concerns / future improvements:
 * - Merges per preset, so a batch touching only `web` leaves a blob's other presets alone.
 */
export async function setDerivedEntries(
	results: Map<string, Record<string, DerivedEntry>>
): Promise<void> {
	if (results.size === 0) return;
	await withFileLock(manifestLockPath(), async () => {
		const manifest = await readManifest();
		let changed = false;
		for (const [id, presets] of results) {
			const entry = manifest.files[id];
			if (!entry) continue;
			manifest.files[id] = { ...entry, derived: { ...(entry.derived ?? {}), ...presets } };
			changed = true;
		}
		if (changed) await writeJsonFileAtomic(getManifestPath(), manifest);
	});
}

/**
 * Drop derivative records from the manifest — one preset across every blob (a deleted preset), or every
 * preset of one blob (a deleted/replaced original).
 *
 * @param opts.presetId - Remove this preset from every entry.
 * @param opts.fileId - Remove every preset from this one entry.
 * @returns The `{ fileId, presetId, file_name }` triples that were removed, so the caller can unlink the
 *   corresponding files from disk.
 */
export async function removeDerivedEntries(opts: {
	presetId?: string;
	fileId?: string;
}): Promise<{ fileId: string; presetId: string; file_name: string }[]> {
	return await withFileLock(manifestLockPath(), async () => {
		const manifest = await readManifest();
		const removed: { fileId: string; presetId: string; file_name: string }[] = [];
		let changed = false;
		for (const [id, entry] of Object.entries(manifest.files)) {
			if (opts.fileId && id !== opts.fileId) continue;
			if (!entry.derived) continue;
			const next: Record<string, DerivedEntry> = {};
			for (const [pid, d] of Object.entries(entry.derived)) {
				if (opts.presetId && pid !== opts.presetId) {
					next[pid] = d;
					continue;
				}
				if (d.file_name) removed.push({ fileId: id, presetId: pid, file_name: d.file_name });
				changed = true;
			}
			if (Object.keys(next).length === Object.keys(entry.derived).length) continue;
			manifest.files[id] = { ...entry, derived: Object.keys(next).length > 0 ? next : undefined };
			changed = true;
		}
		if (changed) await writeJsonFileAtomic(getManifestPath(), manifest);
		return removed;
	});
}

/**
 * Rename a blob's derivative files in the manifest (the bookkeeping half of a blob rename).
 *
 * @param fileId - The blob whose derivatives were renamed on disk.
 * @param names - preset id → the derivative's new basename.
 */
export async function renameDerivedEntries(
	fileId: string,
	names: Map<string, string>
): Promise<void> {
	if (names.size === 0) return;
	await withFileLock(manifestLockPath(), async () => {
		const manifest = await readManifest();
		const entry = manifest.files[fileId];
		if (!entry?.derived) return;
		const next: Record<string, DerivedEntry> = { ...entry.derived };
		let changed = false;
		for (const [pid, name] of names) {
			if (!next[pid]) continue;
			next[pid] = { ...next[pid], file_name: name };
			changed = true;
		}
		if (!changed) return;
		manifest.files[fileId] = { ...entry, derived: next };
		await writeJsonFileAtomic(getManifestPath(), manifest);
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
