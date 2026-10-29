import { readJsonBody } from '$lib/server/requestJson.js';
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { z } from 'zod';
import { ImageIdSchema } from '$lib/core/ids.js';
import { bulkDeleteFromDiskByIds } from '$lib/storage/classRepo.js';
import { unlinkBlobEverywhere } from '$lib/storage/relationLinks.js';

const DeleteBodySchema = z.object({ ids: z.array(ImageIdSchema).min(1) });

/**
 * POST: Delete blobs from disk. Each delete drops the manifest entry and strips the blob's member
 * record from every class (global fan-out). Rare, explicitly confirmed on the client.
 */
export const POST: RequestHandler = async ({ request }) => {
	const parsed = DeleteBodySchema.safeParse(await readJsonBody(request));
	if (!parsed.success) throw error(400, 'ids array is required');
	try {
		// Unlink each blob from every class's linked record fields before it's removed from disk.
		for (const id of parsed.data.ids) await unlinkBlobEverywhere(id);
		await bulkDeleteFromDiskByIds(parsed.data.ids);
		return json({ success: true });
	} catch (err) {
		if (err && typeof err === 'object' && 'status' in err) throw err as never;
		throw error(500, { message: 'Failed to delete files' });
	}
};
