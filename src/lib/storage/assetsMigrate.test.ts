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
