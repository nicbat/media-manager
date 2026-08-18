import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { migrateBlobs, previewMigration } from './assetsMigrate.js';

/**
 * Engine tests for the storage-location blob migration. Exercises move / copy / leave, the preflight
 * abort paths (name conflict, missing-at-source), the idempotent same-content skip, and the read-only
 * preview — all against a temp workspace whose blob dir is the classic `<root>/media/files`.
 */

let root: string;
let filesDir: string;

/** Seed `media/manifest.json` with the given filenames + create matching blobs in `media/files`. */
function seed(names: string[], contents?: Record<string, string>) {
	const files: Record<string, unknown> = {};
	names.forEach((name, i) => {
		files[`id-${i}`] = { file_name: name, classes: [], missing: false };
		fs.writeFileSync(path.join(filesDir, name), contents?.[name] ?? `bytes-of-${name}`);
	});
	fs.writeFileSync(
		path.join(root, 'media', 'manifest.json'),
		JSON.stringify({ version: 2, files }, null, 2)
	);
}

beforeEach(() => {
	root = path.join(tmpdir(), `mm-migrate-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	filesDir = path.join(root, 'media', 'files');
	fs.mkdirSync(filesDir, { recursive: true });
	process.env.MEDIA_MANAGER_ROOT = root;
	delete process.env.MEDIA_MANAGER_ASSETS_DIR;
	delete process.env.MEDIA_MANAGER_ASSETS_BASE_URL;
});

afterEach(() => {
	delete process.env.MEDIA_MANAGER_ASSETS_DIR;
	delete process.env.MEDIA_MANAGER_ASSETS_BASE_URL;
	fs.rmSync(root, { recursive: true, force: true });
});

describe('migrateBlobs', () => {
	it('move relocates the bytes and empties the source', async () => {
		seed(['a.png', 'b.png']);
		const to = path.join(root, 'static', 'media');
		const res = await migrateBlobs({ toDir: to, strategy: 'move' });

		expect(res.aborted).toBe(false);
		expect(res.moved).toBe(2);
		expect(fs.existsSync(path.join(to, 'a.png'))).toBe(true);
		expect(fs.existsSync(path.join(to, 'b.png'))).toBe(true);
		expect(fs.existsSync(path.join(filesDir, 'a.png'))).toBe(false);
		expect(fs.existsSync(path.join(filesDir, 'b.png'))).toBe(false);
	});

	it('copy duplicates the bytes and keeps the originals', async () => {
		seed(['a.png']);
		const to = path.join(root, 'static', 'media');
		const res = await migrateBlobs({ toDir: to, strategy: 'copy' });

		expect(res.copied).toBe(1);
		expect(fs.existsSync(path.join(to, 'a.png'))).toBe(true);
		expect(fs.existsSync(path.join(filesDir, 'a.png'))).toBe(true);
	});

	it('leave touches no bytes (repoint only)', async () => {
		seed(['a.png']);
		const to = path.join(root, 'static', 'media');
		const res = await migrateBlobs({ toDir: to, strategy: 'leave' });

		expect(res.moved).toBe(0);
		expect(res.copied).toBe(0);
		expect(res.skipped).toBe(1);
		expect(fs.existsSync(path.join(to, 'a.png'))).toBe(false);
		expect(fs.existsSync(path.join(filesDir, 'a.png'))).toBe(true);
	});

	it('aborts on a name conflict without touching anything', async () => {
		seed(['a.png', 'b.png']);
		const to = path.join(root, 'static', 'media');
		fs.mkdirSync(to, { recursive: true });
		fs.writeFileSync(path.join(to, 'a.png'), 'DIFFERENT CONTENT'); // collides with a different file

		const res = await migrateBlobs({ toDir: to, strategy: 'move' });

		expect(res.aborted).toBe(true);
		expect(res.conflicts).toContain('a.png');
		expect(res.moved).toBe(0);
		// Source untouched by the abort.
		expect(fs.existsSync(path.join(filesDir, 'a.png'))).toBe(true);
		expect(fs.existsSync(path.join(filesDir, 'b.png'))).toBe(true);
	});

	it('treats a byte-identical destination file as already-there (skips it, not a conflict)', async () => {
		seed(['a.png'], { 'a.png': 'same-bytes' });
		const to = path.join(root, 'static', 'media');
		fs.mkdirSync(to, { recursive: true });
		fs.writeFileSync(path.join(to, 'a.png'), 'same-bytes'); // identical → not a conflict

		const res = await migrateBlobs({ toDir: to, strategy: 'move' });

		expect(res.aborted).toBe(false);
		expect(res.conflicts).toEqual([]);
		expect(res.moved).toBe(1);
		// Move still removes the source even though the copy was skipped.
		expect(fs.existsSync(path.join(filesDir, 'a.png'))).toBe(false);
	});

	it('aborts when a manifest blob is missing at the source, unless forced', async () => {
		seed(['a.png']);
		// Add a manifest entry with no blob on disk.
		const manifestPath = path.join(root, 'media', 'manifest.json');
		const m = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
		m.files['ghost'] = { file_name: 'ghost.png', classes: [], missing: false };
		fs.writeFileSync(manifestPath, JSON.stringify(m));

		const to = path.join(root, 'static', 'media');
		const blocked = await migrateBlobs({ toDir: to, strategy: 'move' });
		expect(blocked.aborted).toBe(true);
		expect(blocked.missingAtSource).toContain('ghost.png');
		expect(fs.existsSync(path.join(filesDir, 'a.png'))).toBe(true);

		const forced = await migrateBlobs({ toDir: to, strategy: 'move', force: true });
		expect(forced.aborted).toBe(false);
		expect(forced.moved).toBe(1);
		expect(forced.skipped).toBe(1); // the ghost
		expect(fs.existsSync(path.join(to, 'a.png'))).toBe(true);
	});

	it('is a no-op when source and destination are the same folder', async () => {
		seed(['a.png']);
		const res = await migrateBlobs({ toDir: filesDir, strategy: 'move' });
		expect(res.sameDir).toBe(true);
		expect(res.aborted).toBe(false);
		expect(res.moved).toBe(0);
		expect(fs.existsSync(path.join(filesDir, 'a.png'))).toBe(true);
	});
});

/**
 * Derivatives (Item 15) travel with the blobs.
 *
 * The asymmetry this exercises is deliberate and easy to get wrong: in **classic** mode the derived root
 * is `<root>/media/derived`, a *sibling* of `media/files`; in **static-assets** mode it is
 * `<assetsDir>/derived`, *inside* the published asset root (so the reader's `baseUrl` composes to
 * `${baseUrl}/derived/<preset>/<name>` with nothing further to configure).
 */
describe('derivative transfer (Item 15)', () => {
	/** Attach a `web` derivative to every seeded manifest entry and write the files under the classic root. */
	function seedDerived(map: Record<string, string>, bytes = 'derived-bytes-xxxxx') {
		const manifestPath = path.join(root, 'media', 'manifest.json');
		const m = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
		const dir = path.join(root, 'media', 'derived', 'web');
		fs.mkdirSync(dir, { recursive: true });
		for (const [id, derivedName] of Object.entries(map)) {
			m.files[id].derived = {
				web: { file_name: derivedName, recipe: 'webp:q80', size: bytes.length }
			};
			fs.writeFileSync(path.join(dir, derivedName), bytes);
		}
		fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));
	}

	it('previewMigration counts derivative bytes inside bytesToTransfer', async () => {
		seed(['a.png', 'b.png']);
		const blobOnly = await previewMigration({
			toDir: path.join(root, 'static', 'media'),
			strategy: 'move'
		});
		expect(blobOnly.derivedCount).toBe(0);
		expect(blobOnly.derivedBytes).toBe(0);

		seedDerived({ 'id-0': 'a.webp', 'id-1': 'b.webp' });
		const withDerived = await previewMigration({
			toDir: path.join(root, 'static', 'media'),
			strategy: 'move'
		});

		expect(withDerived.derivedCount).toBe(2);
		expect(withDerived.derivedBytes).toBeGreaterThan(0);
		// The derivative bytes are *included* in the headline figure, not reported beside it — a move that
		// looks like it fits must not run the destination out of disk.
		expect(withDerived.bytesToTransfer).toBe(blobOnly.bytesToTransfer + withDerived.derivedBytes);
		// Read-only: nothing was written to the destination.
		expect(fs.existsSync(path.join(root, 'static', 'media'))).toBe(false);
	});

	it('move relocates the derived tree INTO the destination assets dir and reports the count', async () => {
		seed(['a.png']);
		seedDerived({ 'id-0': 'a.webp' });
		const to = path.join(root, 'static', 'media');

		const res = await migrateBlobs({ toDir: to, strategy: 'move' });

		expect(res.aborted).toBe(false);
		expect(res.moved).toBe(1);
		expect(res.derivedTransferred).toBe(1);
		// Destination derived root is INSIDE the assets dir…
		expect(fs.existsSync(path.join(to, 'derived', 'web', 'a.webp'))).toBe(true);
		// …whereas the classic source root was a SIBLING of media/files.
		expect(fs.existsSync(path.join(root, 'media', 'derived', 'web', 'a.webp'))).toBe(false);
		// Not a nested `<toDir>/media/derived` and not left at the workspace root.
		expect(fs.existsSync(path.join(to, 'media'))).toBe(false);
	});

	it('copy duplicates the derivatives and keeps the source tree', async () => {
		seed(['a.png']);
		seedDerived({ 'id-0': 'a.webp' });
		const to = path.join(root, 'static', 'media');

		const res = await migrateBlobs({ toDir: to, strategy: 'copy' });

		expect(res.derivedTransferred).toBe(1);
		expect(fs.existsSync(path.join(to, 'derived', 'web', 'a.webp'))).toBe(true);
		expect(fs.existsSync(path.join(root, 'media', 'derived', 'web', 'a.webp'))).toBe(true);
	});

	it('leave transfers no derivatives (repoint only)', async () => {
		seed(['a.png']);
		seedDerived({ 'id-0': 'a.webp' });
		const to = path.join(root, 'static', 'media');

		const res = await migrateBlobs({ toDir: to, strategy: 'leave' });

		expect(res.derivedCount).toBe(0);
		expect(res.derivedTransferred).toBe(0);
		expect(fs.existsSync(path.join(to, 'derived'))).toBe(false);
		expect(fs.existsSync(path.join(root, 'media', 'derived', 'web', 'a.webp'))).toBe(true);
	});

	it('a derivative missing at the source never blocks the migration (it is regenerable)', async () => {
		seed(['a.png']);
		seedDerived({ 'id-0': 'a.webp' });
		fs.rmSync(path.join(root, 'media', 'derived', 'web', 'a.webp')); // manifest still claims it
		const to = path.join(root, 'static', 'media');

		const pre = await previewMigration({ toDir: to, strategy: 'move' });
		expect(pre.derivedCount).toBe(0); // not present ⇒ not counted, and not a conflict/missing blocker
		expect(pre.missingAtSource).toEqual([]);

		const res = await migrateBlobs({ toDir: to, strategy: 'move' });
		expect(res.aborted).toBe(false);
		expect(res.moved).toBe(1);
		expect(res.derivedTransferred).toBe(0);
	});
});

describe('previewMigration', () => {
	it('reports the plan without moving anything', async () => {
		seed(['a.png', 'b.png']);
		const to = path.join(root, 'static', 'media');
		const pre = await previewMigration({ toDir: to, strategy: 'move' });

		expect(pre.blobCount).toBe(2);
		expect(pre.presentAtSource).toBe(2);
		expect(pre.conflicts).toEqual([]);
		expect(pre.missingAtSource).toEqual([]);
		expect(pre.bytesToTransfer).toBeGreaterThan(0);
		// Nothing was moved.
		expect(fs.existsSync(path.join(to, 'a.png'))).toBe(false);
		expect(fs.existsSync(path.join(filesDir, 'a.png'))).toBe(true);
	});
});
