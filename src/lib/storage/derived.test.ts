import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

import {
	deleteDerivedForBlob,
	derivedBaseName,
	isCompressibleFilename,
	isStale,
	listDerivedRelPaths,
	renameDerivedForBlob,
	resolveDerivedName
} from './derived.js';
import { readManifest, type DerivedEntry } from './manifest.js';
import type { CompressionPreset } from './compressionSettings.js';

/**
 * Derivative naming, staleness and on-disk housekeeping (Item 15) — the half of the compression feature
 * that needs no encoder.
 *
 * Two behaviours here are load-bearing and invisible in the UI until they break:
 * - **stem collisions** (`photo.jpg` + `photo.png` both want `photo.webp`) must resolve to two distinct
 *   names *and* be idempotent, or a regeneration would keep appending suffixes forever;
 * - **staleness** must be a recipe comparison, so a label rename can't trigger a workspace-wide rebuild.
 */

const web: CompressionPreset = { id: 'web', label: 'Web', format: 'webp', quality: 80 };
const thumb: CompressionPreset = { id: 'thumb', format: 'webp', quality: 70, width: 400 };

let root: string;
let derivedRoot: string;

beforeEach(() => {
	root = path.join(tmpdir(), `mm-derived-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	derivedRoot = path.join(root, 'media', 'derived');
	fs.mkdirSync(path.join(root, 'media', 'files'), { recursive: true });
	process.env.MEDIA_MANAGER_ROOT = root;
	delete process.env.MEDIA_MANAGER_ASSETS_DIR;
	delete process.env.MEDIA_MANAGER_ASSETS_BASE_URL;
});

afterEach(() => {
	delete process.env.MEDIA_MANAGER_ASSETS_DIR;
	delete process.env.MEDIA_MANAGER_ASSETS_BASE_URL;
	fs.rmSync(root, { recursive: true, force: true });
});

/** Seed `media/manifest.json` from a plain object of entries. */
function seedManifest(files: Record<string, unknown>): void {
	fs.writeFileSync(
		path.join(root, 'media', 'manifest.json'),
		JSON.stringify({ version: 2, files }, null, 2)
	);
}

/** Write a placeholder derivative file under `media/derived/<preset>/<name>`. */
function seedDerivedFile(presetId: string, name: string, bytes = 'derived-bytes'): string {
	const dir = path.join(derivedRoot, presetId);
	fs.mkdirSync(dir, { recursive: true });
	const full = path.join(dir, name);
	fs.writeFileSync(full, bytes);
	return full;
}

describe('isCompressibleFilename', () => {
	it('accepts the still-raster formats sharp re-encodes', () => {
		for (const name of ['a.jpg', 'a.jpeg', 'a.png', 'a.webp', 'a.tif', 'a.tiff', 'a.avif']) {
			expect(isCompressibleFilename(name)).toBe(true);
		}
	});

	it('is case-insensitive on the extension', () => {
		expect(isCompressibleFilename('PHOTO.JPG')).toBe(true);
		expect(isCompressibleFilename('Photo.JPEG')).toBe(true);
	});

	it('rejects vector, animated and non-image types (a deliberate phase-1 scope decision)', () => {
		for (const name of ['a.svg', 'a.gif', 'a.pdf', 'a.mp4', 'a.heic', 'a.txt', 'noextension']) {
			expect(isCompressibleFilename(name)).toBe(false);
		}
	});
});

describe('derivedBaseName', () => {
	it('mirrors the original stem with the preset container extension', () => {
		expect(derivedBaseName('sunset-over-tokyo.jpg', web)).toBe('sunset-over-tokyo.webp');
		expect(derivedBaseName('a.png', { ...web, format: 'avif' })).toBe('a.avif');
		expect(derivedBaseName('a.png', { ...web, format: 'jpeg' })).toBe('a.jpg');
		expect(derivedBaseName('a.jpg', { ...web, format: 'png' })).toBe('a.png');
	});

	it('keeps interior dots and copes with an extensionless name', () => {
		expect(derivedBaseName('my.photo.v2.jpg', web)).toBe('my.photo.v2.webp');
		expect(derivedBaseName('noextension', web)).toBe('noextension.webp');
	});

	it('is exactly the collision source: two stems collapse to one name', () => {
		expect(derivedBaseName('photo.jpg', web)).toBe(derivedBaseName('photo.png', web));
	});
});

describe('resolveDerivedName — stem collisions', () => {
	const idA = 'aaaaaaaa-1111-4000-8000-000000000000';
	const idB = 'bbbbbbbb-2222-4000-8000-000000000000';

	it('gives two originals sharing a stem two distinct names under one preset', () => {
		const claimed = new Map<string, string>();
		const nameA = resolveDerivedName('photo.jpg', idA, web, claimed);
		claimed.set(nameA, idA);
		const nameB = resolveDerivedName('photo.png', idB, web, claimed);
		claimed.set(nameB, idB);

		expect(nameA).toBe('photo.webp');
		expect(nameB).not.toBe(nameA);
		expect(nameB).toBe('photo-bbbbbb.webp'); // short id suffix, dashes stripped
		expect(new Set([nameA, nameB]).size).toBe(2);
	});

	it('is idempotent — re-resolving for the same blob never appends another suffix', () => {
		const claimed = new Map<string, string>([['photo.webp', idA]]);
		const first = resolveDerivedName('photo.png', idB, web, claimed);
		claimed.set(first, idB);

		// The regeneration path resolves again against a map that already contains the blob's own claim.
		const second = resolveDerivedName('photo.png', idB, web, claimed);
		const third = resolveDerivedName('photo.png', idB, web, claimed);
		expect(second).toBe(first);
		expect(third).toBe(first);
	});

	it('keeps the natural name when the blob already owns it', () => {
		const claimed = new Map<string, string>([['photo.webp', idA]]);
		expect(resolveDerivedName('photo.jpg', idA, web, claimed)).toBe('photo.webp');
	});

	it('numbers past a suffix collision between ids sharing a short prefix', () => {
		// Two ids whose first six hex digits are identical — the suffix alone can't separate them.
		const idX = '8f3a1c00-0000-4000-8000-000000000000';
		const idY = '8f3a1c11-1111-4000-8000-000000000000';
		const claimed = new Map<string, string>([
			['photo.webp', idA],
			['photo-8f3a1c.webp', idX]
		]);
		expect(resolveDerivedName('photo.png', idY, web, claimed)).toBe('photo-8f3a1c-2.webp');
	});

	it('resolves per preset, so the same stem is free again in another preset dir', () => {
		const claimedWeb = new Map<string, string>([['photo.webp', idA]]);
		const claimedThumb = new Map<string, string>();
		expect(resolveDerivedName('photo.png', idB, web, claimedWeb)).toBe('photo-bbbbbb.webp');
		expect(resolveDerivedName('photo.png', idB, thumb, claimedThumb)).toBe('photo.webp');
	});
});

describe('isStale', () => {
	const fresh: DerivedEntry = { recipe: 'webp:q80', source_size: 1000, file_name: 'a.webp' };

	it('is stale when the preset was never generated for this blob', () => {
		expect(isStale(undefined, web, 1000)).toBe(true);
	});

	it('is not stale for an exact recipe + source-size match', () => {
		expect(isStale(fresh, web, 1000)).toBe(false);
	});

	it('is stale on a recipe mismatch (quality, format or width changed)', () => {
		expect(isStale(fresh, { ...web, quality: 81 }, 1000)).toBe(true);
		expect(isStale(fresh, { ...web, format: 'avif' }, 1000)).toBe(true);
		expect(isStale(fresh, { ...web, width: 400 }, 1000)).toBe(true);
	});

	it('is stale when the original was overwritten (source_size changed)', () => {
		expect(isStale(fresh, web, 2000)).toBe(true);
	});

	it('is NOT stale after a label-only edit — a rename must not regenerate the workspace', () => {
		expect(isStale(fresh, { ...web, label: 'Website hero' }, 1000)).toBe(false);
	});

	it('treats an unknown size on either side as "no evidence of change"', () => {
		expect(isStale(fresh, web, undefined)).toBe(false);
		expect(isStale({ recipe: 'webp:q80' }, web, 1234)).toBe(false);
	});

	it('does not retry a skip whose recipe still matches (the whole point of recording it)', () => {
		const skipped: DerivedEntry = { recipe: 'webp:q80', skipped: 'unsupported' };
		expect(isStale(skipped, web, 999)).toBe(false);
		// …but a recipe change does re-attempt it.
		expect(isStale(skipped, { ...web, quality: 60 }, 999)).toBe(true);
	});
});

describe('listDerivedRelPaths', () => {
	it('lists every manifest-referenced derivative as `<preset>/<name>`, skipping skips', async () => {
		seedManifest({
			a: {
				file_name: 'a.jpg',
				classes: [],
				missing: false,
				derived: {
					web: { file_name: 'a.webp', recipe: 'webp:q80' },
					thumb: { file_name: 'a.webp', recipe: 'webp:q70:w400' }
				}
			},
			b: {
				file_name: 'b.pdf',
				classes: [],
				missing: false,
				derived: { web: { recipe: 'webp:q80', skipped: 'unsupported' } }
			},
			c: { file_name: 'c.png', classes: [], missing: false }
		});

		expect((await listDerivedRelPaths()).sort()).toEqual(['thumb/a.webp', 'web/a.webp']);
	});

	it('is empty for a workspace with no derivatives', async () => {
		seedManifest({ a: { file_name: 'a.jpg', classes: [], missing: false } });
		expect(await listDerivedRelPaths()).toEqual([]);
	});
});

describe('deleteDerivedForBlob', () => {
	it('removes the files from disk and the records from the manifest', async () => {
		seedManifest({
			a: {
				file_name: 'a.jpg',
				classes: [],
				missing: false,
				derived: {
					web: { file_name: 'a.webp', recipe: 'webp:q80' },
					thumb: { file_name: 'a.webp', recipe: 'webp:q70:w400' }
				}
			},
			b: {
				file_name: 'b.jpg',
				classes: [],
				missing: false,
				derived: { web: { file_name: 'b.webp', recipe: 'webp:q80' } }
			}
		});
		const aWeb = seedDerivedFile('web', 'a.webp');
		const aThumb = seedDerivedFile('thumb', 'a.webp');
		const bWeb = seedDerivedFile('web', 'b.webp');

		await deleteDerivedForBlob('a');

		expect(fs.existsSync(aWeb)).toBe(false);
		expect(fs.existsSync(aThumb)).toBe(false);
		// A sibling blob's derivative is untouched.
		expect(fs.existsSync(bWeb)).toBe(true);

		const manifest = await readManifest();
		expect(manifest.files.a.derived).toBeUndefined();
		expect(manifest.files.b.derived?.web.file_name).toBe('b.webp');
	});

	it('is a no-op for a blob with no derivatives', async () => {
		seedManifest({ a: { file_name: 'a.jpg', classes: [], missing: false } });
		await expect(deleteDerivedForBlob('a')).resolves.toBeUndefined();
	});
});

describe('renameDerivedForBlob', () => {
	it('renames the derivative on disk and updates its manifest file_name', async () => {
		seedManifest({
			a: {
				file_name: 'old.jpg',
				classes: [],
				missing: false,
				derived: { web: { file_name: 'old.webp', recipe: 'webp:q80', size: 13 } }
			}
		});
		seedDerivedFile('web', 'old.webp');

		await renameDerivedForBlob('a', 'new.jpg');

		expect(fs.existsSync(path.join(derivedRoot, 'web', 'new.webp'))).toBe(true);
		expect(fs.existsSync(path.join(derivedRoot, 'web', 'old.webp'))).toBe(false);
		const manifest = await readManifest();
		expect(manifest.files.a.derived?.web.file_name).toBe('new.webp');
		// Only the name changed — the staleness key and measurements are preserved.
		expect(manifest.files.a.derived?.web.recipe).toBe('webp:q80');
		expect(manifest.files.a.derived?.web.size).toBe(13);
	});

	it('avoids colliding with another blob that already owns the target stem', async () => {
		seedManifest({
			a: {
				file_name: 'old.jpg',
				classes: [],
				missing: false,
				derived: { web: { file_name: 'old.webp', recipe: 'webp:q80' } }
			},
			bbbbbbbb: {
				file_name: 'taken.png',
				classes: [],
				missing: false,
				derived: { web: { file_name: 'taken.webp', recipe: 'webp:q80' } }
			}
		});
		seedDerivedFile('web', 'old.webp');
		seedDerivedFile('web', 'taken.webp', 'other-blob');

		await renameDerivedForBlob('a', 'taken.jpg');

		const manifest = await readManifest();
		const renamed = manifest.files.a.derived?.web.file_name;
		expect(renamed).not.toBe('taken.webp');
		expect(renamed).toBe('taken-a.webp'); // short id suffix of the (short) test id
		expect(fs.existsSync(path.join(derivedRoot, 'web', renamed!))).toBe(true);
		// The other blob's derivative was not clobbered.
		expect(fs.readFileSync(path.join(derivedRoot, 'web', 'taken.webp'), 'utf-8')).toBe(
			'other-blob'
		);
	});

	it('is a no-op when the blob has no derivatives', async () => {
		seedManifest({ a: { file_name: 'a.jpg', classes: [], missing: false } });
		await expect(renameDerivedForBlob('a', 'b.jpg')).resolves.toBeUndefined();
	});

	it('leaves the manifest pointing at the old name when the file is missing on disk', async () => {
		// A failed rename is logged, not rolled back — the manifest must keep naming a file that exists.
		seedManifest({
			a: {
				file_name: 'old.jpg',
				classes: [],
				missing: false,
				derived: { web: { file_name: 'old.webp', recipe: 'webp:q80' } }
			}
		});
		// No file on disk at all.
		await renameDerivedForBlob('a', 'new.jpg');
		const manifest = await readManifest();
		expect(manifest.files.a.derived?.web.file_name).toBe('old.webp');
	});
});
