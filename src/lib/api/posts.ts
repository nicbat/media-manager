import type { SchemaDefinition, AddFieldRequest, UpdateFieldRequest } from '$lib/core/types.js';

/**
 * Client wrappers for the Posts sub-app API (`/api/posts/...`, Item 14). Mirrors `api/files.ts`:
 * thin `fetch` helpers that throw on a non-OK response. Types are hand-declared (not Zod-validated)
 * to keep the client light — the server is the source of truth. A collection's frontmatter schema is a
 * full `SchemaDefinition` (same as a Records type / Files class), driven by the shared schema editor.
 */

/** A collection summary from `GET /api/posts`. */
export interface PostCollectionSummary {
	id: string;
	displayName: string;
	icon?: string;
	count: number;
}

/** A post summary row from a collection's list. */
export interface PostSummary {
	slug: string;
	title: string;
	date?: string;
	draft: boolean;
}

/** A fully-read post. */
export interface PostContent {
	slug: string;
	frontmatter: Record<string, unknown>;
	body: string;
}

/** A collection's full config + post list from `GET /api/posts/[collection]`. */
export interface PostCollectionDetail {
	id: string;
	displayName: string;
	icon?: string;
	/** The schema field whose value titles each post in the rail ('' = frontmatter `title` → slug). */
	displayField: string;
	/** The collection's frontmatter schema (key → field definition), in manual field order. */
	schema: SchemaDefinition;
	posts: PostSummary[];
}

async function assertOk(res: Response, message: string): Promise<void> {
	if (res.ok) return;
	let details = '';
	try {
		details = await res.text();
	} catch {
		/* ignore */
	}
	throw new Error(`${message} (status ${res.status})${details ? `: ${details}` : ''}`);
}

const jsonHeaders = { 'Content-Type': 'application/json' };

/** List all post collections. */
export async function apiListPostCollections(fetchFn = fetch): Promise<PostCollectionSummary[]> {
	const res = await fetchFn('/api/posts');
	await assertOk(res, 'Failed to list post collections');
	return res.json();
}

/** Create a post collection. */
export async function apiCreatePostCollection(
	displayName: string,
	fetchFn = fetch
): Promise<PostCollectionSummary> {
	const res = await fetchFn('/api/posts', {
		method: 'POST',
		headers: jsonHeaders,
		body: JSON.stringify({ displayName })
	});
	await assertOk(res, 'Failed to create post collection');
	return res.json();
}

/** Get a collection's config + post list. */
export async function apiGetPostCollection(
	collection: string,
	fetchFn = fetch
): Promise<PostCollectionDetail> {
	const res = await fetchFn(`/api/posts/${encodeURIComponent(collection)}`);
	await assertOk(res, 'Failed to load collection');
	return res.json();
}

/** Merge-update a collection's general config (rename via displayName, icon, displayField title-by). */
export async function apiUpdatePostCollection(
	collection: string,
	patch: { displayName?: string; icon?: string; displayField?: string },
	fetchFn = fetch
): Promise<void> {
	const res = await fetchFn(`/api/posts/${encodeURIComponent(collection)}`, {
		method: 'PATCH',
		headers: jsonHeaders,
		body: JSON.stringify(patch)
	});
	await assertOk(res, 'Failed to update collection');
}

/** Delete a collection (and all its posts). */
export async function apiDeletePostCollection(collection: string, fetchFn = fetch): Promise<void> {
	const res = await fetchFn(`/api/posts/${encodeURIComponent(collection)}`, { method: 'DELETE' });
	await assertOk(res, 'Failed to delete collection');
}

/** Get a collection's frontmatter schema. */
export async function apiGetPostCollectionSchema(
	collection: string,
	fetchFn = fetch
): Promise<SchemaDefinition> {
	const res = await fetchFn(`/api/posts/${encodeURIComponent(collection)}/schema`);
	await assertOk(res, 'Failed to load schema');
	return res.json();
}

/** Add a field to a collection's schema. */
export async function apiAddPostCollectionField(
	collection: string,
	body: AddFieldRequest,
	fetchFn = fetch
): Promise<{ schema: SchemaDefinition }> {
	const res = await fetchFn(`/api/posts/${encodeURIComponent(collection)}/schema`, {
		method: 'POST',
		headers: jsonHeaders,
		body: JSON.stringify(body)
	});
	await assertOk(res, 'Failed to add field');
	return res.json();
}

/** Update / rename a field in a collection's schema. */
export async function apiUpdatePostCollectionField(
	collection: string,
	body: UpdateFieldRequest,
	fetchFn = fetch
): Promise<{ schema: SchemaDefinition }> {
	const res = await fetchFn(`/api/posts/${encodeURIComponent(collection)}/schema`, {
		method: 'PATCH',
		headers: jsonHeaders,
		body: JSON.stringify(body)
	});
	await assertOk(res, 'Failed to update field');
	return res.json();
}

/** Delete a field from a collection's schema; `removeFromPosts` strips it from every post's frontmatter. */
export async function apiDeletePostCollectionField(
	collection: string,
	fieldName: string,
	removeFromPosts: boolean,
	fetchFn = fetch
): Promise<{ schema: SchemaDefinition }> {
	const res = await fetchFn(`/api/posts/${encodeURIComponent(collection)}/schema`, {
		method: 'DELETE',
		headers: jsonHeaders,
		body: JSON.stringify({ fieldName, removeFromImages: removeFromPosts })
	});
	await assertOk(res, 'Failed to delete field');
	return res.json();
}

/** Reorder a collection's schema fields. */
export async function apiReorderPostCollectionSchema(
	collection: string,
	order: string[],
	fetchFn = fetch
): Promise<{ schema: SchemaDefinition }> {
	const res = await fetchFn(`/api/posts/${encodeURIComponent(collection)}/schema/order`, {
		method: 'POST',
		headers: jsonHeaders,
		body: JSON.stringify({ order })
	});
	await assertOk(res, 'Failed to reorder fields');
	return res.json();
}

/** List posts in a collection. */
export async function apiListPosts(collection: string, fetchFn = fetch): Promise<PostSummary[]> {
	const res = await fetchFn(`/api/posts/${encodeURIComponent(collection)}/posts`);
	await assertOk(res, 'Failed to list posts');
	return res.json();
}

/** Create a post. */
export async function apiCreatePost(
	collection: string,
	input: { slug?: string; frontmatter?: Record<string, unknown>; body?: string },
	fetchFn = fetch
): Promise<PostContent> {
	const res = await fetchFn(`/api/posts/${encodeURIComponent(collection)}/posts`, {
		method: 'POST',
		headers: jsonHeaders,
		body: JSON.stringify(input)
	});
	await assertOk(res, 'Failed to create post');
	return res.json();
}

/** Read a single post. */
export async function apiGetPost(
	collection: string,
	slug: string,
	fetchFn = fetch
): Promise<PostContent> {
	const res = await fetchFn(
		`/api/posts/${encodeURIComponent(collection)}/posts/${encodeURIComponent(slug)}`
	);
	await assertOk(res, 'Failed to read post');
	return res.json();
}

/** Overwrite a post's frontmatter + body. */
export async function apiWritePost(
	collection: string,
	slug: string,
	data: { frontmatter: Record<string, unknown>; body: string },
	fetchFn = fetch
): Promise<PostContent> {
	const res = await fetchFn(
		`/api/posts/${encodeURIComponent(collection)}/posts/${encodeURIComponent(slug)}`,
		{ method: 'PUT', headers: jsonHeaders, body: JSON.stringify(data) }
	);
	await assertOk(res, 'Failed to save post');
	return res.json();
}

/** Rename a post; returns the new (resolved) slug. */
export async function apiRenamePost(
	collection: string,
	slug: string,
	newSlug: string,
	fetchFn = fetch
): Promise<string> {
	const res = await fetchFn(
		`/api/posts/${encodeURIComponent(collection)}/posts/${encodeURIComponent(slug)}`,
		{ method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ slug: newSlug }) }
	);
	await assertOk(res, 'Failed to rename post');
	return (await res.json()).slug;
}

/** Delete a post. */
export async function apiDeletePost(
	collection: string,
	slug: string,
	fetchFn = fetch
): Promise<void> {
	const res = await fetchFn(
		`/api/posts/${encodeURIComponent(collection)}/posts/${encodeURIComponent(slug)}`,
		{ method: 'DELETE' }
	);
	await assertOk(res, 'Failed to delete post');
}
