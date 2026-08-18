import fs from 'node:fs/promises';
import * as fssync from 'node:fs';
import path from 'node:path';

import { getClassFilePath, getDerivedDir, getDerivedRootDir, listClassIds } from './paths.js';
import { fileExtension } from '$lib/core/images.js';
import {
	recipeOf,
	readCompressionSettings,
	type CompressionFormat,
	type CompressionPreset
} from './compressionSettings.js';
import {
	readManifest,
	removeDerivedEntries,
	renameDerivedEntries,
	type DerivedEntry
} from './manifest.js';

/**
 * Derivative **naming, staleness and on-disk housekeeping** (Item 15) — everything about compressed
 * twins that does *not* need an encoder.
 *
 * Kept separate from `server/compression/generate.ts` (which owns the `sharp` pipeline) so the blob
 * lifecycle in `classRepo` — rename, delete — can keep derivatives in step **without** pulling a heavy
 * native dependency into the storage layer.
 */

/** Container extension written for each output format. */
const FORMAT_EXT: Record<CompressionFormat, string> = {
	webp: '.webp',
	avif: '.avif',
	jpeg: '.jpg',
	png: '.png'
};

/**
 * Source extensions the generator will attempt.
 *
 * Deliberately narrower than `ALLOWED_IMAGE_EXTENSIONS`: **SVG** is vector (rasterizing it to WebP is a
 * downgrade, not a compression) and **GIF** is out of scope by choice — sharp reads a static GIF fine,
 * but the animated case needs different handling and phase 1 should not guess which one it has. HEIC
 * never appears here: upload converts it to JPEG before the blob is ever stored.
 */
const COMPRESSIBLE_EXTENSIONS = new Set([
	'.jpg',
	'.jpeg',
	'.png',
	'.webp',
	'.tif',
	'.tiff',
	'.avif'
]);

/** True when the generator will attempt this filename (see {@link COMPRESSIBLE_EXTENSIONS}). */
export function isCompressibleFilename(fileName: string): boolean {
	return COMPRESSIBLE_EXTENSIONS.has(fileExtension(fileName));
}

/**
 * The derivative basename for an original under a preset — the original's **stem** with the preset's
 * container extension (`sunset-over-tokyo.jpg` → `sunset-over-tokyo.webp`).
 *
 * Clean, shareable names are a deliberate decision (versioned/hashed URLs are deferred — see
 * `plans/image-compression.html` § "Keeping caches honest"), and their known cost is exactly this
 * function: two originals can share a stem (`photo.jpg` and `photo.png` both want `photo.webp`).
 * {@link resolveDerivedName} closes that.
 *
 * @param originalName - The original blob's current filename.
 * @param preset - The preset being generated.
 */
export function derivedBaseName(originalName: string, preset: CompressionPreset): string {
	const ext = path.extname(originalName);
	const stem = ext ? originalName.slice(0, -ext.length) : originalName;
	return `${stem}${FORMAT_EXT[preset.format]}`;
}

/**
 * Resolve a collision-free derivative name within one preset.
 *
 * If the natural stem-mirrored name is already claimed **by a different blob**, a short id suffix is
 * appended (`photo-8f3a1c.webp`). The resolved name is then stored on the manifest record, so every
 * lookup is a manifest read and **never** a reconstructed string — which is also what keeps the naming
 * scheme swappable if versioned URLs are ever adopted.
 *
 * @param originalName - The original blob's filename.
 * @param fileId - The blob's manifest id (the suffix source, and the owner check).
 * @param preset - The preset being generated.
 * @param claimedBy - name → owning fileId, for names already taken within this preset.
 * @returns The basename to write.
 */
export function resolveDerivedName(
	originalName: string,
	fileId: string,
	preset: CompressionPreset,
	claimedBy: Map<string, string>
): string {
	const natural = derivedBaseName(originalName, preset);
	const owner = claimedBy.get(natural);
	if (owner === undefined || owner === fileId) return natural;
	const ext = path.extname(natural);
	const stem = natural.slice(0, -ext.length);
	const short = fileId.replace(/-/g, '').slice(0, 6);
	let candidate = `${stem}-${short}${ext}`;
	for (let n = 2; claimedBy.has(candidate) && claimedBy.get(candidate) !== fileId; n++) {
		candidate = `${stem}-${short}-${n}${ext}`;
	}
	return candidate;
}

/**
 * Is a stored derivative record out of date for the current preset?
 *
 * Staleness is a **comparison, not a timestamp race**: the record is stale when the recipe it was built
 * from differs from the preset's current recipe, or when the original's byte size has changed since (an
 * overwrite re-upload under the same name).
 *
 * @param existing - The stored record, or undefined if the preset was never generated for this blob.
 * @param preset - The preset's current definition.
 * @param currentSourceSize - The original's current byte size, if known.
 */
export function isStale(
	existing: DerivedEntry | undefined,
	preset: CompressionPreset,
	currentSourceSize: number | undefined
): boolean {
	if (!existing) return true;
	if (existing.recipe !== recipeOf(preset)) return true;
	return (
		currentSourceSize != null &&
		existing.source_size != null &&
		existing.source_size !== currentSourceSize
	);
}

/**
 * Every class's compression subscription, as `classId → preset ids` (Item 15 phase 2).
 *
 * Read straight off the class files (the source of truth for class config), in one pass, so the worker
 * and the stats report can resolve the union for every blob without re-reading a class file per blob.
 *
 * @returns The map; classes with no subscription are simply absent.
 *
 * Concerns / future improvements:
 * - Synchronous + uncached, matching `listClasses`. A workspace with hundreds of classes would want the
 *   same mtime-gated caching the membership index uses, but the read is small and happens once per
 *   backfill plan / stats call, not per blob.
 */
export function readClassPresetMap(): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const id of listClassIds()) {
		try {
			const raw = JSON.parse(fssync.readFileSync(getClassFilePath(id), 'utf-8')) as {
				config?: { compressionPresets?: unknown };
			};
			const presets = raw.config?.compressionPresets;
			if (Array.isArray(presets)) {
				const ids = presets.filter((p): p is string => typeof p === 'string');
				if (ids.length > 0) out.set(id, ids);
			}
		} catch {
			/* skip a corrupt/unreadable class file — it simply contributes no subscription */
		}
	}
	return out;
}

/**
 * Delete every derivative of one blob, from disk and from the manifest. Called when the original is
 * deleted — a derivative of a file that no longer exists is pure garbage.
 *
 * @param fileId - The blob being deleted.
 *
 * Concerns / future improvements:
 * - Best-effort on the filesystem: a failed unlink is swallowed (the manifest entry is gone either way,
 *   so the leftover file is unreferenced and the next sweep collects it).
 */
export async function deleteDerivedForBlob(fileId: string): Promise<void> {
	const removed = await removeDerivedEntries({ fileId });
	for (const r of removed) {
		await fs.unlink(path.join(getDerivedDir(r.presetId), r.file_name)).catch(() => {});
	}
}

/**
 * Rename a blob's derivatives to mirror the original's new stem.
 *
 * Ordering is deliberate: this runs **after** the original's rename has succeeded, and a failure here is
 * logged rather than rolled back. A derivative left under its old filename is harmless — the manifest
 * still points at it, and every lookup reads the manifest — whereas unwinding a half-completed rename
 * of the original is not.
 *
 * @param fileId - The renamed blob.
 * @param newOriginalName - Its new filename.
 */
export async function renameDerivedForBlob(fileId: string, newOriginalName: string): Promise<void> {
	const manifest = await readManifest();
	const derived = manifest.files[fileId]?.derived;
	if (!derived) return;
	const presets = new Map(readCompressionSettings().presets.map((p) => [p.id, p]));

	// Names already taken in each preset dir by *other* blobs, so a rename can't collide either.
	const claimed = new Map<string, Map<string, string>>();
	for (const [id, entry] of Object.entries(manifest.files)) {
		for (const [presetId, d] of Object.entries(entry.derived ?? {})) {
			if (!d.file_name) continue;
			let m = claimed.get(presetId);
			if (!m) claimed.set(presetId, (m = new Map()));
			m.set(d.file_name, id);
		}
	}

	const renamed = new Map<string, string>();
	for (const [presetId, d] of Object.entries(derived)) {
		const preset = presets.get(presetId);
		if (!preset || !d.file_name) continue;
		const owners = claimed.get(presetId) ?? new Map<string, string>();
		owners.delete(d.file_name); // this blob's own current name must not block its rename
		const nextName = resolveDerivedName(newOriginalName, fileId, preset, owners);
		if (nextName === d.file_name) continue;
		const dir = getDerivedDir(presetId);
		try {
			await fs.rename(path.join(dir, d.file_name), path.join(dir, nextName));
			renamed.set(presetId, nextName);
		} catch (err) {
			console.error(
				`[compression] could not rename derivative ${presetId}/${d.file_name}: ${(err as Error).message}`
			);
		}
	}
	await renameDerivedEntries(fileId, renamed);
}

/**
 * Every derivative currently referenced by the manifest, as paths relative to the derived root
 * (`<preset>/<name>`). Used by the storage-location migration, which must carry these bytes too.
 */
export async function listDerivedRelPaths(): Promise<string[]> {
	const manifest = await readManifest();
	const out: string[] = [];
	for (const entry of Object.values(manifest.files)) {
		for (const [presetId, d] of Object.entries(entry.derived ?? {})) {
			if (d.file_name) out.push(`${presetId}/${d.file_name}`);
		}
	}
	return out;
}

/** Absolute path of a derived-root-relative path (`web/sunset.webp`). */
export function derivedAbsPath(relPath: string): string {
	return path.join(getDerivedRootDir(), relPath);
}
