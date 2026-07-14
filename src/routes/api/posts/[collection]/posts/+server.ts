import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createPostsRepoForCollection, listPostCollections } from '$lib/storage/postsRepo.js';
import { assertSafeSegment } from '$lib/server/postsGuard.js';
import { z } from 'zod';

const CreateBodySchema = z.object({
	slug: z.string().max(256).optional(),
	frontmatter: z.record(z.unknown()).optional(),
	body: z.string().optional()
});

/** GET: List every post in a collection (slug + list-view frontmatter), date-desc (Item 14). */
export const GET: RequestHandler = async ({ params }) => {
	const collection = assertSafeSegment(params.collection, 'collection');
	if (!listPostCollections().some((c) => c.id === collection)) {
		throw error(404, 'Collection not found');
	}
	return json(createPostsRepoForCollection(collection).listPosts());
};

/** POST: Create a new post. Body: { slug?, frontmatter?, body? }. Returns the created post. */
export const POST: RequestHandler = async ({ params, request }) => {
	const collection = assertSafeSegment(params.collection, 'collection');
	if (!listPostCollections().some((c) => c.id === collection)) {
		throw error(404, 'Collection not found');
	}
	const parsed = CreateBodySchema.safeParse(await request.json().catch(() => ({})));
	if (!parsed.success) throw error(400, 'Invalid post payload');
	try {
		const created = await createPostsRepoForCollection(collection).createPost(parsed.data);
		return json(created);
	} catch (err) {
		const e = err as Error;
		throw error(500, { message: e.message ?? 'Failed to create post' });
	}
};
