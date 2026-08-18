import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import {
	mintFileId,
	renameFileId,
	removeFileId,
	reconcile,
	readManifest,
	getEntryDimensions,
	setBlobDimensions,
	getFilenameForFileId,
	availableFromManifest,
	missingFileFields,
	missingFilesMap,
	getAvailableFileIds,
	setClassMembership,
	setEntryDimensions,
	setEntrySizes,
	setDerivedEntries,
	removeDerivedEntries,
	renameDerivedEntries,
	type DerivedEntry
} from './manifest.js';
import type { SchemaDefinition } from '$lib/core/types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('global blob manifest', () => {
	beforeEach(() => {
		const root = path.join(
			tmpdir(),
			`mm-manifest-test-${Date.now()}-${Math.random().toString(16).slice(2)}`
		);
		fs.mkdirSync(path.join(root, 'media', 'files'), { recursive: true });
		process.env.MEDIA_MANAGER_ROOT = root;
	});

	it('mintFileId is idempotent by name', async () => {
		const a = await mintFileId('photo.png');
		const b = await mintFileId('photo.png');
		expect(a).toBe(b);
		expect(UUID_RE.test(a)).toBe(true);
		const other = await mintFileId('other.png');
		expect(other).not.toBe(a);
	});

	it('renameFileId changes the name only, keeping the id stable', async () => {
		const id = await mintFileId('old.png');
		await renameFileId(id, 'new.png');
		expect(await getFilenameForFileId(id)).toBe('new.png');
		const manifest = await readManifest();
		expect(Object.keys(manifest.files)).toContain(id);
		expect(manifest.files[id].file_name).toBe('new.png');
	});

	it('renameFileId throws on an unknown id', async () => {
		await expect(renameFileId('00000000-0000-4000-8000-000000000000', 'x.png')).rejects.toThrow();
	});

	it('removeFileId deletes the entry', async () => {
		const id = await mintFileId('gone.png');
		await removeFileId(id);
		expect(await getFilenameForFileId(id)).toBeNull();
	});

	it('reconcile mints ids for new disk files and flags (without deleting) missing ones', async () => {
		const keep = await mintFileId('keep.png');

		// "missing.png" exists in the manifest but not on disk; "fresh.png" is new on disk.
		await mintFileId('missing.png');
		const result = await reconcile(['keep.png', 'fresh.png']);

		expect(result.added.map((a) => a.file_name)).toEqual(['fresh.png']);
		expect(result.missing.map((m) => m.file_name)).toContain('missing.png');

		// Missing entry is flagged, not removed.
		expect(await getFilenameForFileId(result.missing[0].file_id)).toBe('missing.png');
		// Existing id is unchanged; new id was minted.
		expect(await getFilenameForFileId(keep)).toBe('keep.png');
		const fresh = result.added[0].file_id;
		expect(UUID_RE.test(fresh)).toBe(true);
		expect(await getFilenameForFileId(fresh)).toBe('fresh.png');
	});

	it('reconcile is idempotent (no double-mint for an already-known name)', async () => {
		const first = await reconcile(['a.png']);
		const second = await reconcile(['a.png']);
		expect(first.added).toHaveLength(1);
		expect(second.added).toHaveLength(0);
		// The single id maps a.png across both runs.
		const m = await readManifest();
		expect(Object.values(m.files).filter((e) => e.file_name === 'a.png')).toHaveLength(1);
	});
});

describe('blob dimensions (Item 13)', () => {
	beforeEach(() => {
		const root = path.join(
			tmpdir(),
			`mm-dims-test-${Date.now()}-${Math.random().toString(16).slice(2)}`
		);
		fs.mkdirSync(path.join(root, 'media', 'files'), { recursive: true });
		process.env.MEDIA_MANAGER_ROOT = root;
	});

	it('getEntryDimensions returns undefined dims for a fresh blob and unknown ids', async () => {
		const id = await mintFileId('photo.jpg');
		expect(await getEntryDimensions(id)).toEqual({ width: undefined, height: undefined });
		expect(await getEntryDimensions('does-not-exist')).toEqual({
			width: undefined,
			height: undefined
		});
	});

	it('setBlobDimensions persists exactly the two numbers and getEntryDimensions reads them back', async () => {
		const id = await mintFileId('photo.jpg');
		await setBlobDimensions(id, { width: 3000, height: 4000 });
		expect(await getEntryDimensions(id)).toEqual({ width: 3000, height: 4000 });
		const entry = (await readManifest()).files[id];
		// Nothing else on the entry is disturbed by the dimension write.
		expect(entry.file_name).toBe('photo.jpg');
		expect(entry.classes).toEqual([]);
	});

	it('setBlobDimensions overwrites previously stored dims (a deliberate correction, unlike backfill)', async () => {
		const id = await mintFileId('photo.jpg');
		await setBlobDimensions(id, { width: 4000, height: 3000 });
		await setBlobDimensions(id, { width: 3000, height: 4000 });
		expect(await getEntryDimensions(id)).toEqual({ width: 3000, height: 4000 });
	});

	it('setBlobDimensions throws on an unknown id', async () => {
		await expect(
			setBlobDimensions('00000000-0000-4000-8000-000000000000', { width: 1, height: 1 })
		).rejects.toThrow();
	});
});

describe('missing-file detection helpers', () => {
	const schema = {
		caption: { type: 'string' },
		attachment: { type: 'file' },
		other_file: { type: 'file' }
	} as unknown as SchemaDefinition;

	beforeEach(() => {
		const root = path.join(
			tmpdir(),
			`mm-missing-test-${Date.now()}-${Math.random().toString(16).slice(2)}`
		);
		fs.mkdirSync(path.join(root, 'media', 'files'), { recursive: true });
		process.env.MEDIA_MANAGER_ROOT = root;
	});

	it('availableFromManifest keeps only ids whose blob is on disk', () => {
		const manifest = {
			version: 2 as const,
			files: {
				a: { file_name: 'a.png', classes: [], missing: false },
				b: { file_name: 'b.png', classes: [], missing: false }
			}
		};
		const available = availableFromManifest(manifest, new Set(['a.png']));
		expect(available.has('a')).toBe(true);
		expect(available.has('b')).toBe(false);
	});

	it('missingFileFields flags only broken file refs, ignoring non-file/empty values', () => {
		const available = new Set(['present-id']);
		const record = {
			caption: 'a present-id-looking string but not a file field',
			attachment: 'present-id',
			other_file: 'gone-id',
			empty_file: ''
		};
		expect(missingFileFields(record, schema, available)).toEqual(['other_file']);

		// An empty file value is not "missing".
		const blank = { attachment: '', other_file: '' };
		expect(missingFileFields(blank, schema, available)).toEqual([]);
	});

	it('missingFilesMap maps broken fields to expected filename (or "" for a dangling id)', () => {
		const manifest = {
			version: 2 as const,
			files: { 'vanished-id': { file_name: 'vanished.png', classes: [], missing: false } }
		};
		const available = new Set<string>(); // nothing on disk
		const record = { attachment: 'vanished-id', other_file: 'never-registered' };
		const map = missingFilesMap(record, schema, manifest, available);
		expect(map).toEqual({ attachment: 'vanished.png', other_file: '' });
	});

	it('missingFilesMap returns undefined when nothing is broken', () => {
		const available = new Set(['ok-id']);
		const record = { attachment: 'ok-id' };
		expect(missingFilesMap(record, schema, { version: 2, files: {} }, available)).toBeUndefined();
	});

	it('getAvailableFileIds reflects disk: a minted-but-absent blob is not available', async () => {
		// One real blob on disk, one manifest entry whose file was deleted.
		fs.writeFileSync(
			path.join(process.env.MEDIA_MANAGER_ROOT!, 'media', 'files', 'on-disk.png'),
			'x'
		);
		const goneId = await mintFileId('off-disk.png'); // registered, but no file written

		const { available } = await getAvailableFileIds();

		// The vanished blob is not available; the on-disk blob (minted by reconcile) is.
		expect(available.has(goneId)).toBe(false);
		const manifest = await readManifest();
		const onDisk = Object.entries(manifest.files).find(([, e]) => e.file_name === 'on-disk.png');
		expect(onDisk).toBeDefined();
		expect(available.has(onDisk![0])).toBe(true);
	});
});

describe('quiet heal — write only on real change (Item 32)', () => {
	let root: string;
	let filesDir: string;
	let manifestPath: string;

	beforeEach(() => {
		root = path.join(
			tmpdir(),
			`mm-quiet-test-${Date.now()}-${Math.random().toString(16).slice(2)}`
		);
		filesDir = path.join(root, 'media', 'files');
		manifestPath = path.join(root, 'media', 'manifest.json');
		fs.mkdirSync(filesDir, { recursive: true });
		process.env.MEDIA_MANAGER_ROOT = root;
	});

	/**
	 * Backdate the manifest's mtime so a subsequent real write is unambiguously detectable, and return
	 * the stored value. (A no-op reconcile must leave this untouched; a real change must advance it.)
	 */
	function freezeAndReadMtime(): number {
		const old = new Date(Date.now() - 60_000);
		fs.utimesSync(manifestPath, old, old);
		return fs.statSync(manifestPath).mtimeMs;
	}

	it('reconcile does NOT rewrite the manifest when nothing changed (zero browse churn)', async () => {
		fs.writeFileSync(path.join(filesDir, 'a.png'), 'x');
		await reconcile(['a.png']); // first run mints + writes
		const before = freezeAndReadMtime();

		const result = await reconcile(['a.png']); // identical disk state — must be a no-op

		expect(fs.statSync(manifestPath).mtimeMs).toBe(before); // file was not touched
		expect(result.added).toHaveLength(0);
		expect(result.missing).toHaveLength(0);
	});

	it('reconcile rewrites + reports when a new blob appears on disk', async () => {
		fs.writeFileSync(path.join(filesDir, 'a.png'), 'x');
		await reconcile(['a.png']);
		const before = freezeAndReadMtime();

		fs.writeFileSync(path.join(filesDir, 'b.png'), 'y');
		const result = await reconcile(['a.png', 'b.png']); // real change

		expect(fs.statSync(manifestPath).mtimeMs).toBeGreaterThan(before); // file was rewritten
		expect(result.added.map((a) => a.file_name)).toEqual(['b.png']);
	});

	it('reconcile rewrites + reports when a known blob goes missing, then is quiet while it stays missing', async () => {
		fs.writeFileSync(path.join(filesDir, 'a.png'), 'x');
		await mintFileId('b.png'); // registered but never on disk-list below
		await reconcile(['a.png', 'b.png']);
		const before = freezeAndReadMtime();

		const result = await reconcile(['a.png']); // b.png vanished → flip missing flag, write once
		expect(fs.statSync(manifestPath).mtimeMs).toBeGreaterThan(before);
		expect(result.missing.map((m) => m.file_name)).toContain('b.png');

		// Already-flagged-missing on the next browse ⇒ no further write.
		const after = freezeAndReadMtime();
		await reconcile(['a.png']);
		expect(fs.statSync(manifestPath).mtimeMs).toBe(after);
	});
});

describe('reconcile in static-assets mode (adoption gated)', () => {
	beforeEach(() => {
		const root = path.join(
			tmpdir(),
			`mm-manifest-static-${Date.now()}-${Math.random().toString(16).slice(2)}`
		);
		const assetsDir = path.join(root, 'static', 'media');
		fs.mkdirSync(assetsDir, { recursive: true });
		fs.mkdirSync(path.join(root, 'media'), { recursive: true });
		process.env.MEDIA_MANAGER_ROOT = root;
		// Point the blob subsystem at the host static dir — this is what flips the mode.
		process.env.MEDIA_MANAGER_ASSETS_DIR = assetsDir;
		process.env.MEDIA_MANAGER_ASSETS_BASE_URL = '/media';
	});

	afterEach(() => {
		// Never leak the static-mode env into sibling test files/tests.
		delete process.env.MEDIA_MANAGER_ASSETS_DIR;
		delete process.env.MEDIA_MANAGER_ASSETS_BASE_URL;
	});

	it('does NOT adopt unknown on-disk files (a shared static folder holds non-blob assets)', async () => {
		// e.g. the site's favicon.png sitting in static/media alongside real blobs.
		const result = await reconcile(['favicon.png', 'og-image.jpg']);
		expect(result.added).toHaveLength(0);
		const manifest = await readManifest();
		expect(Object.keys(manifest.files)).toHaveLength(0);
	});

	it('still registers blobs explicitly (upload path) and flags manifest entries gone from disk', async () => {
		const id = await mintFileId('real-photo.jpeg'); // explicit registration still works
		// real-photo is on disk; a stray favicon is too but must not be adopted; a known blob vanished.
		await mintFileId('vanished.jpeg');
		const result = await reconcile(['real-photo.jpeg', 'favicon.png']);
		expect(result.added).toHaveLength(0); // favicon NOT adopted
		expect(result.missing.map((m) => m.file_name)).toContain('vanished.jpeg');
		expect(await getFilenameForFileId(id)).toBe('real-photo.jpeg'); // explicit blob intact
	});

	it('respects an explicit { adopt: true } override (used by export/import)', async () => {
		const result = await reconcile(['brought-in.jpeg'], { adopt: true });
		expect(result.added.map((a) => a.file_name)).toEqual(['brought-in.jpeg']);
	});
});

describe('byte sizes on manifest entries (Item 15)', () => {
	let root: string;

	beforeEach(() => {
		root = path.join(
			tmpdir(),
			`mm-sizes-test-${Date.now()}-${Math.random().toString(16).slice(2)}`
		);
		fs.mkdirSync(path.join(root, 'media', 'files'), { recursive: true });
		process.env.MEDIA_MANAGER_ROOT = root;
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it('mintFileId records the size it is given, and refreshes it when a re-upload reuses the name', async () => {
		const id = await mintFileId('photo.jpg', 1000);
		expect((await readManifest()).files[id].size).toBe(1000);

		// Same name, different bytes (an overwrite re-upload): the entry must adopt the new size, or a
		// compression derivative built from the old bytes would never be seen as stale.
		const again = await mintFileId('photo.jpg', 2500);
		expect(again).toBe(id);
		expect((await readManifest()).files[id].size).toBe(2500);

		// A call with no size at all leaves the stored size alone.
		await mintFileId('photo.jpg');
		expect((await readManifest()).files[id].size).toBe(2500);
	});

	it('setEntrySizes backfills sizes, ignores unknown ids, and leaves everything else alone', async () => {
		const id = await mintFileId('photo.jpg');
		expect((await readManifest()).files[id].size).toBeUndefined();

		await setEntrySizes(
			new Map([
				[id, 4096],
				['nope-not-an-id', 12]
			])
		);

		const entry = (await readManifest()).files[id];
		expect(entry.size).toBe(4096);
		expect(entry.file_name).toBe('photo.jpg');
		expect(entry.classes).toEqual([]);
		expect((await readManifest()).files['nope-not-an-id']).toBeUndefined();
	});

	it('setEntrySizes does not rewrite the manifest when nothing changed', async () => {
		const id = await mintFileId('photo.jpg', 900);
		const manifestPath = path.join(root, 'media', 'manifest.json');
		const old = new Date(Date.now() - 60_000);
		fs.utimesSync(manifestPath, old, old);
		const before = fs.statSync(manifestPath).mtimeMs;

		await setEntrySizes(new Map([[id, 900]]));
		expect(fs.statSync(manifestPath).mtimeMs).toBe(before);
	});
});

describe('derivative records on manifest entries (Item 15)', () => {
	let root: string;
	const webEntry: DerivedEntry = {
		file_name: 'photo.webp',
		size: 1200,
		width: 400,
		height: 300,
		ssim: 0.987,
		recipe: 'webp:q80',
		source_size: 5000,
		generated_at: '2026-01-01T00:00:00.000Z'
	};

	beforeEach(() => {
		root = path.join(
			tmpdir(),
			`mm-derived-manifest-${Date.now()}-${Math.random().toString(16).slice(2)}`
		);
		fs.mkdirSync(path.join(root, 'media', 'files'), { recursive: true });
		process.env.MEDIA_MANAGER_ROOT = root;
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it('setDerivedEntries round-trips a record and merges per preset', async () => {
		const id = await mintFileId('photo.jpg', 5000);
		await setDerivedEntries(new Map([[id, { web: webEntry }]]));
		expect((await readManifest()).files[id].derived).toEqual({ web: webEntry });

		// A later batch touching only `thumb` must not drop `web`.
		const thumbEntry: DerivedEntry = {
			file_name: 'photo.webp',
			recipe: 'webp:q70:w400',
			size: 300
		};
		await setDerivedEntries(new Map([[id, { thumb: thumbEntry }]]));
		const derived = (await readManifest()).files[id].derived;
		expect(Object.keys(derived ?? {}).sort()).toEqual(['thumb', 'web']);
		expect(derived?.web).toEqual(webEntry);

		// Regenerating `web` replaces that preset's record only.
		await setDerivedEntries(new Map([[id, { web: { ...webEntry, size: 999 } }]]));
		const after = (await readManifest()).files[id].derived;
		expect(after?.web.size).toBe(999);
		expect(after?.thumb).toEqual(thumbEntry);
	});

	it('setDerivedEntries stores a skip (no file_name, always a recipe)', async () => {
		const id = await mintFileId('doc.pdf', 100);
		await setDerivedEntries(
			new Map([[id, { web: { recipe: 'webp:q80', skipped: 'unsupported' } as DerivedEntry }]])
		);
		const d = (await readManifest()).files[id].derived?.web;
		expect(d).toEqual({ recipe: 'webp:q80', skipped: 'unsupported' });
		expect(d?.file_name).toBeUndefined();
	});

	it('setDerivedEntries ignores unknown ids', async () => {
		await mintFileId('photo.jpg');
		await setDerivedEntries(new Map([['ghost-id', { web: webEntry }]]));
		expect((await readManifest()).files['ghost-id']).toBeUndefined();
	});

	it('removeDerivedEntries({ fileId }) drops every preset and reports the files to unlink', async () => {
		const a = await mintFileId('a.jpg');
		const b = await mintFileId('b.jpg');
		await setDerivedEntries(
			new Map<string, Record<string, DerivedEntry>>([
				[
					a,
					{
						web: { ...webEntry, file_name: 'a.webp' },
						thumb: { file_name: 'a-t.webp', recipe: 'webp:q70:w400' }
					}
				],
				[b, { web: { ...webEntry, file_name: 'b.webp' } }]
			])
		);

		const removed = await removeDerivedEntries({ fileId: a });
		expect(removed.map((r) => r.file_name).sort()).toEqual(['a-t.webp', 'a.webp']);
		expect(removed.every((r) => r.fileId === a)).toBe(true);

		const manifest = await readManifest();
		expect(manifest.files[a].derived).toBeUndefined();
		expect(manifest.files[b].derived?.web.file_name).toBe('b.webp'); // sibling untouched
	});

	it('removeDerivedEntries({ presetId }) drops one preset across every blob', async () => {
		const a = await mintFileId('a.jpg');
		const b = await mintFileId('b.jpg');
		await setDerivedEntries(
			new Map<string, Record<string, DerivedEntry>>([
				[
					a,
					{
						web: { ...webEntry, file_name: 'a.webp' },
						thumb: { file_name: 'a-t.webp', recipe: 'webp:q70:w400' }
					}
				],
				[b, { thumb: { file_name: 'b-t.webp', recipe: 'webp:q70:w400' } }]
			])
		);

		const removed = await removeDerivedEntries({ presetId: 'thumb' });
		expect(removed.map((r) => r.file_name).sort()).toEqual(['a-t.webp', 'b-t.webp']);

		const manifest = await readManifest();
		expect(Object.keys(manifest.files[a].derived ?? {})).toEqual(['web']);
		expect(manifest.files[b].derived).toBeUndefined();
	});

	it('renameDerivedEntries changes only the derivative file_name', async () => {
		const id = await mintFileId('photo.jpg', 5000);
		await setDerivedEntries(new Map([[id, { web: webEntry }]]));

		await renameDerivedEntries(id, new Map([['web', 'renamed.webp']]));

		const d = (await readManifest()).files[id].derived?.web;
		expect(d).toEqual({ ...webEntry, file_name: 'renamed.webp' });
		// An unknown preset in the rename map is ignored.
		await renameDerivedEntries(id, new Map([['nope', 'x.webp']]));
		expect(Object.keys((await readManifest()).files[id].derived ?? {})).toEqual(['web']);
	});
});

/**
 * The zod-strip regression (Item 15).
 *
 * `ManifestEntrySchema` is a bare `z.object`, so **any key it does not declare is silently dropped** on
 * `.parse()` — and every mutator round-trips read → parse → mutate → write. A `derived` block that fell
 * off the schema would therefore survive only until the next unrelated write, then vanish with no error
 * and no failing type. These tests are the only thing that would catch it.
 */
describe('unrelated manifest writes preserve the derived block', () => {
	let root: string;
	let filesDir: string;
	let fileId: string;
	const derived = {
		web: {
			file_name: 'photo.webp',
			size: 1200,
			width: 400,
			height: 300,
			ssim: 0.981,
			recipe: 'webp:q80',
			source_size: 5000,
			generated_at: '2026-01-01T00:00:00.000Z'
		}
	};

	beforeEach(async () => {
		root = path.join(tmpdir(), `mm-zodstrip-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		filesDir = path.join(root, 'media', 'files');
		fs.mkdirSync(filesDir, { recursive: true });
		process.env.MEDIA_MANAGER_ROOT = root;

		fs.writeFileSync(path.join(filesDir, 'photo.jpg'), 'x');
		fileId = await mintFileId('photo.jpg', 5000);
		await setDerivedEntries(new Map([[fileId, derived]]));
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	/** The derived block, straight off disk (not through the in-memory value we wrote). */
	async function derivedOnDisk(id = fileId) {
		return (await readManifest()).files[id]?.derived;
	}

	it('survives a membership write (setClassMembership)', async () => {
		await setClassMembership(fileId, 'gallery', true);
		expect(await derivedOnDisk()).toEqual(derived);
		await setClassMembership(fileId, 'gallery', false);
		expect(await derivedOnDisk()).toEqual(derived);
	});

	it('survives a rename (renameFileId)', async () => {
		await renameFileId(fileId, 'renamed.jpg');
		expect((await readManifest()).files[fileId].file_name).toBe('renamed.jpg');
		expect(await derivedOnDisk()).toEqual(derived);
	});

	it('survives a dimension backfill (setEntryDimensions) and a size backfill (setEntrySizes)', async () => {
		await setEntryDimensions(new Map([[fileId, { width: 4000, height: 3000 }]]));
		expect(await derivedOnDisk()).toEqual(derived);
		await setEntrySizes(new Map([[fileId, 7777]]));
		expect(await derivedOnDisk()).toEqual(derived);
		// The derivative's own dimensions are not confused with the original's.
		expect((await readManifest()).files[fileId].width).toBe(4000);
		expect((await derivedOnDisk())?.web.width).toBe(400);
	});

	it('survives a reconcile that flags the blob missing, and one that adopts a new blob', async () => {
		// Blob vanished ⇒ the missing flag flips and the manifest is rewritten.
		await reconcile([]);
		expect((await readManifest()).files[fileId].missing).toBe(true);
		expect(await derivedOnDisk()).toEqual(derived);

		// A new blob is adopted ⇒ another full rewrite.
		fs.writeFileSync(path.join(filesDir, 'fresh.png'), 'y');
		const result = await reconcile(['photo.jpg', 'fresh.png']);
		expect(result.added.map((a) => a.file_name)).toEqual(['fresh.png']);
		expect(await derivedOnDisk()).toEqual(derived);
	});

	it('survives the whole lifecycle in sequence (the realistic drift path)', async () => {
		await setClassMembership(fileId, 'gallery', true);
		await setEntryDimensions(new Map([[fileId, { width: 400, height: 300 }]]));
		await renameFileId(fileId, 'renamed.jpg');
		fs.renameSync(path.join(filesDir, 'photo.jpg'), path.join(filesDir, 'renamed.jpg'));
		await reconcile(['renamed.jpg']);
		await setClassMembership(fileId, 'docs', true);

		expect(await derivedOnDisk()).toEqual(derived);
	});
});
