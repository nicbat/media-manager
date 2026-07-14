import * as fssync from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {
	getPostsDir,
	getPostCollectionDir,
	getPostFilePath,
	listPostSlugs,
	listPostCollectionIds,
	POSTS_DIR_NAME
} from './paths.js';
import { assertSafeBasename } from './filenames.js';
import { withFileLock } from './lock.js';
import { readTextFile, writeTextFileAtomic } from './json.js';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter.js';
import { readPostsSettings, writePostsSettings } from './postsSettings.js';

/**
 * Summary of a single post for list views (the rail): its slug plus the handful of frontmatter values
 * a list row shows. The full frontmatter/body is fetched lazily via {@link PostsRepo.readPost}.
 *
 * @param slug - The post id (`.md` filename stem).
 * @param title - `frontmatter.title` when present, else the slug (never blank).
 * @param date - `frontmatter.date` stringified when present (for sort/display), else undefined.
 * @param draft - `frontmatter.draft === true`.
 */
export interface PostSummary {
	slug: string;
	title: string;
	date?: string;
	draft: boolean;
}

/** A fully-read post: slug + parsed frontmatter object + raw markdown body. */
export interface PostContent {
	slug: string;
	frontmatter: Record<string, unknown>;
	body: string;
}

/** Summary of a collection for the rail/dashboard: id, display name, optional icon, and post count. */
export interface CollectionSummary {
	id: string;
	displayName: string;
	icon?: string;
	count: number;
}

/** Slugify a title/name into a safe `.md` filename stem (mirrors `mediaTypes.slugify`). */
function slugify(input: string): string {
	return (
		input
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '') || 'post'
	);
}

/** Absolute path to a collection's coarse mutation lock (sibling to the collection dir). */
function collectionLockPath(collection: string): string {
	return path.join(getPostsDir(), `${collection}.lock`);
}

/* ------------------------------------------------------------------------------------------------ *
 * Collection management (the Posts-side analogue of `mediaTypes` type CRUD).
 * ------------------------------------------------------------------------------------------------ */

/**
 * List all post collections, honoring the persisted `collectionOrder` and folding in any on-disk
 * folder the registry hasn't caught up with yet (self-healing, like the manifest reconcile).
 *
 * @returns Collection summaries in `collectionOrder` first, then any unregistered folders by name.
 */
export function listPostCollections(): CollectionSummary[] {
	const settings = readPostsSettings();
	const onDisk = listPostCollectionIds();
	const order = settings.collectionOrder ?? [];
	// Registered-and-present first (in order), then any stragglers on disk not yet in the order.
	const ordered = [...order.filter((id) => onDisk.includes(id))];
	for (const id of onDisk) if (!ordered.includes(id)) ordered.push(id);

	return ordered.map((id) => {
		const cfg = settings.collections?.[id];
		return {
			id,
			displayName: cfg?.displayName ?? id,
			icon: cfg?.icon,
			count: listPostSlugs(id).length
		};
	});
}

/**
 * Create a new post collection: a folder under `posts/` plus a registry entry.
 *
 * @param displayName - Human-readable name (used to derive the collection id/folder name).
 * @returns The new collection id (folder name).
 */
export async function createPostCollection(displayName: string): Promise<string> {
	let id = slugify(displayName);
	let candidate = id;
	let n = 1;
	while (fssync.existsSync(getPostCollectionDir(candidate))) {
		candidate = `${id}-${n}`;
		n++;
	}
	id = candidate;
	assertSafeBasename(id);
	await fs.mkdir(getPostCollectionDir(id), { recursive: true });

	const settings = readPostsSettings();
	const collections = { ...(settings.collections ?? {}) };
	collections[id] = { displayName: displayName.trim() || id };
	const collectionOrder = [...(settings.collectionOrder ?? []), id];
	await writePostsSettings({ collections, collectionOrder });
	return id;
}

/**
 * Delete a collection: remove its folder (and every post inside it) plus its registry entry.
 *
 * @param id - Collection id.
 */
export async function deletePostCollection(id: string): Promise<void> {
	assertSafeBasename(id);
	const dir = getPostCollectionDir(id);
	const resolved = path.resolve(dir);
	const postsRoot = path.resolve(getPostsDir());
	if (!resolved.startsWith(postsRoot + path.sep) || resolved === postsRoot) {
		throw new Error('Invalid collection path');
	}
	await fs.rm(dir, { recursive: true, force: true });

	const settings = readPostsSettings();
	const collections = { ...(settings.collections ?? {}) };
	delete collections[id];
	const collectionOrder = (settings.collectionOrder ?? []).filter((c) => c !== id);
	await writePostsSettings({ collections, collectionOrder });
}

/* ------------------------------------------------------------------------------------------------ *
 * Per-collection post CRUD.
 * ------------------------------------------------------------------------------------------------ */

/** The per-collection post repository returned by {@link createPostsRepoForCollection}. */
export type PostsRepo = ReturnType<typeof createPostsRepoForCollection>;

/**
 * Build a post-CRUD repo bound to one collection (the Posts-side analogue of
 * `createJsonRepoForType`). Every mutation is serialized under a per-collection {@link withFileLock}
 * and writes go through {@link writeTextFileAtomic}, so concurrent requests can't corrupt a `.md` or
 * race on slug collisions.
 *
 * @param collection - The collection id (folder name).
 */
export function createPostsRepoForCollection(collection: string) {
	assertSafeBasename(collection);
	const lockPath = collectionLockPath(collection);

	/** List every post in the collection, sorted by frontmatter `date` desc (undated last), then slug. */
	function listPosts(): PostSummary[] {
		// Resolve the rail title from the collection's chosen "title by" field, mirroring records' title_value.
		const displayField = readPostsSettings().collections?.[collection]?.displayField;
		const slugs = listPostSlugs(collection);
		const summaries: PostSummary[] = slugs.map((slug) => {
			let frontmatter: Record<string, unknown> = {};
			try {
				frontmatter = parseFrontmatter(
					fssync.readFileSync(getPostFilePath(collection, slug), 'utf-8')
				).frontmatter;
			} catch {
				frontmatter = {};
			}
			const byField = displayField ? frontmatter[displayField] : undefined;
			const title =
				typeof byField === 'string' && byField.trim()
					? byField
					: typeof frontmatter.title === 'string' && frontmatter.title.trim()
						? frontmatter.title
						: slug;
			const date = frontmatter.date != null ? String(frontmatter.date) : undefined;
			return { slug, title, date, draft: frontmatter.draft === true };
		});
		summaries.sort((a, b) => {
			if (a.date && b.date) return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
			if (a.date) return -1;
			if (b.date) return 1;
			return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
		});
		return summaries;
	}

	/** Read one post's parsed frontmatter + body; throws (ENOENT) if the slug does not exist. */
	async function readPost(slug: string): Promise<PostContent> {
		assertSafeBasename(`${slug}.md`);
		const raw = await readTextFile(getPostFilePath(collection, slug));
		const { frontmatter, body } = parseFrontmatter(raw);
		return { slug, frontmatter, body };
	}

	/**
	 * Overwrite an existing post's frontmatter + body (serialize under lock + atomic write).
	 * The slug must already exist — use {@link createPost} to mint a new one.
	 */
	async function writePost(
		slug: string,
		data: { frontmatter: Record<string, unknown>; body: string }
	): Promise<PostContent> {
		assertSafeBasename(`${slug}.md`);
		const filePath = getPostFilePath(collection, slug);
		return withFileLock(lockPath, async () => {
			if (!fssync.existsSync(filePath)) throw new Error(`No such post: ${collection}/${slug}`);
			const contents = serializeFrontmatter(data.frontmatter, data.body);
			await writeTextFileAtomic(filePath, contents);
			return { slug, frontmatter: data.frontmatter, body: data.body };
		});
	}

	/**
	 * Create a new post. The slug is derived from `slug` (if given) or `frontmatter.title` or a
	 * fallback, then a `-n` suffix loop resolves collisions (reusing `createMediaType`'s pattern).
	 *
	 * @returns The created post (with its final, collision-resolved slug).
	 */
	async function createPost(input?: {
		slug?: string;
		frontmatter?: Record<string, unknown>;
		body?: string;
	}): Promise<PostContent> {
		const frontmatter = input?.frontmatter ?? {};
		const body = input?.body ?? '';
		const base = slugify(
			input?.slug ?? (typeof frontmatter.title === 'string' ? frontmatter.title : '') ?? ''
		);
		return withFileLock(lockPath, async () => {
			await fs.mkdir(getPostCollectionDir(collection), { recursive: true });
			let slug = base;
			let n = 1;
			while (fssync.existsSync(getPostFilePath(collection, slug))) {
				slug = `${base}-${n}`;
				n++;
			}
			assertSafeBasename(`${slug}.md`);
			await writeTextFileAtomic(
				getPostFilePath(collection, slug),
				serializeFrontmatter(frontmatter, body)
			);
			return { slug, frontmatter, body };
		});
	}

	/**
	 * Rename a post (the filename **is** the slug, so this renames the `.md`). No-op fast-path when
	 * the slug is unchanged; throws if the target slug already exists.
	 *
	 * @returns The new slug.
	 */
	async function renamePost(oldSlug: string, newSlugInput: string): Promise<string> {
		const newSlug = slugify(newSlugInput);
		if (newSlug === oldSlug) return oldSlug;
		assertSafeBasename(`${oldSlug}.md`);
		assertSafeBasename(`${newSlug}.md`);
		return withFileLock(lockPath, async () => {
			const from = getPostFilePath(collection, oldSlug);
			const to = getPostFilePath(collection, newSlug);
			if (!fssync.existsSync(from)) throw new Error(`No such post: ${collection}/${oldSlug}`);
			if (fssync.existsSync(to)) throw new Error(`A post named "${newSlug}" already exists`);
			await fs.rename(from, to);
			return newSlug;
		});
	}

	/** Delete a post (`.md`). Idempotent — deleting a missing slug is a no-op. */
	async function deletePost(slug: string): Promise<void> {
		assertSafeBasename(`${slug}.md`);
		await withFileLock(lockPath, async () => {
			await fs.rm(getPostFilePath(collection, slug), { force: true });
		});
	}

	return { collection, listPosts, readPost, writePost, createPost, renamePost, deletePost };
}

/** Re-export so callers can spot the structural `posts/` folder name without importing paths. */
export { POSTS_DIR_NAME };
