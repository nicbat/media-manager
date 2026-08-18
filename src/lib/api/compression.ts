/**
 * Client wrappers + DTO types for the `/api/compression` surface (Item 15, phase 1).
 *
 * These mirror the server-side shapes declared in `$lib/storage/compressionSettings.ts`,
 * `$lib/server/compression/stats.ts`, `$lib/server/compression/queue.ts` and
 * `.../sweep.ts`. They are re-declared rather than imported because those modules pull in
 * `node:fs` and can never reach a browser bundle.
 *
 * Unlike `$lib/api/files.ts` these wrappers do **not** re-validate with Zod. The compression report is
 * a wide, deeply nested read-only projection that only this page consumes, and client + server always
 * ship together from the same build, so a second schema would be pure duplication with a real drift
 * cost. Writes (the settings PATCH) are validated server-side by `CompressionSettingsSchema`.
 *
 * Concerns / future improvements: if the report ever becomes a public/reader-facing payload, promote
 * these types into `src/lib/core/` and validate them like the rest of the API surface.
 */

import { hasAllowedImageExtension } from '$lib/core/images.js';

/** Output container a preset encodes to (mirrors `CompressionFormatSchema`). */
export type CompressionFormat = 'webp' | 'avif' | 'jpeg' | 'png';

/** A preset id must be a safe path segment — it becomes a directory name under `derived/`. */
export const PRESET_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Encoder quality bounds accepted by the server. */
export const MIN_QUALITY = 1;
export const MAX_QUALITY = 100;

/**
 * Target-width bounds accepted by the server (`CompressionPresetSchema.width`). Absent ⇒ full size.
 * The upper bound is deliberately generous — it exists to reject a typo (`40000`), not to express
 * an opinion about how large a derivative should be.
 */
export const MIN_WIDTH = 1;
export const MAX_WIDTH = 20000;

/** One compression recipe: a format, a quality, and an optional target width. */
export interface CompressionPreset {
	id: string;
	label?: string;
	format: CompressionFormat;
	quality: number;
	/**
	 * Target width in pixels — the derivative is downscaled to fit (aspect preserved, never upscaled).
	 * Absent ⇒ a same-dimension twin of the original.
	 */
	width?: number;
}

/** The `compression` block of `media/settings.json`. */
export interface CompressionSettings {
	autoCompress: boolean;
	presets: CompressionPreset[];
	/** Preset ids applied to **every** image. Phase 1's only subscription. */
	workspacePresets: string[];
}

/** Savings for one preset: what a page saves by serving it instead of the original. */
export interface PresetStats {
	presetId: string;
	label: string;
	recipe: string;
	generated: number;
	originalBytes: number;
	derivedBytes: number;
	savedBytes: number;
	medianSsim: number | null;
	/** True when the preset resizes, so its scores measure codec loss at a smaller size. */
	resized: boolean;
}

/** One low-scoring derivative surfaced for review. */
export interface FlaggedFile {
	fileId: string;
	fileName: string;
	presetId: string;
	originalSize: number | null;
	derivedSize: number | null;
	ssim: number;
}

/** One reason a blob has no derivative, with a count and examples. */
export interface UncompressedGroup {
	key: string;
	label: string;
	count: number;
	examples: string[];
}

/** Everything the Compression page renders. */
export interface CompressionStats {
	totalFiles: number;
	coveredFiles: number;
	uncompressibleFiles: number;
	pendingFiles: number;
	staleDerivatives: number;
	headline: PresetStats | null;
	perPreset: PresetStats[];
	histogram: { key: string; label: string; count: number }[];
	medianSsim: number | null;
	flaggedCount: number;
	flagged: FlaggedFile[];
	/** `classId` → saved bytes; the id `__unclassified` is the catch-all bucket. */
	byClass: { classId: string; savedBytes: number; files: number }[];
	uncompressible: UncompressedGroup[];
}

/** Live state of the background compression job. */
export interface CompressionJobState {
	running: boolean;
	/**
	 * True while the run is still working out what needs doing, so `total`/`done` are not yet meaningful
	 * — render a "working it out…" state rather than a confident `0 / 0`, which reads as a stall.
	 */
	planning: boolean;
	total: number;
	done: number;
	savedBytes: number;
	generated: number;
	skipped: number;
	flagged: number;
	startedAt: string | null;
	finishedAt: string | null;
	cancelling: boolean;
	error: string | null;
}

/** The one-shot payload `GET /api/compression` returns. */
export interface CompressionReport {
	settings: CompressionSettings;
	stats: CompressionStats;
	job: CompressionJobState;
	/** classId → display name, for the per-class savings breakdown. */
	classNames: Record<string, string>;
}

/**
 * Why a preset produced no derivative for a blob. Mirrors the server's `skipped` reason; a skip is
 * recorded *with its recipe* so it is never retried until the recipe changes.
 */
export type CompressionSkipReason = 'unsupported' | 'larger' | 'error';

/**
 * One preset's outcome for one blob (a row of `GET /api/files/[id]/compression`).
 *
 * Rows describe the blob's **subscribed** set — the union of the workspace subscription and every
 * class it belongs to — so a row with `generated: false` and no `skipped` reason is simply *pending*.
 */
export interface FilePresetCompression {
	presetId: string;
	label: string;
	/** Machine recipe (`webp:q80:w400`); render it through {@link humanizeRecipe}. */
	recipe: string;
	/** True when the preset resizes, so its SSIM measures codec loss **at that smaller size**. */
	resized: boolean;
	generated: boolean;
	skipped: CompressionSkipReason | null;
	/** The recipe (or the original) changed since generation — the worker will rebuild it. */
	stale: boolean;
	originalSize: number | null;
	size: number | null;
	width: number | null;
	height: number | null;
	ssim: number | null;
	savedBytes: number | null;
	generatedAt: string | null;
	src: string | null;
}

/** Everything `GET /api/files/[id]/compression` returns for one blob. */
export interface FileCompressionDetail {
	fileId: string;
	fileName: string;
	originalSize: number | null;
	/** False for a file type that is never compressed (a PDF, a zip…) — report it, don't show an empty table. */
	compressible: boolean;
	presets: FilePresetCompression[];
}

/** What a sweep did (or, in `dryRun`, would do). */
export interface SweepResult {
	removed: string[];
	bytes: number;
	removedPresetDirs: string[];
	/** Set when the sweep declined to run (e.g. a backfill is still going). */
	skippedReason?: string;
	dryRun: boolean;
	/** In static-assets mode a deployed site may still reference "orphaned" derivatives. */
	staticAssetsMode: boolean;
}

/** The `byClass` key used for blobs that belong to no class. */
export const UNCLASSIFIED_CLASS_ID = '__unclassified';

/**
 * Throw a useful `Error` for a non-2xx response, else return the parsed JSON body.
 *
 * @param res - The fetch response.
 * @param msg - Human prefix for the thrown error ("Failed to load the compression report").
 */
async function jsonOrThrow<T>(res: Response, msg: string): Promise<T> {
	if (!res.ok) {
		let details = '';
		try {
			details = await res.text();
		} catch {
			/* body already consumed / not readable — the status alone still tells the story */
		}
		throw new Error(`${msg} (status ${res.status})${details ? `: ${details}` : ''}`);
	}
	return (await res.json()) as T;
}

/** GET /api/compression — settings + stats + job + class names in one consistent read. */
export async function apiGetCompressionReport(
	fetchFn: typeof fetch = fetch
): Promise<CompressionReport> {
	return jsonOrThrow<CompressionReport>(
		await fetchFn('/api/compression'),
		'Failed to load the compression report'
	);
}

/**
 * GET /api/compression/settings — just the preset registry + subscriptions.
 *
 * Use case: a view that needs to *name* presets without wanting the whole report — the per-class
 * subscription section of the entity-settings dialog, which opens far more often than `/compression`
 * and has no use for stats, the job, or class names.
 */
export async function apiGetCompressionSettings(
	fetchFn: typeof fetch = fetch
): Promise<CompressionSettings> {
	const body = await jsonOrThrow<{ settings: CompressionSettings }>(
		await fetchFn('/api/compression/settings'),
		'Failed to load compression presets'
	);
	return body.settings;
}

/**
 * GET /api/files/[id]/compression — one blob's per-preset detail.
 *
 * Separate from the grid's `FileItem.compression` summary on purpose: this is fetched only for the
 * single blob whose editor is open, so it can afford a row per subscribed preset.
 *
 * @param id - The blob's manifest id.
 */
export async function apiGetFileCompression(
	id: string,
	fetchFn: typeof fetch = fetch
): Promise<FileCompressionDetail> {
	return jsonOrThrow<FileCompressionDetail>(
		await fetchFn(`/api/files/${id}/compression`),
		'Failed to load compression detail'
	);
}

/** GET /api/compression/backfill — the cheap job-only poll used while a backfill runs. */
export async function apiGetCompressionJob(
	fetchFn: typeof fetch = fetch
): Promise<CompressionJobState> {
	const body = await jsonOrThrow<{ job: CompressionJobState }>(
		await fetchFn('/api/compression/backfill'),
		'Failed to read the compression job'
	);
	return body.job;
}

/** POST /api/compression/backfill — start (or join) the backfill; returns immediately. */
export async function apiStartBackfill(
	fetchFn: typeof fetch = fetch
): Promise<CompressionJobState> {
	const body = await jsonOrThrow<{ job: CompressionJobState }>(
		await fetchFn('/api/compression/backfill', { method: 'POST' }),
		'Failed to start the backfill'
	);
	return body.job;
}

/** DELETE /api/compression/backfill — request cancellation (stops after the in-flight files). */
export async function apiCancelBackfill(
	fetchFn: typeof fetch = fetch
): Promise<CompressionJobState> {
	const body = await jsonOrThrow<{ job: CompressionJobState }>(
		await fetchFn('/api/compression/backfill', { method: 'DELETE' }),
		'Failed to cancel the backfill'
	);
	return body.job;
}

/**
 * PATCH /api/compression/settings — update the preset registry / subscriptions.
 *
 * The server kicks the worker itself when a change makes derivatives stale, so the response's
 * `regenerating` flag is a *statement of fact* for the UI to report — never a prompt to confirm.
 */
export async function apiSaveCompressionSettings(
	patch: Partial<CompressionSettings>,
	fetchFn: typeof fetch = fetch
): Promise<{ settings: CompressionSettings; job: CompressionJobState; regenerating: boolean }> {
	return jsonOrThrow(
		await fetchFn('/api/compression/settings', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(patch)
		}),
		'Failed to save compression settings'
	);
}

/**
 * POST /api/compression/sweep — delete derivative files nothing references any more.
 *
 * @param dryRun - Report what would be removed without deleting anything (always call this first).
 */
export async function apiSweepDerived(
	dryRun: boolean,
	fetchFn: typeof fetch = fetch
): Promise<SweepResult> {
	return jsonOrThrow<SweepResult>(
		await fetchFn(`/api/compression/sweep${dryRun ? '?dryRun=1' : ''}`, { method: 'POST' }),
		'Failed to sweep unused derivatives'
	);
}

/** Re-exported so a compression view needs one import for both the data and its formatting. */
export { formatBytes } from '$lib/core/bytes.js';

/**
 * Compressible containers the generator handles but that aren't in `ALLOWED_IMAGE_EXTENSIONS` (which
 * is an *upload* allowlist, not an encoder capability list).
 */
const EXTRA_COMPRESSIBLE_EXTENSIONS = ['.tif', '.tiff', '.avif'];

/**
 * Is it worth asking the server for this blob's compression detail at all?
 *
 * Use case: the per-file editor opens for every blob, including PDFs and zips that can never have a
 * derivative — fetching for those would be a pointless round trip on every panel open.
 *
 * Deliberately a **superset** of the generator's own list (`storage/derived.ts`, which is server-only
 * and can't be imported here): it errs towards asking, so drift between the two can cost a wasted
 * request but never a missing section. The response's `compressible` flag stays authoritative for what
 * is actually rendered — a GIF or SVG passes this gate and is then reported as not compressed.
 *
 * @param fileName - The blob's current filename.
 */
export function mayHaveDerivatives(fileName: string): boolean {
	if (hasAllowedImageExtension(fileName)) return true;
	const dot = fileName.lastIndexOf('.');
	if (dot < 0) return false;
	return EXTRA_COMPRESSIBLE_EXTENSIONS.includes(fileName.slice(dot).toLowerCase());
}

/**
 * A rough `~2m 5s` / `~40s` duration, for the backfill's remaining-time estimate.
 *
 * @param ms - Milliseconds remaining; non-finite or negative inputs yield `null` so the caller can
 *   simply omit the estimate rather than print nonsense.
 */
export function formatDuration(ms: number): string | null {
	if (!Number.isFinite(ms) || ms < 0) return null;
	const total = Math.round(ms / 1000);
	if (total < 60) return `${Math.max(total, 1)}s`;
	const m = Math.floor(total / 60);
	const s = total % 60;
	return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/** A preset's human label — the optional `label`, else its id. */
export function presetLabel(preset: CompressionPreset): string {
	return preset.label?.trim() || preset.id;
}

/** Cased container names — `WEBP`/`JPEG` from a blind `toUpperCase()` reads like shouting. */
const FORMAT_LABELS: Record<CompressionFormat, string> = {
	webp: 'WebP',
	avif: 'AVIF',
	jpeg: 'JPEG',
	png: 'PNG'
};

/** A format's display name (`webp` → `WebP`), falling back to the raw value for an unknown one. */
export function formatName(format: string): string {
	return FORMAT_LABELS[format as CompressionFormat] ?? format.toUpperCase();
}

/**
 * A preset's recipe as a person reads it — `WebP q80`, or `WebP q70 · 400w` when it resizes.
 *
 * Use case: any place a preset is *chosen* rather than edited (the per-class subscription checkboxes),
 * where the id and label alone don't say what you're signing up for. The width is deliberately part of
 * the same line: a preset with a width produces a **different size**, not just a different quality,
 * and that distinction drives what the derivative can be used for.
 *
 * @param preset - The preset to describe.
 */
export function presetRecipe(preset: CompressionPreset): string {
	const base = `${formatName(preset.format)} q${preset.quality}`;
	return preset.width ? `${base} · ${preset.width}w` : base;
}

/**
 * Humanise the server's machine recipe string (`webp:q80:w400` → `WebP q80 · 400w`).
 *
 * The per-file endpoint sends the stored recipe (the staleness key) rather than the preset object, so
 * this is the read-side twin of {@link presetRecipe}. Anything that doesn't parse is passed through
 * verbatim — a recipe we can't read is still more useful on screen than an empty string.
 *
 * @param recipe - A recipe string as stored on a derivative record.
 */
export function humanizeRecipe(recipe: string): string {
	const m = /^([a-z0-9]+):q(\d+)(?::w(\d+))?$/.exec(recipe);
	if (!m) return recipe;
	const base = `${formatName(m[1])} q${m[2]}`;
	return m[3] ? `${base} · ${m[3]}w` : base;
}

/**
 * SSIM buckets, mirroring `server/compression/stats.ts` so the per-file panel and the Compression
 * page's histogram never disagree about what ".982" is called. Descending by threshold.
 */
const SSIM_BUCKETS: { min: number; label: string }[] = [
	{ min: 0.995, label: 'identical' },
	{ min: 0.99, label: 'imperceptible' },
	{ min: 0.97, label: 'excellent' },
	{ min: 0.94, label: 'slight loss' },
	{ min: 0, label: 'visible loss' }
];

/**
 * The quality adjective a score actually supports — never guess one for a missing score.
 *
 * @param ssim - A structural-similarity score in 0–1, or null when the derivative wasn't scored.
 * @returns The bucket label, or `null` when there is no score (the caller must then say nothing about
 *   quality rather than defaulting to a flattering word).
 */
export function ssimLabel(ssim: number | null): string | null {
	if (ssim == null || !Number.isFinite(ssim)) return null;
	return SSIM_BUCKETS.find((b) => ssim >= b.min)?.label ?? null;
}
