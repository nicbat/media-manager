import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

import { getGlobalFilesDir, getDerivedDir } from '$lib/storage/paths.js';
import type { DerivedEntry } from '$lib/storage/manifest.js';
import { recipeOf, type CompressionPreset } from '$lib/storage/compressionSettings.js';
import { isCompressibleFilename } from '$lib/storage/derived.js';
import { computeSsim } from './ssim.js';

/**
 * The derivative **generator** (Item 15): turn one original + one preset into one compressed file plus
 * the manifest record describing it.
 *
 * Rules this module obeys, all of them load-bearing:
 *
 * 1. **Originals are never touched.** Not overwritten, not moved, not deleted. Every derivative is
 *    additive, so deleting `media/derived/` entirely is always safe and always recoverable by a backfill.
 * 2. **Orientation and colour are preserved explicitly** — `sharp(src).rotate().keepMetadata()`. sharp
 *    neither auto-rotates nor keeps the ICC profile unless told, and a derivative that ignores the EXIF
 *    orientation of a phone photo renders sideways. `.rotate()` bakes the rotation into the pixels and
 *    resets the stored tag to 1, so there is no double rotation. SSIM **cannot** catch this class of bug
 *    (see `ssim.ts`), which is why it is a generator rule and not a check.
 * 3. **A derivative bigger than its original is discarded.** Already-optimised small PNGs, screenshots
 *    and icon sprites routinely grow under re-encode.
 * 4. **Non-images are recorded, not attempted** — so the Compression page can say "389 of 412 covered,
 *    23 can't be" instead of looking incomplete.
 * 5. **Every skip carries a `recipe`.** Staleness is a recipe *mismatch*, so a skip with no recipe would
 *    mismatch every preset and be retried on every backfill forever — exactly what the skip prevents.
 */

/** Apply a preset's encoder settings to a sharp pipeline. */
function encode(pipeline: sharp.Sharp, preset: CompressionPreset): sharp.Sharp {
	switch (preset.format) {
		case 'webp':
			return pipeline.webp({ quality: preset.quality });
		case 'avif':
			return pipeline.avif({ quality: preset.quality });
		case 'jpeg':
			return pipeline.jpeg({ quality: preset.quality, mozjpeg: true });
		case 'png':
			// PNG is lossless; `quality` drives palette quantization rather than an encoder knob.
			return pipeline.png({ quality: preset.quality, compressionLevel: 9 });
	}
}

/**
 * Generate one derivative, or record why none was produced.
 *
 * Never throws: an encoder failure becomes a `skipped: 'error'` record so one corrupt source cannot
 * abort a 400-file backfill.
 *
 * @param input.fileId - The blob's manifest id.
 * @param input.fileName - The original's current filename (within the blob dir).
 * @param input.preset - The preset to generate.
 * @param input.derivedName - The already-collision-resolved output basename.
 * @returns The {@link DerivedEntry} to store on the manifest — generated or skipped, always with a `recipe`.
 */
export async function generateDerivative(input: {
	fileId: string;
	fileName: string;
	preset: CompressionPreset;
	derivedName: string;
}): Promise<DerivedEntry> {
	const { fileName, preset, derivedName } = input;
	const recipe = recipeOf(preset);

	if (!isCompressibleFilename(fileName)) return { recipe, skipped: 'unsupported' };

	const srcPath = path.join(getGlobalFilesDir(), fileName);
	const outDir = getDerivedDir(preset.id);
	const outPath = path.join(outDir, derivedName);
	// Write via a sibling temp file so an interrupted encode can never leave a truncated derivative that
	// the manifest already claims is valid.
	const tmpPath = `${outPath}.tmp-${process.pid}-${input.fileId.slice(0, 8)}`;

	try {
		const srcStat = await fs.stat(srcPath);
		await fs.mkdir(outDir, { recursive: true });

		let pipeline = sharp(srcPath).rotate().keepMetadata();
		if (preset.width) {
			// `withoutEnlargement` keeps a preset from upscaling a small source into a bigger file.
			pipeline = pipeline.resize({ width: preset.width, withoutEnlargement: true });
		}
		const info = await encode(pipeline, preset).toFile(tmpPath);

		if (info.size >= srcStat.size) {
			await fs.unlink(tmpPath).catch(() => {});
			// Remove any previous, now-superseded derivative — the manifest is about to stop claiming it.
			await fs.unlink(outPath).catch(() => {});
			return { recipe, skipped: 'larger', source_size: srcStat.size };
		}

		await fs.rename(tmpPath, outPath);
		const ssim = await computeSsim(srcPath, outPath);

		return {
			file_name: derivedName,
			size: info.size,
			width: info.width,
			height: info.height,
			...(ssim != null ? { ssim } : {}),
			recipe,
			source_size: srcStat.size,
			generated_at: new Date().toISOString()
		};
	} catch (err) {
		await fs.unlink(tmpPath).catch(() => {});
		console.error(`[compression] ${fileName} → ${preset.id}: ${(err as Error).message}`);
		return { recipe, skipped: 'error' };
	}
}
