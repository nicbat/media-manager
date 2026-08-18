import fs from 'node:fs/promises';
import os from 'node:os';

import { getDerivedDir } from '$lib/storage/paths.js';
import { readManifest, setDerivedEntries, type DerivedEntry } from '$lib/storage/manifest.js';
import {
	presetsForBlob,
	readCompressionSettings,
	type CompressionPreset
} from '$lib/storage/compressionSettings.js';
import { isCompressibleFilename, isStale, resolveDerivedName } from '$lib/storage/derived.js';
import { generateDerivative } from './generate.js';

/**
 * The compression **worker** (Item 15): a single in-process job that generates missing/stale
 * derivatives in the background, batching its manifest writes.
 *
 * ## Why this is real infrastructure and not a `for` loop
 *
 * Generation must never block a request — an upload responds as soon as the blob is registered and the
 * derivative is queued behind it — and it must not starve the rest of the app while it runs:
 *
 * - Every grid read goes through `listAllFiles → reconcile`, which takes the **manifest lock**.
 *   {@link withFileLock} retries 40 times with a `10 + attempt×5 ms` backoff — roughly 4.3s and then it
 *   *throws*. A backfill taking that lock once per file would start failing user requests outright.
 * - Each manifest write is an O(n) rewrite of the whole JSON document, so per-file writes are O(n²) in
 *   the workspace size.
 * - The lock's 10s stale-TTL means a holder that overruns has its lock deleted by a waiter, giving two
 *   concurrent writers and lost `derived` blocks.
 *
 * So results are **batched** ({@link FLUSH_EVERY} / {@link FLUSH_AFTER_MS}) into one lock acquisition per
 * batch, encode concurrency is bounded against lock contention rather than CPU count alone, and the lock
 * is never held across an encode.
 *
 * ## Single-node only
 *
 * State lives in module scope, matching the rest of the storage layer's single-node assumption. That is
 * also what lets the Compression page be navigated away from and back to mid-run: the job's state is on
 * the server, not in the page.
 */

/** Encode concurrency. Bounded low: the constraint is manifest-lock contention, not raw CPU. */
const CONCURRENCY = Math.max(1, Math.min(3, (os.cpus()?.length ?? 2) - 1));

/** Flush accumulated results to the manifest after this many completed derivatives. */
const FLUSH_EVERY = 20;

/** …or after this long, so a slow trickle still reports progress. */
const FLUSH_AFTER_MS = 1500;

/** SSIM below this is surfaced in the Compression page's "needs a look" list. */
export const FLAGGED_SSIM = 0.94;

/** Live state of the background compression job, polled by the Compression page. */
export interface CompressionJobState {
	running: boolean;
	/**
	 * True while the run is working out what needs doing (scanning the manifest for missing/stale
	 * derivatives) and `total` is therefore not yet meaningful. Without this the UI would render a
	 * confident "Compressing 0 files · 0 / 0" for the first moment of every backfill.
	 */
	planning: boolean;
	/** Derivatives to produce in this run (grows if more work is scheduled mid-run). */
	total: number;
	/** Derivatives finished (generated **or** skipped). */
	done: number;
	/** Bytes saved so far: Σ(original − derivative) over generated derivatives. */
	savedBytes: number;
	generated: number;
	skipped: number;
	/** Derivatives scoring below {@link FLAGGED_SSIM}. */
	flagged: number;
	startedAt: string | null;
	finishedAt: string | null;
	/** True once a cancel was requested; the job stops after the in-flight files finish. */
	cancelling: boolean;
	/** Last fatal error, if the run aborted for a reason other than a per-file failure. */
	error: string | null;
}

/** One unit of work: produce this preset's derivative for this blob. */
interface WorkItem {
	fileId: string;
	fileName: string;
	preset: CompressionPreset;
	derivedName: string;
	sourceSize: number | undefined;
}

const state: CompressionJobState = {
	running: false,
	planning: false,
	total: 0,
	done: 0,
	savedBytes: 0,
	generated: 0,
	skipped: 0,
	flagged: 0,
	startedAt: null,
	finishedAt: null,
	cancelling: false,
	error: null
};

/** Blob ids scheduled but not yet planned. `'all'` means "sweep the whole workspace". */
let pending: Set<string> | 'all' | null = null;

/** The in-flight run, so a second schedule joins it instead of starting a parallel worker. */
let loop: Promise<void> | null = null;

/** A snapshot of the job state (safe to serialize straight to the client). */
export function getJobState(): CompressionJobState {
	return { ...state };
}

/** Request cancellation. The run stops after the in-flight encodes finish; everything already generated stays. */
export function cancelJob(): CompressionJobState {
	if (state.running) state.cancelling = true;
	pending = null;
	return getJobState();
}

/**
 * Schedule compression work and return immediately — **this never awaits the encode**, which is what
 * keeps upload responses fast.
 *
 * @param target - Specific blob ids (an upload/import) or `'all'` (the backfill job).
 * @returns The job state as of scheduling.
 *
 * Concerns / future improvements:
 * - Scheduling during a run merges into it, so `total` can grow mid-run; the UI shows a moving target
 *   rather than a second progress bar.
 */
export function scheduleCompression(target: string[] | 'all'): CompressionJobState {
	if (target === 'all') {
		pending = 'all';
	} else {
		if (target.length === 0) return getJobState();
		if (pending !== 'all') {
			pending = pending ?? new Set<string>();
			for (const id of target) pending.add(id);
		}
	}
	ensureLoop();
	return getJobState();
}

/**
 * Start the worker loop if it isn't already running.
 *
 * The re-check in `finally` closes a real race: work scheduled *while* the previous run was settling
 * would see a non-null `loop`, decline to start, and then never run once that promise cleared.
 */
function ensureLoop(): void {
	if (loop) return;
	loop = runLoop()
		.catch((err) => {
			state.error = (err as Error).message;
		})
		.finally(() => {
			loop = null;
			state.running = false;
			state.planning = false;
			state.cancelling = false;
			state.finishedAt = new Date().toISOString();
			if (pending) ensureLoop();
		});
}

/**
 * Await the currently-running job, if any. Tests and the backfill endpoint's synchronous mode use this;
 * request handlers deliberately do not.
 */
export async function waitForIdle(): Promise<void> {
	while (loop) await loop;
}

/**
 * Plan the work for a drain: which (blob × preset) pairs are missing or stale right now.
 *
 * Also builds the per-preset name-ownership index that {@link resolveDerivedName} needs, so two
 * originals sharing a stem (`photo.jpg` + `photo.png`) get distinct derivative filenames.
 *
 * @param target - Blob ids to consider, or `'all'`.
 */
async function planWork(target: Set<string> | 'all'): Promise<WorkItem[]> {
	const settings = readCompressionSettings();
	const presets = presetsForBlob(settings);
	if (presets.length === 0) return [];

	const manifest = await readManifest();
	// name → owning fileId, per preset: existing claims win, so a regeneration keeps its own name.
	const claimed = new Map<string, Map<string, string>>();
	for (const preset of presets) claimed.set(preset.id, new Map());
	for (const [id, entry] of Object.entries(manifest.files)) {
		for (const [presetId, d] of Object.entries(entry.derived ?? {})) {
			if (d.file_name) claimed.get(presetId)?.set(d.file_name, id);
		}
	}

	// What's actually on disk per preset, so a record whose file has gone is planned as work.
	// `isStale` deliberately compares only the manifest record (recipe + source size), which makes it
	// pure and cheap — but it means a record can claim a file that no longer exists, and then nothing
	// would ever rebuild it. That is exactly the "deleting `media/derived/` is always recoverable by a
	// backfill" promise this module makes, so the filesystem check belongs here, in planning. One
	// `readdir` per preset rather than a `stat` per blob keeps it O(presets), not O(blobs).
	const present = new Map<string, Set<string>>();
	for (const preset of presets) {
		const names = await fs.readdir(getDerivedDir(preset.id)).catch(() => [] as string[]);
		present.set(preset.id, new Set(names));
	}

	const work: WorkItem[] = [];
	for (const [fileId, entry] of Object.entries(manifest.files)) {
		if (target !== 'all' && !target.has(fileId)) continue;
		if (entry.missing) continue;
		for (const preset of presets) {
			const existing = entry.derived?.[preset.id];
			const fileGone = !!existing?.file_name && !present.get(preset.id)!.has(existing.file_name);
			if (!fileGone && !isStale(existing, preset, entry.size)) continue;
			// A non-image needs no name resolution — it will be recorded as skipped, not written.
			const derivedName = isCompressibleFilename(entry.file_name)
				? resolveDerivedName(entry.file_name, fileId, preset, claimed.get(preset.id)!)
				: '';
			if (derivedName) claimed.get(preset.id)!.set(derivedName, fileId);
			work.push({
				fileId,
				fileName: entry.file_name,
				preset,
				derivedName,
				sourceSize: entry.size
			});
		}
	}
	return work;
}

/**
 * Drain the pending set repeatedly until nothing is left, so work scheduled *during* a run is picked up
 * without starting a second worker.
 */
async function runLoop(): Promise<void> {
	state.running = true;
	state.planning = true;
	state.startedAt = new Date().toISOString();
	state.finishedAt = null;
	state.error = null;
	state.total = 0;
	state.done = 0;
	state.savedBytes = 0;
	state.generated = 0;
	state.skipped = 0;
	state.flagged = 0;

	while (pending && !state.cancelling) {
		const target = pending;
		pending = null;
		state.planning = true;
		const work = await planWork(target);
		state.planning = false;
		state.total += work.length;
		await processWork(work);
	}
}

/** Run the work list with bounded concurrency, flushing results to the manifest in batches. */
async function processWork(work: WorkItem[]): Promise<void> {
	let next = 0;
	let batch = new Map<string, Record<string, DerivedEntry>>();
	let batchCount = 0;
	let lastFlush = Date.now();

	const flush = async () => {
		if (batchCount === 0) return;
		const toWrite = batch;
		batch = new Map();
		batchCount = 0;
		lastFlush = Date.now();
		await setDerivedEntries(toWrite);
	};

	const worker = async () => {
		while (next < work.length && !state.cancelling) {
			const item = work[next++];
			const result = await generateDerivative({
				fileId: item.fileId,
				fileName: item.fileName,
				preset: item.preset,
				derivedName: item.derivedName
			});

			const forFile = batch.get(item.fileId) ?? {};
			forFile[item.preset.id] = result;
			batch.set(item.fileId, forFile);
			batchCount++;

			state.done++;
			if (result.skipped) {
				state.skipped++;
			} else {
				state.generated++;
				// Prefer the generator's freshly-stat'ed `source_size` over the planned one: the manifest's
				// `size` is absent for blobs adopted by reconcile, which would silently zero the savings.
				const src = result.source_size ?? item.sourceSize;
				if (src != null && result.size != null) {
					state.savedBytes += Math.max(0, src - result.size);
				}
				if (result.ssim != null && result.ssim < FLAGGED_SSIM) state.flagged++;
			}

			if (batchCount >= FLUSH_EVERY || Date.now() - lastFlush >= FLUSH_AFTER_MS) await flush();
		}
	};

	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, work.length) }, worker));
	await flush();
}
