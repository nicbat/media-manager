import * as fssync from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { getMediaSettingsPath } from './paths.js';
import { writeJsonFileAtomic } from './json.js';

/**
 * The compression **preset registry** (Item 15) — media-scoped settings persisted in
 * `<root>/media/settings.json` alongside the dormant `classOrder`.
 *
 * The load-bearing idea of the whole feature: **quality belongs to the recipe, not the photo.** Asking
 * "what quality is this image?" has no answer once an image is in two classes with different settings;
 * asking "which recipes does this image need?" always does. So a *preset* is the unit, and things
 * *subscribe* to presets. A blob's derivative set is the **union** of everything subscribing on its
 * behalf — nothing competes, so no tiebreak rule is needed, and the phase-2 responsive-width ladder is
 * just more presets rather than a second mechanism.
 *
 * Phase 1 deliberately ships only the **workspace** subscription ({@link CompressionSettings.workspacePresets}):
 * with a single subscriber the union has nothing to unify yet, which is exactly why phase 1 can't get it
 * wrong. Per-class subscription and `width` land in phase 2 on a data model that already expects them.
 *
 * @see docs/FUTURE_CHANGES.md Item 15 · plans/image-compression.html
 */

/** Output container a preset encodes to. All are still-image formats sharp can write. */
export const CompressionFormatSchema = z.enum(['webp', 'avif', 'jpeg', 'png']);
export type CompressionFormat = z.infer<typeof CompressionFormatSchema>;

/** A preset id must be a safe path segment — it becomes a directory name under `derived/`. */
export const PRESET_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** One compression recipe: a format, a quality, and (phase 2) an optional target width. */
export const CompressionPresetSchema = z.object({
	/** Stable id; also the `derived/<id>/` directory name and the reader's `variant('<id>')` key. */
	id: z.string().regex(PRESET_ID_PATTERN),
	/** Human label shown in the UI; falls back to the id. */
	label: z.string().optional(),
	format: CompressionFormatSchema.default('webp'),
	/** Encoder quality, 1–100. */
	quality: z.number().int().min(1).max(100).default(80),
	/**
	 * Target width in pixels; the image is downscaled to fit (aspect preserved, never upscaled).
	 * Absent ⇒ a same-dimension "twin". Phase 2 turns this into the responsive ladder.
	 */
	width: z.number().int().min(1).max(20000).optional()
});
export type CompressionPreset = z.infer<typeof CompressionPresetSchema>;

/** The `compression` block of `media/settings.json`. */
export const CompressionSettingsSchema = z.object({
	/** Generate derivatives for newly ingested blobs automatically (upload + Google Photos import). */
	autoCompress: z.boolean().default(true),
	/** Every recipe the workspace knows about. */
	presets: z.array(CompressionPresetSchema).default([]),
	/**
	 * Preset ids applied to **every** image, whatever it belongs to. Phase 1's only subscription; phase 2
	 * adds per-class subscriptions that union with this.
	 */
	workspacePresets: z.array(z.string()).default([])
});
export type CompressionSettings = z.infer<typeof CompressionSettingsSchema>;

/** The preset a fresh workspace starts with: one same-dimension WebP twin at q80. */
export const DEFAULT_PRESET: CompressionPreset = {
	id: 'web',
	label: 'Web',
	format: 'webp',
	quality: 80
};

/** Defaults applied when `media/settings.json` has no `compression` block. */
export const DEFAULT_COMPRESSION_SETTINGS: CompressionSettings = {
	autoCompress: true,
	presets: [DEFAULT_PRESET],
	workspacePresets: [DEFAULT_PRESET.id]
};

/**
 * The **recipe string** for a preset — the staleness key stored on every derivative record.
 *
 * Staleness is a comparison, not a timestamp race: a derivative is stale iff its stored `recipe`
 * differs from its preset's current recipe (or its `source_size` differs from the original's current
 * size). So this string must change whenever *any* encoding input changes, and must not change
 * otherwise — a label rename must not trigger a workspace-wide regeneration.
 *
 * @param preset - The preset to describe.
 * @returns e.g. `webp:q80` or `webp:q70:w400`.
 */
export function recipeOf(preset: CompressionPreset): string {
	const base = `${preset.format}:q${preset.quality}`;
	return preset.width ? `${base}:w${preset.width}` : base;
}

/** Read the raw `media/settings.json` document (empty object when missing/malformed). */
function readMediaSettingsDoc(): Record<string, unknown> {
	try {
		return JSON.parse(fssync.readFileSync(getMediaSettingsPath(), 'utf-8')) as Record<
			string,
			unknown
		>;
	} catch {
		return {};
	}
}

/**
 * Read the compression settings, merged with defaults. A missing or malformed block yields the
 * defaults rather than throwing, so the feature is always in a runnable state.
 *
 * Concerns / future improvements:
 * - Synchronous, like its `media/settings.json` neighbours; it's a small file read on demand.
 */
export function readCompressionSettings(): CompressionSettings {
	const parsed = CompressionSettingsSchema.safeParse(readMediaSettingsDoc().compression ?? {});
	if (!parsed.success) return structuredClone(DEFAULT_COMPRESSION_SETTINGS);
	const settings = parsed.data;
	if (settings.presets.length === 0) return structuredClone(DEFAULT_COMPRESSION_SETTINGS);
	// Drop subscriptions to presets that no longer exist (a deleted preset leaves a dangling id).
	const known = new Set(settings.presets.map((p) => p.id));
	return { ...settings, workspacePresets: settings.workspacePresets.filter((id) => known.has(id)) };
}

/**
 * Merge a partial update into the `compression` block of `media/settings.json` and persist atomically.
 * Other keys in the file (`classOrder`) are preserved.
 *
 * @param patch - The subset of compression settings to change.
 * @returns The full compression settings after the merge.
 * @throws If the resulting presets are invalid (duplicate or malformed ids).
 */
export async function writeCompressionSettings(
	patch: Partial<CompressionSettings>
): Promise<CompressionSettings> {
	const doc = readMediaSettingsDoc();
	const merged = CompressionSettingsSchema.parse({ ...readCompressionSettings(), ...patch });
	const ids = merged.presets.map((p) => p.id);
	if (new Set(ids).size !== ids.length) throw new Error('Duplicate preset id');

	const settingsPath = getMediaSettingsPath();
	await fs.mkdir(path.dirname(settingsPath), { recursive: true });
	await writeJsonFileAtomic(settingsPath, { ...doc, compression: merged });
	return merged;
}

/**
 * The presets that apply to a given blob — **the union rule**, and the whole reason this design works.
 *
 * A blob's derivative set is the union of every subscription that reaches it: the workspace-wide
 * subscription, plus the subscription of each class it belongs to. Because nothing *competes* — two
 * classes asking for different recipes both get what they asked for — there is no tiebreak rule, which
 * is precisely the trap the "what quality is this photo?" framing falls into.
 *
 * Two consequences worth stating, because callers depend on both:
 * - **Order is registry order**, not subscription order, so a blob's derivative set is deterministic
 *   regardless of which class happened to ask first.
 * - **Removing a blob from one class does not necessarily drop a derivative** — another subscriber may
 *   still want it. Callers that prune must diff against this set, never against one class's list.
 *
 * @param settings - The workspace compression settings (registry + workspace subscription).
 * @param classIds - The classes this blob belongs to (its manifest `classes[]`). Omit for the
 *   workspace-only set.
 * @param classPresets - classId → subscribed preset ids, from {@link readClassPresetMap}. Omit to
 *   ignore per-class subscriptions entirely.
 * @returns The subscribed presets, in registry order, deduplicated.
 */
export function presetsForBlob(
	settings: CompressionSettings,
	classIds?: readonly string[],
	classPresets?: ReadonlyMap<string, string[]>
): CompressionPreset[] {
	const subscribed = new Set(settings.workspacePresets);
	if (classIds && classPresets) {
		for (const classId of classIds) {
			for (const presetId of classPresets.get(classId) ?? []) subscribed.add(presetId);
		}
	}
	return settings.presets.filter((p) => subscribed.has(p.id));
}
