import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

import { sweepDerived } from '$lib/server/compression/sweep.js';
import { isStaticAssetsMode } from '$lib/storage/paths.js';

/**
 * POST: delete derivative files the manifest no longer references (a deleted preset, a renamed blob, a
 * format change). `?dryRun=1` reports without deleting.
 *
 * Surfaced as a manual action rather than an automatic step because of **static-assets mode**: a
 * deployed site may still be serving a file this sweep considers orphaned (the manifest moved on, the
 * deployment hasn't), so there it should be run after the next export. The response flags that mode so
 * the UI can say so.
 */
export const POST: RequestHandler = async ({ url }) => {
	const dryRun = url.searchParams.get('dryRun') === '1';
	const result = await sweepDerived({ dryRun });
	return json({ ...result, dryRun, staticAssetsMode: isStaticAssetsMode() });
};
