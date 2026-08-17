import fs from 'node:fs/promises';
import * as fssync from 'node:fs';
import path from 'node:path';

import { getGlobalFilesDir, getManifestPath } from './paths.js';
import { readManifest } from './manifest.js';
import { withFileLock } from './lock.js';

/**
 * Blob-migration engine — the byte-moving half of "change where blobs live" (the storage-location UI).
 *
 * Static-assets mode (Item 45) let blobs live in a host static folder instead of `<root>/media/files`,
 * but only via the config file, read once at launch, and it never *moved* the existing bytes — pointing
 * at a new folder just made every file show as `missing`. This module fills that gap: it relocates the
 * blobs to a new directory as part of the change.
 *
 * **Why it's safe:** the manifest (`media/manifest.json`) stores only `file_name → id`, never a path —
 * the blob folder is resolved fresh each request from {@link getGlobalFilesDir}. So relocating blobs is a
 * pure filesystem move of the bytes plus a config/env update; no manifest rewrite is needed (ids and
 * filenames are unchanged), and metadata (records, class memberships, field values — all keyed by id) is
 * never touched. The only real hazard is doing the bulk move safely, which is what this engine owns:
 *
 * - **Manifest-authoritative.** Only blobs named in the manifest are considered — a shared static
 *   folder's foreign files (favicon, OG images) are never moved or clobbered. Mirrors `export`.
 * - **Copy → verify → delete.** A `move` never unlinks a source until its destination copy is confirmed
 *   the right size, so an interruption can at worst leave bytes in both dirs (recoverable), never lose
 *   them.
 * - **Preflight aborts before touching anything** on a name conflict (a *different* file already at the
 *   destination) or — unless forced — a blob missing at the source.
 * - **Under the manifest lock**, so a concurrent membership/rename write can't interleave.
 *
 * Persisting the new location (config file) and applying it live (env) is the caller's job
 * (`src/lib/server/storageConfig.ts` + the `/api/settings/storage` route) — this module is pure
 * filesystem + report.
 */

/** How the existing blobs are handled when the location changes. */
export type MigrateStrategy = 'move' | 'copy' | 'leave';

/** The read-only preflight report — what a migration *would* do, computed without touching anything. */
export interface MigratePreflight {
	/** Current blob dir (resolved from {@link getGlobalFilesDir}). */
	fromDir: string;
	/** Requested destination dir (absolute). */
	toDir: string;
	strategy: MigrateStrategy;
	/** True when `fromDir` and `toDir` are the same folder — the migration is a no-op. */
	sameDir: boolean;
	/** Total blobs registered in the manifest. */
	blobCount: number;
	/** How many of those blobs are actually present at `fromDir`. */
	presentAtSource: number;
	/** Manifest blob names not found at `fromDir` (would stay `missing` after the move). */
	missingAtSource: string[];
	/** Names where a *different* file already exists at `toDir` — a hard blocker (never clobbered). */
	conflicts: string[];
	/** Bytes that would be transferred (0 for `leave` / `sameDir`). */
	bytesToTransfer: number;
	/** Best-effort free-space check at the destination (true when it can't be determined). */
	freeSpaceOk: boolean;
}

/** One blob that failed to transfer, with the reason. */
export interface MigrateFailure {
	file_name: string;
	error: string;
}

/** The result of an executed migration — the preflight plus what actually happened. */
export interface MigrateResult extends MigratePreflight {
	/** True when preflight blocked the migration and nothing was transferred. */
	aborted: boolean;
	/** Human-readable reason for an abort or no-op. */
	reason?: string;
	moved: number;
	copied: number;
	/** Blobs skipped (already identical at the destination, or a no-op `leave`/`sameDir`). */
	skipped: number;
	failed: MigrateFailure[];
}

/** All blob filenames registered in the manifest (their current names). */
async function manifestBlobNames(): Promise<string[]> {
	const m = await readManifest();
	return Object.values(m.files).map((e) => e.file_name);
}

/** `fs.stat` that resolves to null instead of throwing on ENOENT / any error. */
async function statOrNull(p: string): Promise<fssync.Stats | null> {
	try {
		return await fs.stat(p);
	} catch {
		return null;
	}
}

/** Whole-file byte equality (used only for name collisions, which are rare). */
async function filesEqual(a: string, b: string): Promise<boolean> {
	try {
		const [ba, bb] = await Promise.all([fs.readFile(a), fs.readFile(b)]);
		return ba.equals(bb);
	} catch {
		return false;
	}
}

/**
 * Best-effort free-space check: is there room for `bytes` at (the nearest existing ancestor of) `dir`?
 * Returns true when it can't be determined (`statfs` unsupported / errors) — the check should never be
 * the reason a legitimate migration is blocked on a platform we can't measure.
 */
function checkFreeSpace(dir: string, bytes: number): boolean {
	if (bytes <= 0) return true;
	try {
		let probe = dir;
		while (!fssync.existsSync(probe)) {
			const parent = path.dirname(probe);
			if (parent === probe) break;
			probe = parent;
		}
		const st = fssync.statfsSync(probe);
		return st.bavail * st.bsize >= bytes;
	} catch {
		return true;
	}
}

/**
 * Compute the preflight report for moving the manifest's blobs from `fromDir` to `toDir`.
 *
 * @param fromDir - Current blob dir.
 * @param toDir - Requested destination (absolute).
 * @param strategy - move / copy / leave.
 * @param names - Manifest blob filenames.
 */
async function buildPreflight(
	fromDir: string,
	toDir: string,
	strategy: MigrateStrategy,
	names: string[]
): Promise<MigratePreflight> {
	const sameDir = path.resolve(fromDir) === path.resolve(toDir);
	const missingAtSource: string[] = [];
	const conflicts: string[] = [];
	let bytesToTransfer = 0;
	let presentAtSource = 0;

	for (const name of names) {
		const srcStat = await statOrNull(path.join(fromDir, name));
		if (!srcStat || !srcStat.isFile()) {
			missingAtSource.push(name);
			continue;
		}
		presentAtSource++;
		if (sameDir) continue;
		bytesToTransfer += srcStat.size;
		// A file of the same name already at the destination is a conflict *unless* it's byte-identical
		// (an interrupted/idempotent re-run), in which case it's treated as already-there and skipped.
		const dstStat = await statOrNull(path.join(toDir, name));
		if (dstStat && dstStat.isFile()) {
			const same =
				dstStat.size === srcStat.size &&
				(await filesEqual(path.join(fromDir, name), path.join(toDir, name)));
			if (!same) conflicts.push(name);
		}
	}

	const freeSpaceOk =
		strategy === 'leave' || sameDir ? true : checkFreeSpace(toDir, bytesToTransfer);

	return {
		fromDir,
		toDir,
		strategy,
		sameDir,
		blobCount: names.length,
		presentAtSource,
		missingAtSource,
		conflicts,
		bytesToTransfer,
		freeSpaceOk
	};
}

/**
 * Dry-run: what would migrating to `toDir` do? Read-only — touches no files, takes no lock. Powers the
 * confirm dialog's summary.
 *
 * @param input.toDir - Destination directory (absolute or relative-resolved by the caller).
 * @param input.strategy - move / copy / leave.
 */
export async function previewMigration(input: {
	toDir: string;
	strategy: MigrateStrategy;
}): Promise<MigratePreflight> {
	const fromDir = getGlobalFilesDir();
	const toDir = path.resolve(input.toDir);
	const names = await manifestBlobNames();
	return buildPreflight(fromDir, toDir, input.strategy, names);
}

/**
 * Relocate the manifest's blobs from the current dir to `toDir`, under the manifest lock.
 *
 * Aborts (transferring nothing) if the destination has a conflicting different-content file of the same
 * name, or — unless `force` — if any manifest blob is missing at the source. On a clean run it copies
 * each blob, verifies the destination size, and (for `move`) unlinks the source only after the copy
 * verifies. `leave` performs no transfer (repoint-only, for "I already moved them"). The caller persists
 * the new location + flips the live env **only on a non-aborted result**.
 *
 * @param input.toDir - Destination directory.
 * @param input.strategy - move / copy / leave.
 * @param input.force - Proceed even when some blobs are missing at the source (they stay `missing`).
 */
export async function migrateBlobs(input: {
	toDir: string;
	strategy: MigrateStrategy;
	force?: boolean;
}): Promise<MigrateResult> {
	const lockPath = `${getManifestPath()}.lock`;
	return await withFileLock(lockPath, async () => {
		const fromDir = getGlobalFilesDir();
		const toDir = path.resolve(input.toDir);
		const names = await manifestBlobNames();
		const pre = await buildPreflight(fromDir, toDir, input.strategy, names);
		const base: MigrateResult = {
			...pre,
			aborted: false,
			moved: 0,
			copied: 0,
			skipped: 0,
			failed: []
		};

		if (pre.sameDir) {
			return {
				...base,
				skipped: pre.presentAtSource,
				reason: 'Source and destination are the same folder — nothing to move.'
			};
		}
		if (pre.conflicts.length > 0) {
			return {
				...base,
				aborted: true,
				reason: `${pre.conflicts.length} name conflict(s) at the destination — resolve before migrating.`
			};
		}
		if (pre.missingAtSource.length > 0 && !input.force) {
			return {
				...base,
				aborted: true,
				reason: `${pre.missingAtSource.length} blob(s) missing at the source.`
			};
		}
		if (!pre.freeSpaceOk) {
			return { ...base, aborted: true, reason: 'Not enough free space at the destination.' };
		}

		// `leave` = repoint only; no bytes touched.
		if (input.strategy === 'leave') {
			return { ...base, skipped: pre.presentAtSource };
		}

		await fs.mkdir(toDir, { recursive: true });
		let moved = 0;
		let copied = 0;
		let skipped = 0;
		const failed: MigrateFailure[] = [];

		for (const name of names) {
			const src = path.join(fromDir, name);
			const dst = path.join(toDir, name);
			const srcStat = await statOrNull(src);
			if (!srcStat || !srcStat.isFile()) {
				// Missing at source (only reachable on the force path — preflight blocked it otherwise).
				skipped++;
				continue;
			}
			// Already present + byte-identical? Don't recopy (idempotent re-run); still unlink for `move`.
			const dstStat = await statOrNull(dst);
			if (
				dstStat &&
				dstStat.isFile() &&
				dstStat.size === srcStat.size &&
				(await filesEqual(src, dst))
			) {
				if (input.strategy === 'move') {
					await fs.unlink(src).catch(() => {});
					moved++;
				} else {
					copied++;
				}
				continue;
			}
			try {
				await fs.copyFile(src, dst);
				const check = await fs.stat(dst);
				if (check.size !== srcStat.size) {
					failed.push({ file_name: name, error: 'size mismatch after copy' });
					continue;
				}
				if (input.strategy === 'move') {
					await fs.unlink(src);
					moved++;
				} else {
					copied++;
				}
			} catch (e) {
				failed.push({ file_name: name, error: (e as Error).message });
			}
		}

		return { ...base, moved, copied, skipped, failed };
	});
}
