import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';

/**
 * Item 15 **phase 2** — the union rule, and the pruning that has to respect it.
 *
 * The whole design rests on one claim: a blob's derivative set is the *union* of every subscription
 * that reaches it, so two classes asking for different recipes never conflict. The load-bearing
 * consequence — and the easy thing to get wrong — is the inverse: leaving one class must only drop a
 * derivative when **no remaining** subscriber wants it.
 */

let root: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-union-'));
	fs.mkdirSync(path.join(root, 'media', 'files'), { recursive: true });
	fs.mkdirSync(path.join(root, 'media', 'classes'), { recursive: true });
	process.env.MEDIA_MANAGER_ROOT = root;
	delete process.env.MEDIA_MANAGER_ASSETS_DIR;
	delete process.env.MEDIA_MANAGER_ASSETS_BASE_URL;
});

afterEach(async () => {
	const { waitForIdle } = await import('./queue.js');
	await waitForIdle();
	delete process.env.MEDIA_MANAGER_ROOT;
	fs.rmSync(root, { recursive: true, force: true });
});

/** Write the compression block of `media/settings.json`. */
function writeSettings(presets: unknown[], workspacePresets: string[]) {
	fs.writeFileSync(
		path.join(root, 'media', 'settings.json'),
		JSON.stringify({ compression: { autoCompress: true, presets, workspacePresets } })
	);
}

/** Create a class file with an optional compression subscription. */
function writeClass(id: string, compressionPresets?: string[], members: string[] = []) {
	const records: Record<string, unknown> = {};
	for (const m of members) records[m] = { id: m, last_modified: new Date(0).toISOString() };
	fs.writeFileSync(
		path.join(root, 'media', 'classes', `${id}.json`),
		JSON.stringify({
			schema: {},
			config: { displayName: id, ...(compressionPresets ? { compressionPresets } : {}) },
			records
		})
	);
}

/** A noisy photo of a given size, so WebP genuinely shrinks it and a resize is observable. */
async function seedPhoto(dest: string, width: number, height: number, salt = 1) {
	const raw = Buffer.alloc(width * height * 3);
	let seed = salt * 7919 + 11;
	for (let i = 0; i < raw.length; i += 3) {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		raw[i] = seed % 256;
		raw[i + 1] = (seed >> 8) % 256;
		raw[i + 2] = (seed >> 16) % 256;
	}
	await sharp(raw, { raw: { width, height, channels: 3 } })
		.jpeg({ quality: 95 })
		.toFile(dest);
}

const WEB = { id: 'web', format: 'webp', quality: 80 } as const;
const FINE = { id: 'fine', format: 'webp', quality: 95 } as const;
const THUMB = { id: 'thumb', format: 'webp', quality: 70, width: 400 } as const;

describe('the union rule', () => {
	it('gives a blob in two classes every preset either class asks for, and prunes only what nobody wants', async () => {
		writeSettings([WEB, FINE, THUMB], ['web']);
		await seedPhoto(path.join(root, 'media', 'files', 'photo.jpg'), 1200, 900);

		const { registerBlob, addMembers, removeMembers } = await import('$lib/storage/classRepo.js');
		const { scheduleCompression, waitForIdle } = await import('./queue.js');
		const { readManifest } = await import('$lib/storage/manifest.js');
		const { getDerivedDir } = await import('$lib/storage/paths.js');

		const id = await registerBlob(
			'photo.jpg',
			fs.statSync(path.join(root, 'media', 'files', 'photo.jpg')).size
		);

		// `photos` wants `fine`; `gallery` wants `thumb`. Both also inherit the workspace's `web`.
		writeClass('photos', ['fine']);
		writeClass('gallery', ['thumb']);
		await addMembers('photos', [id]);
		await addMembers('gallery', [id]);

		scheduleCompression('all');
		await waitForIdle();

		const derivedOf = async () =>
			Object.keys((await readManifest()).files[id].derived ?? {}).sort();
		expect(await derivedOf()).toEqual(['fine', 'thumb', 'web']);

		// Leaving `gallery` must drop `thumb` — nothing else asks for it — but must NOT touch `fine`
		// (still wanted by `photos`) or `web` (the workspace subscription).
		const thumbName = (await readManifest()).files[id].derived!.thumb.file_name!;
		await removeMembers('gallery', [id]);
		scheduleCompression([id]);
		await waitForIdle();

		expect(await derivedOf()).toEqual(['fine', 'web']);
		expect(fs.existsSync(path.join(getDerivedDir('thumb'), thumbName))).toBe(false);
		// The survivors' files are still on disk, not just their records.
		for (const presetId of ['fine', 'web']) {
			const d = (await readManifest()).files[id].derived![presetId];
			expect(fs.existsSync(path.join(getDerivedDir(presetId), d.file_name!)), presetId).toBe(true);
		}
	}, 120_000);

	it('keeps a shared preset when only one of two subscribing classes is left', async () => {
		writeSettings([WEB, FINE], []); // nothing workspace-wide: the classes are the only subscribers
		await seedPhoto(path.join(root, 'media', 'files', 'shared.jpg'), 800, 600, 2);

		const { registerBlob, addMembers, removeMembers } = await import('$lib/storage/classRepo.js');
		const { scheduleCompression, waitForIdle } = await import('./queue.js');
		const { readManifest } = await import('$lib/storage/manifest.js');

		const id = await registerBlob('shared.jpg', 1);
		// BOTH classes subscribe to `fine` — the case a naive "remove this class's presets" would break.
		writeClass('a', ['fine']);
		writeClass('b', ['fine']);
		await addMembers('a', [id]);
		await addMembers('b', [id]);

		scheduleCompression('all');
		await waitForIdle();
		expect(Object.keys((await readManifest()).files[id].derived ?? {})).toEqual(['fine']);

		await removeMembers('a', [id]);
		scheduleCompression([id]);
		await waitForIdle();

		// `b` still wants it, so it must survive.
		const after = (await readManifest()).files[id].derived ?? {};
		expect(Object.keys(after)).toEqual(['fine']);
		expect(after.fine.file_name).toBeTruthy();
	}, 120_000);
});

describe('width-bearing presets', () => {
	it('downscales to the target width, preserves aspect ratio, and scores against a matched-size original', async () => {
		writeSettings([THUMB], ['thumb']);
		await seedPhoto(path.join(root, 'media', 'files', 'wide.jpg'), 1600, 1200, 3);

		const { registerBlob } = await import('$lib/storage/classRepo.js');
		const { scheduleCompression, waitForIdle } = await import('./queue.js');
		const { readManifest } = await import('$lib/storage/manifest.js');
		const { getDerivedDir } = await import('$lib/storage/paths.js');

		const id = await registerBlob('wide.jpg', 1);
		scheduleCompression('all');
		await waitForIdle();

		const d = (await readManifest()).files[id].derived!.thumb;
		expect(d.recipe).toBe('webp:q70:w400');
		expect(d.width).toBe(400);
		expect(d.height).toBe(300); // 1600x1200 → 4:3 preserved
		const meta = await sharp(path.join(getDerivedDir('thumb'), d.file_name!)).metadata();
		expect(meta.width).toBe(400);
		expect(meta.height).toBe(300);

		// The score compares like with like — the original is downscaled to the derivative's size first,
		// so it measures codec loss, not the resize. A resize-vs-original comparison would score terribly.
		expect(d.ssim).not.toBeNull();
		expect(d.ssim!).toBeGreaterThan(0.5);
	}, 120_000);

	it('never upscales a source smaller than the target width', async () => {
		writeSettings([THUMB], ['thumb']);
		await seedPhoto(path.join(root, 'media', 'files', 'small.jpg'), 200, 150, 4);

		const { registerBlob } = await import('$lib/storage/classRepo.js');
		const { scheduleCompression, waitForIdle } = await import('./queue.js');
		const { readManifest } = await import('$lib/storage/manifest.js');

		const id = await registerBlob('small.jpg', 1);
		scheduleCompression('all');
		await waitForIdle();

		const d = (await readManifest()).files[id].derived!.thumb;
		if (d.file_name) expect(d.width).toBe(200);
		else expect(d.skipped).toBe('larger'); // a tiny source may simply grow — also acceptable
	}, 120_000);
});

describe('deleting a preset', () => {
	it('removes its manifest records and its directory, and nothing else', async () => {
		writeSettings([WEB, FINE], ['web', 'fine']);
		await seedPhoto(path.join(root, 'media', 'files', 'a.jpg'), 900, 700, 5);

		const { registerBlob } = await import('$lib/storage/classRepo.js');
		const { scheduleCompression, waitForIdle } = await import('./queue.js');
		const { readManifest, removeDerivedEntries } = await import('$lib/storage/manifest.js');
		const { writeCompressionSettings } = await import('$lib/storage/compressionSettings.js');
		const { sweepDerived } = await import('./sweep.js');
		const { getDerivedDir, getDerivedRootDir } = await import('$lib/storage/paths.js');

		const id = await registerBlob('a.jpg', 1);
		scheduleCompression('all');
		await waitForIdle();
		const webName = (await readManifest()).files[id].derived!.web.file_name!;
		expect(Object.keys((await readManifest()).files[id].derived!).sort()).toEqual(['fine', 'web']);

		// The same sequence the settings PATCH performs when a preset is deleted.
		await writeCompressionSettings({ presets: [WEB], workspacePresets: ['web'] });
		await removeDerivedEntries({ presetId: 'fine' });
		await sweepDerived();

		expect(Object.keys((await readManifest()).files[id].derived!)).toEqual(['web']);
		expect(fs.existsSync(path.join(getDerivedRootDir(), 'fine'))).toBe(false);
		// The surviving preset is untouched — record and bytes.
		expect(fs.existsSync(path.join(getDerivedDir('web'), webName))).toBe(true);
	}, 120_000);
});

describe('FileItem compression summary', () => {
	it('reports the workspace preset savings and the lowest SSIM, and drives the sort keys', async () => {
		writeSettings([WEB, FINE], ['web', 'fine']);
		await seedPhoto(path.join(root, 'media', 'files', 'p.jpg'), 1000, 800, 6);
		fs.writeFileSync(path.join(root, 'media', 'files', 'notes.txt'), 'not an image');

		const { listAllFiles } = await import('$lib/storage/classRepo.js');
		const { scheduleCompression, waitForIdle } = await import('./queue.js');
		const { readManifest } = await import('$lib/storage/manifest.js');

		await listAllFiles();
		scheduleCompression('all');
		await waitForIdle();

		const listed = await listAllFiles();
		const photo = listed.files.find((f) => f.file_name === 'p.jpg')!;
		const txt = listed.files.find((f) => f.file_name === 'notes.txt')!;

		expect(txt.compression).toBeUndefined(); // nothing generated ⇒ no summary at all

		const c = photo.compression!;
		expect(c.presets.sort()).toEqual(['fine', 'web']);
		expect(c.savedPreset).toBe('web'); // the workspace-wide preset, not the first alphabetically

		const derived = (await readManifest()).files[photo.id].derived!;
		const source = derived.web.source_size!;
		expect(c.savedBytes).toBe(source - derived.web.size!);
		expect(c.savedPct).toBeCloseTo(Math.round((c.savedBytes / source) * 1000) / 10, 5);
		// Lowest, not mean or primary — "the worst thing I'm serving for this photo".
		expect(c.ssim).toBe(Math.min(derived.web.ssim!, derived.fine.ssim!));

		// The sort keys read off that summary; the uncompressed .txt sorts last (empty, not zero).
		const bySaved = await listAllFiles({ sortField: 'saved', sortDir: 'desc' });
		expect(bySaved.files[0].file_name).toBe('p.jpg');
		expect(bySaved.files[bySaved.files.length - 1].file_name).toBe('notes.txt');
	}, 120_000);
});
