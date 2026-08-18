import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

import { cancelJob, getJobState, scheduleCompression } from '$lib/server/compression/queue.js';

/**
 * POST: start (or join) the backfill — generate every missing or stale derivative in the workspace.
 *
 * Returns immediately with the job state. The job lives on the **server**, not in the page, so the user
 * can navigate away and come back to live progress. Resumable by definition: it only ever visits files
 * whose derivative is missing or stale, so re-running after a cancel picks up where it stopped.
 */
export const POST: RequestHandler = async () => {
	return json({ job: scheduleCompression('all') });
};

/** DELETE: request cancellation. Stops after the in-flight encodes; everything already generated stays. */
export const DELETE: RequestHandler = async () => {
	return json({ job: cancelJob() });
};

/** GET: poll the job state alone (cheaper than the full report while a backfill is running). */
export const GET: RequestHandler = async () => {
	return json({ job: getJobState() });
};
