import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

import { computeSsim } from './ssim.js';
import { generateDerivative } from './generate.js';
import { FLAGGED_SSIM, getJobState, scheduleCompression, waitForIdle } from './queue.js';
import { sweepDerived } from './sweep.js';
import { computeCompressionStats } from './stats.js';
import { readManifest, setDerivedEntries, type DerivedEntry } from '$lib/storage/manifest.js';
import {
	writeCompressionSettings,
	type CompressionPreset,
	type CompressionSettings
} from '$lib/storage/compressionSettings.js';
import { listAllFiles } from '$lib/storage/classRepo.js';

/**
 * Integration tests for the compression pipeline (Item 15): ssim → generate → queue → sweep → stats.
 *
 * These run **real sharp encodes** against real (tiny) images, because the two things most worth
 * protecting cannot be faked:
 *
 * - the **generator rules** — orientation baked in, ICC preserved, originals never touched, a bigger
 *   output discarded — of which orientation/ICC is exactly the class of bug SSIM is blind to, so this
 *   test is the only guard;
 * - the **skip contract** — every skip carries a `recipe`, so a non-image is recorded once and never
 *   re-attempted on the next backfill.
 *
 * The compression queue holds **module-level state**, so every test that schedules work awaits
 * {@link waitForIdle} before asserting, and the teardown does too before removing the workspace.
 */

const web: CompressionPreset = { id: 'web', label: 'Web', format: 'webp', quality: 80 };

let root: string;
let filesDir: string;
let derivedRoot: string;

beforeEach(() => {
	root = path.join(tmpdir(), `mm-compress-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	filesDir = path.join(root, 'media', 'files');
	derivedRoot = path.join(root, 'media', 'derived');
	fs.mkdirSync(filesDir, { recursive: true });
	fs.mkdirSync(path.join(root, 'media', 'classes'), { recursive: true });
	process.env.MEDIA_MANAGER_ROOT = root;
	delete process.env.MEDIA_MANAGER_ASSETS_DIR;
	delete process.env.MEDIA_MANAGER_ASSETS_BASE_URL;
});

afterEach(async () => {
	// The worker is module-level state shared by every test in this file — never pull the workspace out
	// from under a live encode.
	await waitForIdle();
	delete process.env.MEDIA_MANAGER_ASSETS_DIR;
	delete process.env.MEDIA_MANAGER_ASSETS_BASE_URL;
	fs.rmSync(root, { recursive: true, force: true });
});

/* ------------------------------------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------------------------------------ */

/**
 * Deterministic pseudo-random RGB pixels. Noise is deliberate: a flat-colour image compresses so well
 * that "smaller than the original" assertions stop being meaningful.
 */
function noise(width: number, height: number): sharp.Sharp {
	const buf = Buffer.alloc(width * height * 3);
	let s = 12345;
	for (let i = 0; i < buf.length; i++) {
		s = (s * 1103515245 + 12345) & 0x7fffffff;
		buf[i] = (s >> 16) & 0xff;
	}
	return sharp(buf, { raw: { width, height, channels: 3 } });
}

/** Write a noisy JPEG blob and return its bytes. */
async function writeJpeg(name: string, width = 160, height = 120): Promise<Buffer> {
	const buf = await noise(width, height).jpeg({ quality: 90 }).toBuffer();
	fs.writeFileSync(path.join(filesDir, name), buf);
	return buf;
}

/** Write a noisy PNG blob and return its bytes. */
async function writePng(name: string, width = 160, height = 120): Promise<Buffer> {
	const buf = await noise(width, height).png().toBuffer();
	fs.writeFileSync(path.join(filesDir, name), buf);
	return buf;
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Absolute path of a derivative under the classic derived root. */
const derivedPath = (presetId: string, name: string) => path.join(derivedRoot, presetId, name);

/** Seed `media/manifest.json` directly (for the read-only consumers: sweep + stats). */
function seedManifest(files: Record<string, unknown>): void {
	fs.writeFileSync(
		path.join(root, 'media', 'manifest.json'),
		JSON.stringify({ version: 2, files }, null, 2)
	);
}

/** Write a placeholder file under `media/derived/<preset>/<name>`. */
function seedDerivedFile(presetId: string, name: string, bytes = 'derived-bytes'): void {
	fs.mkdirSync(path.join(derivedRoot, presetId), { recursive: true });
	fs.writeFileSync(derivedPath(presetId, name), bytes);
}

/* ------------------------------------------------------------------------------------------------ *
 * ssim.ts
 * ------------------------------------------------------------------------------------------------ */

describe('computeSsim', () => {
	it('scores an image against itself as a perfect 1', async () => {
		await writeJpeg('a.jpg');
		const p = path.join(filesDir, 'a.jpg');
		expect(await computeSsim(p, p)).toBe(1);
	});

	it('scores a lossy derivative inside (0, 1] and to three decimals', async () => {
		await writeJpeg('a.jpg', 200, 150);
		const src = path.join(filesDir, 'a.jpg');
		const out = path.join(root, 'out.webp');
		await sharp(src).rotate().keepMetadata().webp({ quality: 30 }).toFile(out);

		const score = await computeSsim(src, out);
		expect(score).not.toBeNull();
		expect(score!).toBeGreaterThan(0);
		expect(score!).toBeLessThanOrEqual(1);
		// Three decimals is the stored precision.
		expect(Math.round(score! * 1000)).toBe(score! * 1000);
	});

	it('ranks a higher-quality encode above a lower-quality one', async () => {
		await writeJpeg('a.jpg', 200, 150);
		const src = path.join(filesDir, 'a.jpg');
		await sharp(src).rotate().webp({ quality: 95 }).toFile(path.join(root, 'hi.webp'));
		await sharp(src).rotate().webp({ quality: 10 }).toFile(path.join(root, 'lo.webp'));

		const hi = await computeSsim(src, path.join(root, 'hi.webp'));
		const lo = await computeSsim(src, path.join(root, 'lo.webp'));
		expect(hi!).toBeGreaterThan(lo!);
	});

	it('returns null (never throws) when an image cannot be decoded', async () => {
		await writeJpeg('a.jpg');
		const src = path.join(filesDir, 'a.jpg');
		expect(await computeSsim(src, path.join(root, 'does-not-exist.webp'))).toBeNull();
		fs.writeFileSync(path.join(root, 'garbage.webp'), 'not an image at all');
		expect(await computeSsim(src, path.join(root, 'garbage.webp'))).toBeNull();
	});
});

/* ------------------------------------------------------------------------------------------------ *
 * generate.ts
 * ------------------------------------------------------------------------------------------------ */

describe('generateDerivative', () => {
	it('produces a smaller webp with a recipe, source_size, ssim and the derivative dimensions', async () => {
		const src = await writeJpeg('photo.jpg', 200, 150);
		const originalHash = sha(src);

		const entry = await generateDerivative({
			fileId: 'id-1',
			fileName: 'photo.jpg',
			preset: web,
			derivedName: 'photo.webp'
		});

		expect(entry.skipped).toBeUndefined();
		expect(entry.file_name).toBe('photo.webp');
		expect(entry.recipe).toBe('webp:q80');
		expect(entry.source_size).toBe(src.length);
		expect(entry.size).toBeLessThan(src.length);
		expect(entry.width).toBe(200);
		expect(entry.height).toBe(150);
		expect(entry.ssim).toBeGreaterThan(0);
		expect(entry.ssim!).toBeLessThanOrEqual(1);
		expect(entry.generated_at).toBeTruthy();

		// The recorded size is the real one on disk.
		expect(fs.statSync(derivedPath('web', 'photo.webp')).size).toBe(entry.size);
		// Rule 1: originals are never touched.
		expect(sha(fs.readFileSync(path.join(filesDir, 'photo.jpg')))).toBe(originalHash);
		// No temp file survives a successful encode.
		expect(fs.readdirSync(path.join(derivedRoot, 'web'))).toEqual(['photo.webp']);
	});

	it('honours a width-bearing preset without upscaling a smaller source', async () => {
		await writeJpeg('photo.jpg', 200, 150);
		const narrow = await generateDerivative({
			fileId: 'id-1',
			fileName: 'photo.jpg',
			preset: { id: 'thumb', format: 'webp', quality: 70, width: 100 },
			derivedName: 'photo.webp'
		});
		expect(narrow.width).toBe(100);
		expect(narrow.height).toBe(75);
		expect(narrow.recipe).toBe('webp:q70:w100');

		const wide = await generateDerivative({
			fileId: 'id-1',
			fileName: 'photo.jpg',
			preset: { id: 'big', format: 'webp', quality: 70, width: 4000 },
			derivedName: 'photo.webp'
		});
		// `withoutEnlargement`: a 4000px preset over a 200px source stays 200px (or is discarded as larger).
		if (!wide.skipped) expect(wide.width).toBe(200);
	});

	it('records an unsupported source as a skip WITH a recipe, writing nothing', async () => {
		fs.writeFileSync(path.join(filesDir, 'doc.pdf'), '%PDF-1.4 not really a pdf');

		const entry = await generateDerivative({
			fileId: 'id-1',
			fileName: 'doc.pdf',
			preset: web,
			derivedName: '' // planWork resolves no name for a file it will not attempt
		});

		expect(entry).toEqual({ recipe: 'webp:q80', skipped: 'unsupported' });
		// A skip with no recipe would mismatch every preset and be retried on every backfill forever.
		expect(entry.recipe).toBe('webp:q80');
		expect(entry.file_name).toBeUndefined();
		expect(fs.existsSync(derivedRoot)).toBe(false);
	});

	it('discards a derivative that grew under re-encode and leaves no file behind', async () => {
		// A flat 64×64 PNG is already tiny; a lossy webp of it comes out bigger.
		const flat = await sharp({
			create: { width: 64, height: 64, channels: 3, background: { r: 10, g: 20, b: 30 } }
		})
			.png()
			.toBuffer();
		fs.writeFileSync(path.join(filesDir, 'flat.png'), flat);
		// A previous (now superseded) derivative must be removed too — the manifest is about to stop
		// claiming it.
		seedDerivedFile('web', 'flat.webp', 'stale-previous-derivative');

		const entry = await generateDerivative({
			fileId: 'id-1',
			fileName: 'flat.png',
			preset: web,
			derivedName: 'flat.webp'
		});

		expect(entry.skipped).toBe('larger');
		expect(entry.recipe).toBe('webp:q80');
		expect(entry.source_size).toBe(flat.length);
		expect(entry.file_name).toBeUndefined();
		expect(fs.existsSync(derivedPath('web', 'flat.webp'))).toBe(false);
		expect(fs.readdirSync(path.join(derivedRoot, 'web'))).toEqual([]); // no temp file either
	});

	it('turns an encoder failure into skipped:error instead of throwing (one corrupt file cannot abort a backfill)', async () => {
		fs.writeFileSync(path.join(filesDir, 'broken.jpg'), 'this is not a jpeg');

		const entry = await generateDerivative({
			fileId: 'id-1',
			fileName: 'broken.jpg',
			preset: web,
			derivedName: 'broken.webp'
		});

		expect(entry.skipped).toBe('error');
		expect(entry.recipe).toBe('webp:q80');
		expect(fs.existsSync(derivedPath('web', 'broken.webp'))).toBe(false);
	});

	it('records a skip for a source that is not there at all', async () => {
		const entry = await generateDerivative({
			fileId: 'id-1',
			fileName: 'ghost.jpg',
			preset: web,
			derivedName: 'ghost.webp'
		});
		expect(entry.skipped).toBe('error');
		expect(entry.recipe).toBe('webp:q80');
	});

	/**
	 * Orientation + ICC — the failure SSIM is blind to.
	 *
	 * A phone photo stores its pixels un-rotated plus an EXIF orientation tag. A derivative that copies
	 * the pixels and drops the tag renders sideways while still scoring ~0.99, so this is a generator
	 * rule with a test, not something the quality metric can be trusted to catch.
	 */
	it('bakes EXIF orientation into the pixels (resetting the tag) and preserves the ICC profile', async () => {
		const oriented = await noise(40, 20)
			.jpeg({ quality: 90 })
			.withMetadata({ orientation: 6 }) // 90° CW: stored 40×20, displays 20×40
			.toBuffer();
		fs.writeFileSync(path.join(filesDir, 'rotated.jpg'), oriented);

		const srcMeta = await sharp(oriented).metadata();
		expect([srcMeta.width, srcMeta.height]).toEqual([40, 20]);
		expect(srcMeta.orientation).toBe(6);
		expect(srcMeta.icc).toBeDefined();

		const entry = await generateDerivative({
			fileId: 'id-1',
			fileName: 'rotated.jpg',
			preset: web,
			derivedName: 'rotated.webp'
		});
		expect(entry.skipped).toBeUndefined();

		const outMeta = await sharp(derivedPath('web', 'rotated.webp')).metadata();
		// The derivative's stored pixels are already rotated — it displays the same way up as the original…
		expect([outMeta.width, outMeta.height]).toEqual([20, 40]);
		// …and its tag is reset, so a viewer that honours EXIF cannot rotate it a second time.
		expect(outMeta.orientation ?? 1).toBe(1);
		// Colour survives: a luma SSIM would never notice a dropped profile.
		expect(outMeta.icc).toBeDefined();

		// The recorded dimensions describe the derivative, not the original.
		expect(entry.width).toBe(20);
		expect(entry.height).toBe(40);
	});
});

/* ------------------------------------------------------------------------------------------------ *
 * queue.ts
 * ------------------------------------------------------------------------------------------------ */

describe('compression queue', () => {
	it('backfills every compressible blob and records consistent counters + manifest entries', async () => {
		const a = await writeJpeg('a.jpg');
		const b = await writeJpeg('b.jpg', 120, 90);
		const c = await writePng('c.png', 120, 90);
		fs.writeFileSync(path.join(filesDir, 'doc.pdf'), '%PDF-1.4 not really a pdf');
		await listAllFiles(); // mint ids + backfill sizes, exactly as a grid read would

		scheduleCompression('all');
		await waitForIdle();

		const job = getJobState();
		expect(job.running).toBe(false);
		expect(job.error).toBeNull();
		expect(job.total).toBe(4);
		expect(job.done).toBe(4);
		expect(job.generated).toBe(3);
		expect(job.skipped).toBe(1);
		expect(job.finishedAt).toBeTruthy();

		const manifest = await readManifest();
		const byName = Object.fromEntries(
			Object.values(manifest.files).map((e) => [e.file_name, e.derived?.web])
		);
		// Every blob got a record — generated or skipped — and every record carries the recipe.
		expect(Object.keys(byName).sort()).toEqual(['a.jpg', 'b.jpg', 'c.png', 'doc.pdf']);
		for (const d of Object.values(byName)) expect(d?.recipe).toBe('webp:q80');
		expect(byName['doc.pdf']?.skipped).toBe('unsupported');

		let savedOnDisk = 0;
		for (const [name, source] of [
			['a.jpg', a],
			['b.jpg', b],
			['c.png', c]
		] as const) {
			const d = byName[name]!;
			expect(d.skipped).toBeUndefined();
			expect(d.source_size).toBe(source.length);
			const stat = fs.statSync(derivedPath('web', d.file_name!));
			expect(stat.size).toBe(d.size);
			expect(stat.size).toBeLessThan(source.length);
			savedOnDisk += source.length - stat.size;
		}
		// The headline number is exactly what the bytes on disk say.
		expect(job.savedBytes).toBe(savedOnDisk);
		expect(job.flagged).toBe(
			[a, b, c].filter((_, i) => {
				const d = byName[(['a.jpg', 'b.jpg', 'c.png'] as const)[i]]!;
				return d.ssim != null && d.ssim < FLAGGED_SSIM;
			}).length
		);
	});

	it('does no work on a second run when nothing is stale', async () => {
		await writeJpeg('a.jpg');
		await listAllFiles();
		scheduleCompression('all');
		await waitForIdle();
		expect(getJobState().generated).toBe(1);
		const generatedAt = (await readManifest()).files;
		const firstStamp = Object.values(generatedAt)[0].derived?.web.generated_at;

		scheduleCompression('all');
		await waitForIdle();

		const job = getJobState();
		expect(job.total).toBe(0);
		expect(job.done).toBe(0);
		expect(job.generated).toBe(0);
		expect(job.skipped).toBe(0);
		// Nothing was rewritten.
		expect(Object.values((await readManifest()).files)[0].derived?.web.generated_at).toBe(
			firstStamp
		);
	});

	it('never retries a recorded skip', async () => {
		fs.writeFileSync(path.join(filesDir, 'doc.pdf'), '%PDF-1.4 not really a pdf');
		await listAllFiles();

		scheduleCompression('all');
		await waitForIdle();
		expect(getJobState()).toMatchObject({ total: 1, done: 1, generated: 0, skipped: 1 });

		scheduleCompression('all');
		await waitForIdle();
		// The second pass planned no work at all — that is what recording the skip's recipe buys.
		expect(getJobState()).toMatchObject({ total: 0, done: 0, skipped: 0 });
	});

	it('regenerates when the preset recipe changes, but not when only its label does', async () => {
		await writeJpeg('a.jpg');
		await listAllFiles();
		await writeCompressionSettings({ presets: [web], workspacePresets: ['web'] });
		scheduleCompression('all');
		await waitForIdle();
		expect(getJobState().generated).toBe(1);

		// Label-only edit ⇒ same recipe ⇒ no regeneration.
		await writeCompressionSettings({ presets: [{ ...web, label: 'Website hero' }] });
		scheduleCompression('all');
		await waitForIdle();
		expect(getJobState().total).toBe(0);

		// Quality change ⇒ new recipe ⇒ exactly one regeneration.
		await writeCompressionSettings({ presets: [{ ...web, quality: 55 }] });
		scheduleCompression('all');
		await waitForIdle();
		expect(getJobState()).toMatchObject({ total: 1, generated: 1 });
		expect(Object.values((await readManifest()).files)[0].derived?.web.recipe).toBe('webp:q55');
	});

	it('generates only for the ids it was given', async () => {
		await writeJpeg('a.jpg');
		await writeJpeg('b.jpg');
		const files = (await listAllFiles()).files;
		const aId = files.find((f) => f.file_name === 'a.jpg')!.id;

		scheduleCompression([aId]);
		await waitForIdle();

		expect(getJobState()).toMatchObject({ total: 1, generated: 1 });
		const manifest = await readManifest();
		expect(manifest.files[aId].derived?.web.file_name).toBe('a.webp');
		const bId = files.find((f) => f.file_name === 'b.jpg')!.id;
		expect(manifest.files[bId].derived).toBeUndefined();
	});

	it('gives two originals sharing a stem two distinct derivative files', async () => {
		await writeJpeg('photo.jpg');
		await writePng('photo.png');
		await listAllFiles();

		scheduleCompression('all');
		await waitForIdle();

		const manifest = await readManifest();
		const names = Object.values(manifest.files).map((e) => e.derived?.web.file_name);
		expect(names.filter(Boolean)).toHaveLength(2);
		expect(new Set(names).size).toBe(2);
		for (const n of names) expect(fs.existsSync(derivedPath('web', n!))).toBe(true);
	});

	it('restores equivalent derivatives after media/derived/ is deleted (regenerable by a backfill)', async () => {
		await writeJpeg('a.jpg');
		await writeJpeg('b.jpg', 120, 90);
		await listAllFiles();
		scheduleCompression('all');
		await waitForIdle();

		const before = Object.fromEntries(
			Object.entries((await readManifest()).files).map(([id, e]) => [id, e.derived!.web])
		);
		expect(Object.keys(before)).toHaveLength(2);

		// Derivatives are generated, never authored — deleting the tree must always be recoverable.
		fs.rmSync(derivedRoot, { recursive: true, force: true });
		scheduleCompression('all');
		await waitForIdle();

		// Root cause if this fails: staleness is decided purely from the manifest record (recipe +
		// source_size) and never consults the filesystem, so a derivative whose file was deleted still
		// looks up to date and is never re-planned.
		expect(getJobState().total).toBe(2);

		const after = Object.fromEntries(
			Object.entries((await readManifest()).files).map(([id, e]) => [id, e.derived!.web])
		);
		for (const [id, d] of Object.entries(before)) {
			expect(fs.existsSync(derivedPath('web', d.file_name!))).toBe(true);
			// NOT "identical state" — `generated_at` necessarily differs.
			expect(after[id].size).toBe(d.size);
			expect(after[id].ssim).toBe(d.ssim);
			expect(after[id].recipe).toBe(d.recipe);
			expect(after[id].file_name).toBe(d.file_name);
		}
	});

	it('does nothing when the workspace subscribes to no preset', async () => {
		await writeJpeg('a.jpg');
		await listAllFiles();
		await writeCompressionSettings({ presets: [web], workspacePresets: [] });

		scheduleCompression('all');
		await waitForIdle();

		expect(getJobState()).toMatchObject({ total: 0, done: 0 });
		expect(fs.existsSync(derivedRoot)).toBe(false);
	});
});

/* ------------------------------------------------------------------------------------------------ *
 * sweep.ts
 * ------------------------------------------------------------------------------------------------ */

describe('sweepDerived', () => {
	beforeEach(() => {
		seedManifest({
			a: {
				file_name: 'a.jpg',
				classes: [],
				missing: false,
				derived: { web: { file_name: 'a.webp', recipe: 'webp:q80', size: 13 } }
			}
		});
	});

	it('removes an orphan and never a manifest-referenced file', async () => {
		seedDerivedFile('web', 'a.webp'); // referenced
		seedDerivedFile('web', 'orphan.webp', 'leftover-from-a-rename');

		const result = await sweepDerived();

		expect(result.removed).toEqual(['web/orphan.webp']);
		expect(result.bytes).toBeGreaterThan(0);
		expect(result.removedPresetDirs).toEqual([]);
		expect(fs.existsSync(derivedPath('web', 'orphan.webp'))).toBe(false);
		expect(fs.existsSync(derivedPath('web', 'a.webp'))).toBe(true);
	});

	it('dryRun reports without deleting anything', async () => {
		seedDerivedFile('web', 'a.webp');
		seedDerivedFile('web', 'orphan.webp', 'leftover');

		const dry = await sweepDerived({ dryRun: true });

		expect(dry.removed).toEqual(['web/orphan.webp']);
		expect(dry.bytes).toBe('leftover'.length);
		expect(fs.existsSync(derivedPath('web', 'orphan.webp'))).toBe(true);

		// The real run then removes exactly what the dry run promised.
		const wet = await sweepDerived();
		expect(wet.removed).toEqual(dry.removed);
		expect(fs.existsSync(derivedPath('web', 'orphan.webp'))).toBe(false);
	});

	it('drops a directory for an unknown preset wholesale', async () => {
		seedDerivedFile('web', 'a.webp');
		seedDerivedFile('legacy', 'a.webp', 'from-a-deleted-preset');
		seedDerivedFile('legacy', 'b.webp', 'from-a-deleted-preset');

		const result = await sweepDerived();

		expect(result.removedPresetDirs).toEqual(['legacy']);
		expect(result.removed.sort()).toEqual(['legacy/a.webp', 'legacy/b.webp']);
		expect(fs.existsSync(path.join(derivedRoot, 'legacy'))).toBe(false);
		// The live preset's referenced file is untouched.
		expect(fs.existsSync(derivedPath('web', 'a.webp'))).toBe(true);
	});

	it('is an empty no-op when there is no derived tree at all', async () => {
		const result = await sweepDerived();
		expect(result).toEqual({ removed: [], bytes: 0, removedPresetDirs: [] });
	});

	it('never touches anything outside derived/', async () => {
		seedDerivedFile('web', 'orphan.webp', 'leftover');
		await sweepDerived();
		expect(fs.existsSync(path.join(root, 'media', 'manifest.json'))).toBe(true);
		expect(fs.existsSync(filesDir)).toBe(true);
	});
});

/* ------------------------------------------------------------------------------------------------ *
 * stats.ts
 * ------------------------------------------------------------------------------------------------ */

describe('computeCompressionStats', () => {
	const settings: CompressionSettings = {
		autoCompress: true,
		presets: [web],
		workspacePresets: ['web']
	};

	/** One generated derivative record. */
	const gen = (name: string, size: number, sourceSize: number, ssim: number): DerivedEntry => ({
		file_name: name,
		size,
		recipe: 'webp:q80',
		source_size: sourceSize,
		ssim
	});

	beforeEach(() => {
		seedManifest({
			f1: {
				file_name: 'a.jpg',
				classes: ['gallery'],
				missing: false,
				size: 1000,
				derived: { web: gen('a.webp', 400, 1000, 0.998) }
			},
			f2: {
				file_name: 'b.jpg',
				classes: ['gallery', 'docs'],
				missing: false,
				size: 2000,
				derived: { web: gen('b.webp', 1000, 2000, 0.93) }
			},
			f3: {
				file_name: 'c.png',
				classes: [],
				missing: false,
				size: 500,
				derived: { web: gen('c.webp', 400, 500, 0.9) }
			},
			f4: {
				file_name: 'd.pdf',
				classes: [],
				missing: false,
				size: 300,
				derived: { web: { recipe: 'webp:q80', skipped: 'unsupported' } }
			},
			f5: {
				file_name: 'e.png',
				classes: [],
				missing: false,
				size: 100,
				derived: { web: { recipe: 'webp:q80', skipped: 'larger' } }
			},
			f6: { file_name: 'f.jpg', classes: [], missing: false, size: 700 },
			f7: { file_name: 'g.mp4', classes: [], missing: false, size: 900 },
			f8: { file_name: 'gone.jpg', classes: [], missing: true, size: 50 }
		});
	});

	it('counts coverage, splitting pending from genuinely uncompressible', async () => {
		const stats = await computeCompressionStats(settings);

		expect(stats.totalFiles).toBe(7); // the `missing` blob is excluded
		expect(stats.coveredFiles).toBe(3); // a.jpg, b.jpg, c.png
		expect(stats.uncompressibleFiles).toBe(3); // d.pdf + e.png (grew) + g.mp4
		expect(stats.pendingFiles).toBe(1); // f.jpg — compressible, no derivative yet
		// "Stale" is a derivative that *exists* and is out of date. A blob that was never generated is
		// `pendingFiles`, not stale — counting it as both would double it in "N files to do".
		expect(stats.staleDerivatives).toBe(0);
	});

	it('counts an out-of-date derivative as stale without moving it out of coverage', async () => {
		// The preset's quality changed: all three generated records now mismatch the current recipe.
		const stats = await computeCompressionStats({
			...settings,
			presets: [{ ...web, quality: 55 }]
		});

		// 3 generated records + the 2 recorded skips: a skip is scoped to the recipe it was taken under,
		// so a new recipe legitimately re-attempts it.
		expect(stats.staleDerivatives).toBe(5);
		// The generated ones are still real files on disk, so they still count as covered — stale, not absent.
		expect(stats.coveredFiles).toBe(3);
		expect(stats.pendingFiles).toBe(1);
	});

	it('reports per-preset savings and the median quality', async () => {
		const stats = await computeCompressionStats(settings);

		expect(stats.perPreset).toHaveLength(1);
		expect(stats.headline).toEqual({
			presetId: 'web',
			label: 'Web',
			recipe: 'webp:q80',
			generated: 3,
			originalBytes: 3500,
			derivedBytes: 1800,
			savedBytes: 1700,
			medianSsim: 0.93,
			resized: false
		});
	});

	it('buckets the histogram by score and orders the flagged list ascending (worst first)', async () => {
		const stats = await computeCompressionStats(settings);

		expect(stats.histogram).toEqual([
			{ key: 'identical', label: 'identical', count: 1 }, // 0.998
			{ key: 'imperceptible', label: 'imperceptible', count: 0 },
			{ key: 'excellent', label: 'excellent', count: 0 },
			{ key: 'slight', label: 'slight', count: 0 },
			{ key: 'visible', label: 'visible', count: 2 } // 0.93 + 0.90, both under 0.94
		]);
		expect(stats.medianSsim).toBe(0.93);

		expect(stats.flaggedCount).toBe(2);
		expect(stats.flagged.map((f) => f.ssim)).toEqual([0.9, 0.93]);
		expect(stats.flagged[0]).toEqual({
			fileId: 'f3',
			fileName: 'c.png',
			presetId: 'web',
			originalSize: 500,
			derivedSize: 400,
			ssim: 0.9
		});
		// Everything flagged really is below the threshold.
		for (const f of stats.flagged) expect(f.ssim).toBeLessThan(FLAGGED_SSIM);
	});

	it('attributes savings to every owning class, with an unclassified row', async () => {
		const stats = await computeCompressionStats(settings);

		// A blob in two classes counts toward both — overlap is intentional in this data model.
		expect(stats.byClass).toEqual([
			{ classId: 'gallery', savedBytes: 1600, files: 2 },
			{ classId: 'docs', savedBytes: 1000, files: 1 },
			{ classId: '__unclassified', savedBytes: 100, files: 1 }
		]);
	});

	it('groups what cannot be compressed by reason', async () => {
		const stats = await computeCompressionStats(settings);
		const groups = [...stats.uncompressible].sort((a, b) => a.key.localeCompare(b.key));

		// `unsupported` groups by extension (a statement about the file type); `larger` is a reason in its
		// own right. The label is presentation, so it is matched loosely — the key/count/examples are the
		// contract.
		expect(groups.map(({ key, count, examples }) => ({ key, count, examples }))).toEqual([
			{ key: '.pdf', count: 1, examples: ['d.pdf'] },
			{ key: 'larger', count: 1, examples: ['e.png'] }
		]);
		expect(groups[0].label).toMatch(/pdf/i);
		expect(groups[1].label).toMatch(/grew|larger/i);
	});

	it('does not crash on an empty workspace', async () => {
		seedManifest({});
		const stats = await computeCompressionStats(settings);

		expect(stats.totalFiles).toBe(0);
		expect(stats.coveredFiles).toBe(0);
		expect(stats.pendingFiles).toBe(0);
		expect(stats.medianSsim).toBeNull();
		expect(stats.flagged).toEqual([]);
		expect(stats.byClass).toEqual([]);
		expect(stats.headline).toMatchObject({ presetId: 'web', generated: 0, savedBytes: 0 });
	});

	it('does not crash when no preset is subscribed', async () => {
		const stats = await computeCompressionStats({ ...settings, workspacePresets: [] });

		expect(stats.perPreset).toEqual([]);
		expect(stats.headline).toBeNull();
		expect(stats.coveredFiles).toBe(0);
		expect(stats.flagged).toEqual([]);
		expect(stats.byClass).toEqual([]);
		// With nothing subscribed every blob is simply classified by whether it *could* be compressed.
		expect(stats.totalFiles).toBe(7);
		expect(stats.pendingFiles + stats.uncompressibleFiles).toBe(7);
	});

	it('reads the workspace settings when none are passed', async () => {
		await writeCompressionSettings({ presets: [web], workspacePresets: ['web'] });
		const stats = await computeCompressionStats();
		expect(stats.headline?.presetId).toBe('web');
		expect(stats.coveredFiles).toBe(3);
	});
});

/* ------------------------------------------------------------------------------------------------ *
 * A cross-module guard: the derivative records the queue writes must survive an unrelated blob write.
 * ------------------------------------------------------------------------------------------------ */

describe('generated derivatives survive later manifest writes', () => {
	it('a real backfill followed by a listing keeps every derived record', async () => {
		await writeJpeg('a.jpg');
		await listAllFiles();
		scheduleCompression('all');
		await waitForIdle();

		const before = Object.values((await readManifest()).files)[0].derived;
		expect(before?.web.file_name).toBe('a.webp');

		// A grid read heals dimensions/sizes and can rewrite the manifest.
		fs.writeFileSync(path.join(filesDir, 'newcomer.txt'), 'hello');
		await listAllFiles();
		await setDerivedEntries(new Map()); // an empty batch must be a no-op, not a wipe

		const after = Object.values((await readManifest()).files).find(
			(e) => e.file_name === 'a.jpg'
		)?.derived;
		expect(after).toEqual(before);
	});
});
