import { readManifest, type DerivedEntry, type Manifest } from '$lib/storage/manifest.js';
import {
	presetsForBlob,
	readCompressionSettings,
	recipeOf,
	type CompressionPreset,
	type CompressionSettings
} from '$lib/storage/compressionSettings.js';
import { fileExtension } from '$lib/core/images.js';
import { isCompressibleFilename, isStale, readClassPresetMap } from '$lib/storage/derived.js';
import { FLAGGED_SSIM } from './queue.js';

/**
 * The **Compression page's** whole data payload (Item 15), computed from the manifest in one read.
 *
 * The page answers three questions in descending order of how often they're asked — *how much am I
 * saving*, *is anything degraded*, and *is anything not done yet* — so the headline is bytes, with
 * quality sitting beside it precisely so a great savings number can never be read without its cost.
 *
 * Everything here is derived from data already recorded at generation time; nothing re-reads a blob or
 * recomputes a score, so this is cheap enough to be the page's poll target.
 */

/** How many low-scoring files the "needs a look" list surfaces. */
const FLAGGED_LIMIT = 20;

/** SSIM histogram buckets, coarsest-to-finest as displayed. */
export const SSIM_BUCKETS = [
	{ key: 'identical', label: 'identical', min: 0.995 },
	{ key: 'imperceptible', label: 'imperceptible', min: 0.99 },
	{ key: 'excellent', label: 'excellent', min: 0.97 },
	{ key: 'slight', label: 'slight', min: 0.94 },
	{ key: 'visible', label: 'visible', min: 0 }
] as const;

/** Savings for one preset: what a page saves by serving it instead of the original. */
export interface PresetStats {
	presetId: string;
	label: string;
	recipe: string;
	/** Blobs with a generated derivative under this preset. */
	generated: number;
	/** Σ original bytes over those blobs. */
	originalBytes: number;
	/** Σ derivative bytes over those blobs. */
	derivedBytes: number;
	/** `originalBytes − derivedBytes` (never negative in practice — bigger outputs are discarded). */
	savedBytes: number;
	/** Median SSIM across this preset's derivatives, or null when none scored. */
	medianSsim: number | null;
	/** True when the preset resizes, so its scores measure codec loss at a smaller size (see `ssim.ts`). */
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
	/** `unsupported` grouped by extension (`.pdf`), or the literal `larger`. */
	key: string;
	label: string;
	count: number;
	examples: string[];
}

/** Everything the Compression page renders. */
export interface CompressionStats {
	/** Total non-missing blobs in the workspace. */
	totalFiles: number;
	/** Blobs with at least one generated derivative under a subscribed preset. */
	coveredFiles: number;
	/** Blobs that cannot produce one (unsupported type, or the re-encode grew). */
	uncompressibleFiles: number;
	/** Blobs that could be compressed but have no up-to-date derivative yet. */
	pendingFiles: number;
	/** Derivatives whose recipe or source has changed since generation. */
	staleDerivatives: number;
	/** Headline savings — the primary (first subscribed) preset. */
	headline: PresetStats | null;
	perPreset: PresetStats[];
	/** SSIM bucket → count, across every generated derivative. */
	histogram: { key: string; label: string; count: number }[];
	medianSsim: number | null;
	flaggedCount: number;
	flagged: FlaggedFile[];
	/** classId → bytes saved by its members under the primary preset (plus an `unclassified` row). */
	byClass: { classId: string; savedBytes: number; files: number }[];
	uncompressible: UncompressedGroup[];
}

/** The bucket key an SSIM score falls into. */
function bucketFor(ssim: number): string {
	for (const b of SSIM_BUCKETS) if (ssim >= b.min) return b.key;
	return SSIM_BUCKETS[SSIM_BUCKETS.length - 1].key;
}

/** Median of a numeric list (null when empty). Sorts a copy. */
function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** A derivative record that actually produced a file. */
function isGenerated(d: DerivedEntry | undefined): d is DerivedEntry & { file_name: string } {
	return !!d?.file_name && !d.skipped;
}

/** Per-preset savings + median quality. */
function statsForPreset(
	manifest: Manifest,
	preset: CompressionPreset,
	recipe: string
): PresetStats {
	let generated = 0;
	let originalBytes = 0;
	let derivedBytes = 0;
	const scores: number[] = [];

	for (const entry of Object.values(manifest.files)) {
		const d = entry.derived?.[preset.id];
		if (!isGenerated(d)) continue;
		generated++;
		originalBytes += d.source_size ?? entry.size ?? 0;
		derivedBytes += d.size ?? 0;
		if (d.ssim != null) scores.push(d.ssim);
	}

	return {
		presetId: preset.id,
		label: preset.label || preset.id,
		recipe,
		generated,
		originalBytes,
		derivedBytes,
		savedBytes: Math.max(0, originalBytes - derivedBytes),
		medianSsim: median(scores),
		resized: preset.width != null
	};
}

/**
 * Compute the full Compression page payload.
 *
 * @param settings - Compression settings; read from disk when omitted.
 * @returns The {@link CompressionStats}.
 *
 * Concerns / future improvements:
 * - Savings are reported **per preset** rather than as one workspace total, because with more than one
 *   preset "bytes saved" is only well-defined against a specific one — a page serving `thumb` saves a
 *   different amount than one serving `web`, and summing every derivative's bytes against one original
 *   would make a second preset look like a *loss*. The headline uses the first subscribed preset; phase
 *   2's ladder keeps that framing intact.
 */
export async function computeCompressionStats(
	settings?: CompressionSettings
): Promise<CompressionStats> {
	const config = settings ?? readCompressionSettings();
	const classPresets = readClassPresetMap();
	const manifest = await readManifest();

	// Phase 2: a blob's preset set is the union of the workspace subscription and its classes', so
	// coverage has to be judged per blob. `subscribedAnywhere` is only for the per-preset report rows.
	const anywhere = new Set(config.workspacePresets);
	for (const ids of classPresets.values()) for (const id of ids) anywhere.add(id);
	const subscribed = config.presets.filter((p) => anywhere.has(p.id));

	const perPreset = subscribed.map((p) => statsForPreset(manifest, p, recipeOf(p)));
	// The headline is the workspace-wide preset — the one every image gets — so it stays a like-for-like
	// number as class subscriptions come and go.
	const primary =
		config.presets.find((p) => p.id === config.workspacePresets[0]) ?? subscribed[0] ?? null;

	let totalFiles = 0;
	let coveredFiles = 0;
	let uncompressibleFiles = 0;
	let pendingFiles = 0;
	let staleDerivatives = 0;
	const allScores: number[] = [];
	const histogram = new Map<string, number>(SSIM_BUCKETS.map((b) => [b.key, 0]));
	const flagged: FlaggedFile[] = [];
	const classSaved = new Map<string, { savedBytes: number; files: number }>();
	const groups = new Map<string, UncompressedGroup>();

	for (const [fileId, entry] of Object.entries(manifest.files)) {
		if (entry.missing) continue;
		totalFiles++;

		let covered = false;
		let blocked = false;

		for (const preset of presetsForBlob(config, entry.classes, classPresets)) {
			const d = entry.derived?.[preset.id];
			// "Stale" means a derivative that *exists* but is out of date. One that was never generated is
			// `pendingFiles`, not stale — counting it as both would double it in the backfill button's
			// "N files to do", since that is `pendingFiles + staleDerivatives`.
			if (d && isStale(d, preset, entry.size)) staleDerivatives++;

			if (isGenerated(d)) {
				if (d.ssim != null) {
					allScores.push(d.ssim);
					histogram.set(bucketFor(d.ssim), (histogram.get(bucketFor(d.ssim)) ?? 0) + 1);
					if (d.ssim < FLAGGED_SSIM) {
						flagged.push({
							fileId,
							fileName: entry.file_name,
							presetId: preset.id,
							originalSize: d.source_size ?? entry.size ?? null,
							derivedSize: d.size ?? null,
							ssim: d.ssim
						});
					}
				}
				if (preset.id === primary?.id) {
					covered = true;
					const saved = Math.max(0, (d.source_size ?? entry.size ?? 0) - (d.size ?? 0));
					const owners = entry.classes.length > 0 ? entry.classes : ['__unclassified'];
					for (const cid of owners) {
						const row = classSaved.get(cid) ?? { savedBytes: 0, files: 0 };
						row.savedBytes += saved;
						row.files++;
						classSaved.set(cid, row);
					}
				}
			} else if (d?.skipped && preset.id === primary?.id) {
				blocked = true;
				// `larger` and `error` are reasons in their own right; `unsupported` is really a statement
				// about the *file type*, so those group by extension ("5 PDF files") — the form the page can
				// actually act on.
				const key =
					d.skipped === 'unsupported' ? fileExtension(entry.file_name) || 'unknown' : d.skipped;
				const label =
					d.skipped === 'larger'
						? 'grew under re-encode'
						: d.skipped === 'error'
							? 'could not be read'
							: `${key.replace('.', '').toUpperCase() || 'unknown'} files`;
				const group = groups.get(key) ?? { key, label, count: 0, examples: [] };
				group.count++;
				if (group.examples.length < 4) group.examples.push(entry.file_name);
				groups.set(key, group);
			}
		}

		if (covered) coveredFiles++;
		else if (blocked) uncompressibleFiles++;
		else if (isCompressibleFilename(entry.file_name)) pendingFiles++;
		else uncompressibleFiles++;
	}

	flagged.sort((a, b) => a.ssim - b.ssim);

	return {
		totalFiles,
		coveredFiles,
		uncompressibleFiles,
		pendingFiles,
		staleDerivatives,
		headline: perPreset[0] ?? null,
		perPreset,
		histogram: SSIM_BUCKETS.map((b) => ({
			key: b.key,
			label: b.label,
			count: histogram.get(b.key) ?? 0
		})),
		medianSsim: median(allScores),
		flaggedCount: flagged.length,
		flagged: flagged.slice(0, FLAGGED_LIMIT),
		byClass: [...classSaved.entries()]
			.map(([classId, v]) => ({ classId, ...v }))
			.sort((a, b) => b.savedBytes - a.savedBytes),
		// Pluralize only now that the counts are final ("1 TXT file" vs "4 TXT files"). The reason-based
		// groups (`grew under re-encode`, `could not be read`) read the same either way.
		uncompressible: [...groups.values()]
			.map((g) => (g.count === 1 ? { ...g, label: g.label.replace(/ files$/, ' file') } : g))
			.sort((a, b) => b.count - a.count)
	};
}
