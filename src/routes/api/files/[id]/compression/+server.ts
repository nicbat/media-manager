import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

import { ImageIdSchema } from '$lib/core/ids.js';
import { readManifest } from '$lib/storage/manifest.js';
import {
	presetsForBlob,
	readCompressionSettings,
	recipeOf
} from '$lib/storage/compressionSettings.js';
import { isCompressibleFilename, isStale, readClassPresetMap } from '$lib/storage/derived.js';

/**
 * GET: one blob's compression detail — a row per preset it is subscribed to (Item 15 phase 2).
 *
 * The per-file counterpart of `/api/compression`: aggregate numbers tell you the system works, per-file
 * numbers tell you *which file to fix*. Separate from the grid's `FileItem.compression` summary on
 * purpose — that one carries a single savings/quality figure so a 400-tile masonry stays light, whereas
 * this is only fetched for the one blob whose editor is open.
 *
 * Rows describe the **subscribed** set (the union of the workspace subscription and this blob's
 * classes), so a preset the blob isn't subscribed to simply doesn't appear, and a subscribed preset that
 * hasn't been generated yet appears as `pending`.
 */
export const GET: RequestHandler = async ({ params }) => {
	const id = ImageIdSchema.safeParse(params.id);
	if (!id.success) throw error(400, 'Invalid id');

	const manifest = await readManifest();
	const entry = manifest.files[id.data];
	if (!entry) throw error(404, 'File not found');

	const settings = readCompressionSettings();
	const subscribed = presetsForBlob(settings, entry.classes, readClassPresetMap());

	const presets = subscribed.map((preset) => {
		const d = entry.derived?.[preset.id];
		const generated = !!d?.file_name && !d.skipped;
		const sourceSize = d?.source_size ?? entry.size ?? null;
		return {
			presetId: preset.id,
			label: preset.label || preset.id,
			recipe: recipeOf(preset),
			/** True when the preset resizes, so its score measures codec loss at a smaller size. */
			resized: preset.width != null,
			generated,
			skipped: d?.skipped ?? null,
			stale: !!d && isStale(d, preset, entry.size),
			originalSize: sourceSize,
			size: d?.size ?? null,
			width: d?.width ?? null,
			height: d?.height ?? null,
			ssim: d?.ssim ?? null,
			savedBytes: generated && sourceSize != null ? Math.max(0, sourceSize - (d!.size ?? 0)) : null,
			generatedAt: d?.generated_at ?? null,
			/** The URL that serves this preset (falls back to the original server-side if absent). */
			src: generated ? `/api/files/${id.data}/blob?preset=${encodeURIComponent(preset.id)}` : null
		};
	});

	return json({
		fileId: id.data,
		fileName: entry.file_name,
		originalSize: entry.size ?? null,
		compressible: isCompressibleFilename(entry.file_name),
		presets
	});
};
