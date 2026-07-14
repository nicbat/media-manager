import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ReorderFieldsRequestSchema } from '$lib/core/types.js';
import { assertSafeSegment } from '$lib/server/postsGuard.js';
import { listPostCollections } from '$lib/storage/postsRepo.js';
import { reorderCollectionSchema } from '$lib/storage/postsSchema.js';

/**
 * POST: Reorder a collection's schema fields. Body `{ order: string[] }`; omitted keys are appended.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const collection = assertSafeSegment(params.collection, 'collection');
	if (!listPostCollections().some((c) => c.id === collection))
		throw error(404, 'Collection not found');
	const parsed = ReorderFieldsRequestSchema.safeParse(await request.json());
	if (!parsed.success) throw error(400, 'Invalid reorder payload');
	try {
		const result = await reorderCollectionSchema(collection, parsed.data.order);
		return json({ success: true, schema: result.schema });
	} catch (err) {
		const e = err as Error;
		throw error(500, { message: e.message ?? 'Failed to reorder fields' });
	}
};
