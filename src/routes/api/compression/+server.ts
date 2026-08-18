import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

import { readCompressionSettings } from '$lib/storage/compressionSettings.js';
import { computeCompressionStats } from '$lib/server/compression/stats.js';
import { getJobState } from '$lib/server/compression/queue.js';
import { listClasses } from '$lib/storage/classRepo.js';

/**
 * GET: everything the `/compression` page renders — the savings/coverage/quality report, the current
 * preset registry, the live background-job state, and class display names for the per-class breakdown.
 *
 * One endpoint rather than three because the page polls it while a backfill runs: a single read keeps
 * the numbers on screen mutually consistent (a coverage count and a savings total from different
 * instants would visibly disagree).
 */
export const GET: RequestHandler = async () => {
	const settings = readCompressionSettings();
	const stats = await computeCompressionStats(settings);
	const classNames: Record<string, string> = {};
	for (const c of listClasses()) classNames[c.id] = c.displayName;
	return json({ settings, stats, job: getJobState(), classNames });
};
