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

/** Output container a preset encodes to (mirrors `CompressionFormatSchema`). */
export type CompressionFormat = 'webp' | 'avif' | 'jpeg' | 'png';

/** A preset id must be a safe path segment — it becomes a directory name under `derived/`. */
export const PRESET_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Encoder quality bounds accepted by the server. */
export const MIN_QUALITY = 1;
export const MAX_QUALITY = 100;

/** One compression recipe: a format, a quality, and (phase 2) an optional target width. */
export interface CompressionPreset {
	id: string;
	label?: string;
	format: CompressionFormat;
	quality: number;
	/** Phase 2 only — carried through untouched by the phase-1 UI, never offered for editing. */
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
