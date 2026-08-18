import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';

/**
 * The two Item-15 acceptance criteria that are about the compression worker's **behaviour under
 * pressure** rather than its per-file correctness (which `compression.test.ts` covers):
 *
 * 1. "A backfill of 400+ files does not cause request failures from manifest-lock contention."
 *    This is the one claim the batched-write design exists to make good on, and it is invisible to a
 *    small unit test: `withFileLock` retries for ~4.3s and then *throws*, so a worker taking the
 *    manifest lock per file would only fail once a real backlog builds up — exactly the case a user
 *    hits and a 3-file fixture does not.
 * 2. "Deleting `media/derived/` and running a backfill reproduces the derivatives."
 *    A regression guard for a real bug: staleness is decided from the manifest record alone, so before
 *    `planWork` learned to check the filesystem, a deleted derivative tree was never rebuilt — the
 *    manifest kept claiming files that no longer existed and the page reported full coverage over them.
 */

let root: string;

beforeAll(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-backfill-load-'));
	fs.mkdirSync(path.join(root, 'media', 'files'), { recursive: true });
	fs.writeFileSync(
		path.join(root, 'media', 'settings.json'),
		JSON.stringify({
			compression: {
				autoCompress: true,
				presets: [{ id: 'web', format: 'webp', quality: 80 }],
				workspacePresets: ['web']
			}
		})
	);
	process.env.MEDIA_MANAGER_ROOT = root;
	delete process.env.MEDIA_MANAGER_ASSETS_DIR;
	delete process.env.MEDIA_MANAGER_ASSETS_BASE_URL;
});

afterAll(async () => {
	const { waitForIdle } = await import('./queue.js');
	await waitForIdle();
	delete process.env.MEDIA_MANAGER_ROOT;
	fs.rmSync(root, { recursive: true, force: true });
});

/** How many blobs the load test seeds — the acceptance criterion says "400+". */
const FILE_COUNT = 400;

/** Small, but noisy enough that WebP genuinely shrinks it (a flat image would be discarded as larger). */
async function seedPhoto(dest: string, salt: number): Promise<void> {
	const W = 120;
	const H = 90;
	const raw = Buffer.alloc(W * H * 3);
	let seed = salt * 7919 + 13;
	for (let i = 0; i < raw.length; i += 3) {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		raw[i] = seed % 256;
		raw[i + 1] = (seed >> 8) % 256;
		raw[i + 2] = (seed >> 16) % 256;
	}
	await sharp(raw, { raw: { width: W, height: H, channels: 3 } })
		.jpeg({ quality: 95 })
		.toFile(dest);
}

describe('backfill under load', () => {
	it(`compresses ${FILE_COUNT} files while concurrent grid reads keep succeeding`, async () => {
		const filesDir = path.join(root, 'media', 'files');
		for (let n = 0; n < FILE_COUNT; n++) {
			await seedPhoto(path.join(filesDir, `photo-${n}.jpg`), n);
		}

		const { listAllFiles } = await import('$lib/storage/classRepo.js');
		const { scheduleCompression, waitForIdle, getJobState } = await import('./queue.js');
		const { readManifest } = await import('$lib/storage/manifest.js');

		await listAllFiles(); // adopt them + backfill sizes before timing anything
		scheduleCompression('all');

		// Hammer the read path for the whole run. `listAllFiles` → `reconcile` takes the same manifest
		// lock the worker needs, so this is precisely the contention the batching is there to survive.
		let reads = 0;
		const readFailures: string[] = [];
		const reader = (async () => {
			while (getJobState().running || reads === 0) {
				try {
					const listed = await listAllFiles();
					expect(listed.files.length).toBe(FILE_COUNT);
					reads++;
				} catch (err) {
					readFailures.push((err as Error).message);
				}
				await new Promise((r) => setTimeout(r, 15));
			}
		})();

		await waitForIdle();
		await reader;

		const job = getJobState();
		expect(readFailures).toEqual([]);
		expect(reads).toBeGreaterThan(3); // the reader actually overlapped the run
		expect(job.error).toBeNull();
		expect(job.done).toBe(FILE_COUNT);
		expect(job.generated).toBe(FILE_COUNT);

		const manifest = await readManifest();
		const recorded = Object.values(manifest.files).filter((e) => e.derived?.web?.file_name).length;
		expect(recorded).toBe(FILE_COUNT);
	}, 300_000);

	it('rebuilds everything after `media/derived/` is deleted wholesale', async () => {
		const { scheduleCompression, waitForIdle, getJobState } = await import('./queue.js');
		const { readManifest } = await import('$lib/storage/manifest.js');
		const { getDerivedRootDir, getDerivedDir } = await import('$lib/storage/paths.js');

		const before = await readManifest();
		const expected = Object.fromEntries(
			Object.entries(before.files).map(([id, e]) => [id, e.derived!.web])
		);

		// The manifest is left untouched: it still claims every derivative. Only the bytes are gone.
		fs.rmSync(getDerivedRootDir(), { recursive: true, force: true });
		expect(fs.existsSync(getDerivedRootDir())).toBe(false);

		scheduleCompression('all');
		await waitForIdle();
		expect(getJobState().generated).toBe(FILE_COUNT);

		const after = await readManifest();
		for (const [id, prev] of Object.entries(expected)) {
			const now = after.files[id]?.derived?.web;
			expect(now, id).toBeTruthy();
			// Equal measurements, not an identical record — `generated_at` necessarily differs.
			expect(now!.file_name).toBe(prev.file_name);
			expect(now!.size).toBe(prev.size);
			expect(now!.ssim).toBe(prev.ssim);
			expect(now!.recipe).toBe(prev.recipe);
			expect(fs.existsSync(path.join(getDerivedDir('web'), now!.file_name!))).toBe(true);
		}
	}, 300_000);
});
