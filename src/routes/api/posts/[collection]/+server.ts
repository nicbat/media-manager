import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	listPostCollections,
	deletePostCollection,
	createPostsRepoForCollection
} from '$lib/storage/postsRepo.js';
import { readPostsSettings, collectionSchema } from '$lib/storage/postsSettings.js';
import { setCollectionConfig } from '$lib/storage/postsSchema.js';
import { assertSafeSegment } from '$lib/server/postsGuard.js';
import { z } from 'zod';

const PatchBodySchema = z.object({
	displayName: z.string().min(1).max(256).optional(),
	icon: z.string().max(64).optional(),
	displayField: z.string().max(256).optional()
});

/**
 * GET: A collection's config (displayName, icon, displayField, schema) + its post list (Item 14).
 * The schema is a full `SchemaDefinition` (legacy `fieldHints` are converted on read).
 */
export const GET: RequestHandler = async ({ params }) => {
	const collection = assertSafeSegment(params.collection, 'collection');
	const summary = listPostCollections().find((c) => c.id === collection);
	if (!summary) throw error(404, 'Collection not found');
	const cfg = readPostsSettings().collections?.[collection];
	const repo = createPostsRepoForCollection(collection);
	return json({
		id: collection,
		displayName: summary.displayName,
		icon: summary.icon,
		displayField: cfg?.displayField ?? '',
		schema: collectionSchema(cfg),
		posts: repo.listPosts()
	});
};

/**
 * PATCH: Merge collection general config (rename via `displayName`, set `icon`, set `displayField`
 * title-by). The collection id (folder name) is immutable; the field schema is edited via `.../schema`.
 */
export const PATCH: RequestHandler = async ({ params, request }) => {
	const collection = assertSafeSegment(params.collection, 'collection');
	const parsed = PatchBodySchema.safeParse(await request.json());
	if (!parsed.success) throw error(400, 'Invalid collection patch');
	if (!listPostCollections().some((c) => c.id === collection))
		throw error(404, 'Collection not found');
	const merged = await setCollectionConfig(collection, parsed.data);
	return json({ id: collection, ...merged });
};

/** DELETE: Remove a collection folder (all its posts) + its registry entry. */
export const DELETE: RequestHandler = async ({ params }) => {
	const collection = assertSafeSegment(params.collection, 'collection');
	try {
		await deletePostCollection(collection);
		return json({ success: true });
	} catch (err) {
		const e = err as Error;
		throw error(500, { message: e.message ?? 'Failed to delete collection' });
	}
};
