import fs from 'node:fs/promises';
import path from 'node:path';

import { getDerivedDir, getDerivedRootDir } from '$lib/storage/paths.js';
import { readManifest } from '$lib/storage/manifest.js';
import { readCompressionSettings } from '$lib/storage/compressionSettings.js';
import { getJobState } from './queue.js';

/**
 * The derivative **sweep** (Item 15): delete files under `derived/` that the manifest no longer
 * references.
 *
 * Regeneration leaves orphans behind whenever the output name changes — a preset switched from WebP to
 * AVIF, a blob renamed, a preset deleted, an original removed. Nothing reads those files (every lookup
 * goes through the manifest), so they are pure wasted bytes rather than a correctness problem, which is
 * why this is a separate deliberate pass rather than part of generation.
 *
 * **Manifest-authoritative, like every other bulk operation here:** a file is removed iff no manifest
 * entry claims it. Nothing outside `derived/` is ever touched.
 */

/** What a sweep did (or, in `dryRun`, would do). */
export interface SweepResult {
	/** Relative `<preset>/<name>` paths removed. */
	removed: string[];
	/** Bytes reclaimed. */
	bytes: number;
	/** Preset directories removed wholesale (the preset no longer exists). */
	removedPresetDirs: string[];
	/** Set when the sweep declined to run. */
	skippedReason?: string;
}

/**
 * Remove unreferenced derivative files.
 *
 * @param opts.dryRun - Report what would be removed without deleting anything.
 * @returns The {@link SweepResult}.
 *
 * Concerns / future improvements:
 * - Declines to run while the compression worker is active: an in-flight encode's `.tmp-*` file is
 *   unreferenced by construction, and deleting it under the worker would corrupt that derivative.
 * - In **static-assets mode** a deployed site may still be serving a file this sweep considers orphaned
 *   (its manifest moved on, the deployment hasn't). Callers should offer it as a manual action there and
 *   run it after the next export, not automatically.
 */
export async function sweepDerived(opts?: { dryRun?: boolean }): Promise<SweepResult> {
	const dryRun = opts?.dryRun ?? false;
	const result: SweepResult = { removed: [], bytes: 0, removedPresetDirs: [] };

	if (getJobState().running) {
		return { ...result, skippedReason: 'Compression is still running — sweep after it finishes.' };
	}

	const rootDir = getDerivedRootDir();
	let presetDirs: string[];
	try {
		const dirents = await fs.readdir(rootDir, { withFileTypes: true });
		presetDirs = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
	} catch {
		return result; // no derived tree yet — nothing to sweep
	}

	const manifest = await readManifest();
	const knownPresets = new Set(readCompressionSettings().presets.map((p) => p.id));

	// preset id → the derivative filenames the manifest currently claims.
	const referenced = new Map<string, Set<string>>();
	for (const entry of Object.values(manifest.files)) {
		for (const [presetId, d] of Object.entries(entry.derived ?? {})) {
			if (!d.file_name) continue;
			let set = referenced.get(presetId);
			if (!set) referenced.set(presetId, (set = new Set()));
			set.add(d.file_name);
		}
	}

	for (const presetId of presetDirs) {
		const dir = getDerivedDir(presetId);
		const keep = referenced.get(presetId) ?? new Set<string>();
		const dropWholeDir = !knownPresets.has(presetId);

		let names: string[];
		try {
			const dirents = await fs.readdir(dir, { withFileTypes: true });
			names = dirents.filter((d) => d.isFile()).map((d) => d.name);
		} catch {
			continue;
		}

		for (const name of names) {
			if (!dropWholeDir && keep.has(name)) continue;
			const full = path.join(dir, name);
			const size = await fs
				.stat(full)
				.then((s) => s.size)
				.catch(() => 0);
			if (!dryRun) await fs.unlink(full).catch(() => {});
			result.removed.push(`${presetId}/${name}`);
			result.bytes += size;
		}

		if (dropWholeDir) {
			if (!dryRun) await fs.rmdir(dir).catch(() => {});
			result.removedPresetDirs.push(presetId);
		}
	}

	return result;
}
