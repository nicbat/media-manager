import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listPostCollections, createPostCollection } from '$lib/storage/postsRepo.js';
import { z } from 'zod';

const CreateBodySchema = z.object({
	displayName: z.string().min(1).max(256)
});

/**
 * GET: List all post collections (id, displayName, icon, count) in rail order (Item 14).
 */
export const GET: RequestHandler = async () => {
	try {
		return json(listPostCollections());
	} catch (err) {
		console.error('List post collections error:', err);
		throw error(500, { message: 'Failed to list post collections' });
	}
};

/**
 * POST: Create a new post collection. Body: { displayName }.
 * Creates the `posts/<id>/` folder + registry entry.
 */
export const POST: RequestHandler = async ({ request }) => {
	if (request.headers.get('content-type')?.includes('application/json') === false) {
		throw error(400, 'Content-Type must be application/json');
	}
	const parsed = CreateBodySchema.safeParse(await request.json());
	if (!parsed.success) throw error(400, 'Invalid body: displayName required');
	try {
		const id = await createPostCollection(parsed.data.displayName);
		const created = listPostCollections().find((c) => c.id === id);
		return json(created ?? { id, displayName: parsed.data.displayName, count: 0 });
	} catch (err) {
		const e = err as Error;
		console.error('Create post collection error:', e);
		throw error(500, { message: e.message ?? 'Failed to create post collection' });
	}
};
