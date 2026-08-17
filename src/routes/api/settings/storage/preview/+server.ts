import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { z } from 'zod';

import { previewMigration } from '$lib/storage/assetsMigrate.js';
import { resolveStorageTarget } from '$lib/server/storageConfig.js';

/**
 * Dry-run for a storage-location change: given a proposed destination + strategy, return the preflight
 * report (blob count, conflicts, missing-at-source, free space) **without moving anything**. Powers the
 * confirm dialog's summary so the user sees exactly what a commit would do.
 */

const PreviewSchema = z.object({
	mode: z.enum(['static', 'classic']),
	dir: z.string().max(4096).optional(),
	baseUrl: z.string().max(2048).optional(),
	strategy: z.enum(['move', 'copy', 'leave'])
});

export const POST: RequestHandler = async ({ request }) => {
	const parsed = PreviewSchema.safeParse(await request.json());
	if (!parsed.success) throw error(400, 'Invalid storage payload');

	let target;
	try {
		target = resolveStorageTarget(parsed.data);
	} catch (e) {
		throw error(400, (e as Error).message);
	}

	const report = await previewMigration({ toDir: target.toDir, strategy: parsed.data.strategy });
	return json({ ...report, resolvedDir: target.toDir, baseUrl: target.assets?.baseUrl ?? null });
};
