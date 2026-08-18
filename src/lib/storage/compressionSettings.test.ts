import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

import {
	DEFAULT_COMPRESSION_SETTINGS,
	PRESET_ID_PATTERN,
	presetsForBlob,
	readCompressionSettings,
	recipeOf,
	writeCompressionSettings,
	type CompressionPreset
} from './compressionSettings.js';

/**
 * The compression **preset registry** (Item 15): the `compression` block of `media/settings.json`.
 *
 * The load-bearing assertion here is {@link recipeOf} — it is the staleness key for every derivative in
 * the workspace, so it must change when (and only when) an encoding input changes. A label rename that
 * altered the recipe would silently regenerate every derivative in the workspace.
 */

let root: string;

beforeEach(() => {
	root = path.join(tmpdir(), `mm-compset-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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

/** Write the raw `media/settings.json` document (bypassing the writer, to seed odd states). */
function writeRawMediaSettings(doc: unknown): void {
	fs.writeFileSync(path.join(root, 'media', 'settings.json'), JSON.stringify(doc, null, 2));
}

/** Read the raw `media/settings.json` document back. */
function readRawMediaSettings(): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(path.join(root, 'media', 'settings.json'), 'utf-8'));
}

const webp80: CompressionPreset = { id: 'web', label: 'Web', format: 'webp', quality: 80 };

describe('recipeOf — the staleness key', () => {
	it('encodes format + quality, and appends the width only when the preset resizes', () => {
		expect(recipeOf(webp80)).toBe('webp:q80');
		expect(recipeOf({ id: 'thumb', format: 'webp', quality: 70, width: 400 })).toBe(
			'webp:q70:w400'
		);
		expect(recipeOf({ id: 'a', format: 'avif', quality: 55 })).toBe('avif:q55');
		expect(recipeOf({ id: 'j', format: 'jpeg', quality: 82, width: 1600 })).toBe('jpeg:q82:w1600');
	});

	it('is unchanged by a label-only edit (a rename must not regenerate the workspace)', () => {
		const before = recipeOf(webp80);
		const after = recipeOf({ ...webp80, label: 'Website hero' });
		expect(after).toBe(before);
	});

	it('changes for every encoding input (format, quality, width)', () => {
		const base = recipeOf(webp80);
		expect(recipeOf({ ...webp80, quality: 81 })).not.toBe(base);
		expect(recipeOf({ ...webp80, format: 'avif' })).not.toBe(base);
		expect(recipeOf({ ...webp80, width: 800 })).not.toBe(base);
	});
});

describe('readCompressionSettings', () => {
	it('yields the defaults when media/settings.json is absent', () => {
		expect(readCompressionSettings()).toEqual(DEFAULT_COMPRESSION_SETTINGS);
	});

	it('yields the defaults for a malformed or empty compression block (never throws)', () => {
		writeRawMediaSettings({ compression: 'not an object' });
		expect(readCompressionSettings()).toEqual(DEFAULT_COMPRESSION_SETTINGS);

		writeRawMediaSettings({ compression: { presets: [] } });
		expect(readCompressionSettings()).toEqual(DEFAULT_COMPRESSION_SETTINGS);

		fs.writeFileSync(path.join(root, 'media', 'settings.json'), '{ this is not json');
		expect(readCompressionSettings()).toEqual(DEFAULT_COMPRESSION_SETTINGS);
	});

	it('drops subscriptions to presets that no longer exist', () => {
		writeRawMediaSettings({
			compression: {
				autoCompress: true,
				presets: [webp80],
				workspacePresets: ['web', 'deleted-preset']
			}
		});
		expect(readCompressionSettings().workspacePresets).toEqual(['web']);
	});

	it('fills per-preset defaults (format webp, quality 80)', () => {
		writeRawMediaSettings({
			compression: { presets: [{ id: 'bare' }], workspacePresets: ['bare'] }
		});
		const preset = readCompressionSettings().presets[0];
		expect(preset).toMatchObject({ id: 'bare', format: 'webp', quality: 80 });
		expect(preset.width).toBeUndefined();
	});
});

describe('writeCompressionSettings', () => {
	it('round-trips a patch and preserves unrelated keys in media/settings.json', async () => {
		writeRawMediaSettings({ classOrder: ['gallery', 'docs'] });

		const merged = await writeCompressionSettings({
			presets: [webp80, { id: 'thumb', format: 'webp', quality: 70, width: 400 }],
			workspacePresets: ['web', 'thumb']
		});

		expect(merged.presets.map((p) => p.id)).toEqual(['web', 'thumb']);
		expect(readCompressionSettings().workspacePresets).toEqual(['web', 'thumb']);
		// The media-scoped neighbour survived the write.
		expect(readRawMediaSettings().classOrder).toEqual(['gallery', 'docs']);
	});

	it('merges partially — an unrelated patch keeps the existing presets', async () => {
		await writeCompressionSettings({ presets: [webp80], workspacePresets: ['web'] });
		const merged = await writeCompressionSettings({ autoCompress: false });
		expect(merged.autoCompress).toBe(false);
		expect(merged.presets.map((p) => p.id)).toEqual(['web']);
		expect(merged.workspacePresets).toEqual(['web']);
	});

	it('rejects duplicate preset ids', async () => {
		await expect(
			writeCompressionSettings({ presets: [webp80, { ...webp80, quality: 60 }] })
		).rejects.toThrow(/duplicate/i);
	});

	it('rejects a preset id that is not a safe path segment (it becomes a directory name)', async () => {
		await expect(
			writeCompressionSettings({ presets: [{ ...webp80, id: '../escape' }] })
		).rejects.toThrow();
		await expect(
			writeCompressionSettings({ presets: [{ ...webp80, id: 'Has Spaces' }] })
		).rejects.toThrow();
	});

	it('rejects an out-of-range quality', async () => {
		await expect(
			writeCompressionSettings({ presets: [{ ...webp80, quality: 0 }] })
		).rejects.toThrow();
		await expect(
			writeCompressionSettings({ presets: [{ ...webp80, quality: 101 }] })
		).rejects.toThrow();
	});
});

describe('PRESET_ID_PATTERN', () => {
	it('accepts safe slugs and rejects traversal / separators / leading punctuation', () => {
		for (const ok of ['web', 'w', 'thumb-400', 'x_2', 'a'.repeat(32)]) {
			expect(PRESET_ID_PATTERN.test(ok)).toBe(true);
		}
		for (const bad of ['', '.', '..', '../x', 'a/b', 'A', '-lead', '_lead', 'a'.repeat(33)]) {
			expect(PRESET_ID_PATTERN.test(bad)).toBe(false);
		}
	});
});

describe('presetsForBlob', () => {
	it('returns the subscribed presets in registry order', () => {
		const settings = {
			autoCompress: true,
			presets: [webp80, { id: 'thumb', format: 'webp' as const, quality: 70, width: 400 }],
			workspacePresets: ['thumb', 'web'] // subscription order must not reorder the registry
		};
		expect(presetsForBlob(settings).map((p) => p.id)).toEqual(['web', 'thumb']);
	});

	it('returns nothing when the workspace subscribes to nothing', () => {
		expect(presetsForBlob({ autoCompress: true, presets: [webp80], workspacePresets: [] })).toEqual(
			[]
		);
	});
});
