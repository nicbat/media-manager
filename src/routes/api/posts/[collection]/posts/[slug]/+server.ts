import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createPostsRepoForCollection } from '$lib/storage/postsRepo.js';
import { assertSafeSegment } from '$lib/server/postsGuard.js';
import { z } from 'zod';

const WriteBodySchema = z.object({
	frontmatter: z.record(z.unknown()),
	body: z.string()
});

const RenameBodySchema = z.object({
	slug: z.string().min(1).max(256)
});

/** GET: Read one post's parsed frontmatter + markdown body (Item 14). */
export const GET: RequestHandler = async ({ params }) => {
	const collection = assertSafeSegment(params.collection, 'collection');
	const slug = assertSafeSegment(params.slug, 'slug');
	try {
		return json(await createPostsRepoForCollection(collection).readPost(slug));
	} catch (err) {
		const e = err as NodeJS.ErrnoException;
		if (e.code === 'ENOENT') throw error(404, 'Post not found');
		throw error(500, { message: 'Failed to read post' });
	}
};

/** PUT: Overwrite an existing post's frontmatter + body. Body: { frontmatter, body }. */
export const PUT: RequestHandler = async ({ params, request }) => {
	const collection = assertSafeSegment(params.collection, 'collection');
	const slug = assertSafeSegment(params.slug, 'slug');
	const parsed = WriteBodySchema.safeParse(await request.json());
	if (!parsed.success) throw error(400, 'Invalid post payload');
	try {
		return json(await createPostsRepoForCollection(collection).writePost(slug, parsed.data));
	} catch (err) {
		const e = err as Error;
		if (e.message?.startsWith('No such post')) throw error(404, 'Post not found');
		throw error(500, { message: e.message ?? 'Failed to write post' });
	}
};

/** PATCH: Rename a post (its `.md`). Body: { slug }. Returns { slug } (the new, resolved slug). */
export const PATCH: RequestHandler = async ({ params, request }) => {
	const collection = assertSafeSegment(params.collection, 'collection');
	const slug = assertSafeSegment(params.slug, 'slug');
	const parsed = RenameBodySchema.safeParse(await request.json());
	if (!parsed.success) throw error(400, 'Invalid rename payload');
	try {
		const newSlug = await createPostsRepoForCollection(collection).renamePost(
			slug,
			parsed.data.slug
		);
		return json({ slug: newSlug });
	} catch (err) {
		const e = err as Error;
		if (e.message?.startsWith('No such post')) throw error(404, 'Post not found');
		if (e.message?.includes('already exists')) throw error(409, e.message);
		throw error(500, { message: e.message ?? 'Failed to rename post' });
	}
};

/** DELETE: Remove a post (`.md`). Idempotent. */
export const DELETE: RequestHandler = async ({ params }) => {
	const collection = assertSafeSegment(params.collection, 'collection');
	const slug = assertSafeSegment(params.slug, 'slug');
	try {
		await createPostsRepoForCollection(collection).deletePost(slug);
		return json({ success: true });
	} catch (err) {
		const e = err as Error;
		throw error(500, { message: e.message ?? 'Failed to delete post' });
	}
};
