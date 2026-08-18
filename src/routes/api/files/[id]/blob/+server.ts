import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import * as fs from 'node:fs';
import path from 'node:path';
import { getDerivedDir, getGlobalFilesDir } from '$lib/storage/paths.js';
import { getFilenameForId } from '$lib/storage/classRepo.js';
import { readManifest } from '$lib/storage/manifest.js';
import { ImageIdSchema } from '$lib/core/ids.js';

const CONTENT_TYPES: Record<string, string> = {
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.png': 'image/png',
	'.gif': 'image/gif',
	'.svg': 'image/svg+xml',
	'.webp': 'image/webp',
	'.avif': 'image/avif',
	'.tif': 'image/tiff',
	'.tiff': 'image/tiff',
	'.mp4': 'video/mp4',
	'.webm': 'video/webm',
	'.pdf': 'application/pdf',
	'.txt': 'text/plain; charset=utf-8'
};

/**
 * Cache lifetime for a compressed derivative (Item 15).
 *
 * Derivatives are regenerated **quietly and in place**, under the same filename, so a quality change
 * produces new bytes at an address a cache already believes it knows. Clean, shareable filenames are a
 * deliberate decision (versioned/hashed URLs are deferred — see `plans/image-compression.html` §
 * "Keeping caches honest"), and this bounded lifetime is what pays for that decision: a preset change
 * reaches every visitor within an hour.
 *
 * The one genuinely broken combination is a clean name with an *uncontrolled* lifetime — a changed image
 * that never reaches anyone — so this header is not optional. Hosts serving `media/derived/` as static
 * files (the static-assets/CDN path, e.g. Vercel) must set the equivalent themselves; the reader README
 * documents that.
 */
const DERIVED_CACHE_CONTROL = 'public, max-age=3600';

/** Originals are content-stable under a given name, but the editor can overwrite one; keep it short. */
const ORIGINAL_CACHE_CONTROL = 'private, max-age=60';

/**
 * GET: Raw blob bytes by manifest id.
 *
 * `?preset=<id>` serves that preset's **compressed derivative** instead of the original (Item 15).
 * An unknown or not-yet-generated preset falls through to the original rather than 404ing — the same
 * "can never render a broken image" rule the reader's `variant()` follows.
 */
export const GET: RequestHandler = async ({ params, url }) => {
	const id = ImageIdSchema.safeParse(params.id);
	if (!id.success) throw error(400, 'Invalid id');
	const preset = url.searchParams.get('preset')?.trim() || null;

	try {
		if (preset) {
			const entry = (await readManifest()).files[id.data];
			const derived = entry?.derived?.[preset];
			if (derived?.file_name) {
				// The name comes from the manifest, never reconstructed, so it is already the resolved
				// (collision-safe) one. `path.basename` is belt-and-braces against a doctored manifest.
				const derivedPath = path.join(getDerivedDir(preset), path.basename(derived.file_name));
				if (fs.existsSync(derivedPath)) {
					return blobResponse(derivedPath, DERIVED_CACHE_CONTROL);
				}
			}
		}

		const filename = await getFilenameForId(id.data);
		if (!filename) throw error(404, 'File not found');
		const filePath = path.join(getGlobalFilesDir(), filename);
		if (!fs.existsSync(filePath)) throw error(404, 'File not found on disk');
		return blobResponse(filePath, ORIGINAL_CACHE_CONTROL);
	} catch (err) {
		if (err && typeof err === 'object' && 'status' in err) throw err as never;
		throw error(500, { message: 'Failed to get file' });
	}
};

/** Read a file from disk into a response with its content type and an explicit cache lifetime. */
function blobResponse(filePath: string, cacheControl: string): Response {
	const buffer = fs.readFileSync(filePath);
	const ext = path.extname(filePath).toLowerCase();
	return new Response(buffer, {
		headers: {
			'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
			'Cache-Control': cacheControl
		}
	});
}
