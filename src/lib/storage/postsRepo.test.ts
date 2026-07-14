import { describe, expect, it, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
	createPostCollection,
	deletePostCollection,
	listPostCollections,
	createPostsRepoForCollection
} from './postsRepo.js';
import { setCollectionConfig } from './postsSchema.js';
import { readPostsSettings } from './postsSettings.js';

describe('postsRepo — collections + post CRUD', () => {
	beforeEach(() => {
		const root = path.join(
			tmpdir(),
			`mm-posts-test-${Date.now()}-${Math.random().toString(16).slice(2)}`
		);
		fs.mkdirSync(root, { recursive: true });
		process.env.MEDIA_MANAGER_ROOT = root;
	});

	it('creates a collection, registers it, and lists it', async () => {
		const id = await createPostCollection('Words');
		expect(id).toBe('words');
		const collections = listPostCollections();
		expect(collections).toHaveLength(1);
		expect(collections[0]).toMatchObject({ id: 'words', displayName: 'Words', count: 0 });
		expect(readPostsSettings().collectionOrder).toEqual(['words']);
	});

	it('suffixes colliding collection ids', async () => {
		await createPostCollection('Words');
		const second = await createPostCollection('Words');
		expect(second).toBe('words-1');
	});

	it('round-trips a post (create → read → write → read)', async () => {
		await createPostCollection('Words');
		const repo = createPostsRepoForCollection('words');
		const created = await repo.createPost({
			frontmatter: { title: 'Tidepooling', date: '2026-07-07' },
			body: 'At low tide.\n'
		});
		expect(created.slug).toBe('tidepooling');

		const read = await repo.readPost('tidepooling');
		expect(read.frontmatter.title).toBe('Tidepooling');
		expect(read.body).toBe('At low tide.\n');

		await repo.writePost('tidepooling', {
			frontmatter: { title: 'Tidepooling', date: '2026-07-07', draft: true },
			body: 'Edited.\n'
		});
		const reread = await repo.readPost('tidepooling');
		expect(reread.frontmatter.draft).toBe(true);
		expect(reread.body).toBe('Edited.\n');
	});

	it('suffixes colliding post slugs', async () => {
		await createPostCollection('Words');
		const repo = createPostsRepoForCollection('words');
		const a = await repo.createPost({ frontmatter: { title: 'Hello' } });
		const b = await repo.createPost({ frontmatter: { title: 'Hello' } });
		expect(a.slug).toBe('hello');
		expect(b.slug).toBe('hello-1');
	});

	it('lists posts sorted by date desc', async () => {
		await createPostCollection('Words');
		const repo = createPostsRepoForCollection('words');
		await repo.createPost({ slug: 'old', frontmatter: { title: 'Old', date: '2020-01-01' } });
		await repo.createPost({ slug: 'new', frontmatter: { title: 'New', date: '2026-01-01' } });
		const posts = repo.listPosts();
		expect(posts.map((p) => p.slug)).toEqual(['new', 'old']);
	});

	it('renames a post (the .md file)', async () => {
		await createPostCollection('Words');
		const repo = createPostsRepoForCollection('words');
		await repo.createPost({ slug: 'draft', frontmatter: { title: 'Draft' }, body: 'x' });
		const newSlug = await repo.renamePost('draft', 'Final Post');
		expect(newSlug).toBe('final-post');
		await expect(repo.readPost('draft')).rejects.toThrow();
		expect((await repo.readPost('final-post')).body).toBe('x');
	});

	it('refuses to rename onto an existing slug', async () => {
		await createPostCollection('Words');
		const repo = createPostsRepoForCollection('words');
		await repo.createPost({ slug: 'a', frontmatter: {} });
		await repo.createPost({ slug: 'b', frontmatter: {} });
		await expect(repo.renamePost('a', 'b')).rejects.toThrow();
	});

	it('deletes a post', async () => {
		await createPostCollection('Words');
		const repo = createPostsRepoForCollection('words');
		await repo.createPost({ slug: 'gone', frontmatter: {} });
		await repo.deletePost('gone');
		expect(repo.listPosts()).toHaveLength(0);
	});

	it('updates collection config (display name + title-by)', async () => {
		await createPostCollection('Words');
		await setCollectionConfig('words', { displayName: 'My Words', displayField: 'title' });
		const cfg = readPostsSettings().collections?.words;
		expect(cfg?.displayName).toBe('My Words');
		expect(cfg?.displayField).toBe('title');
	});

	it('deletes a collection and its posts', async () => {
		await createPostCollection('Words');
		const repo = createPostsRepoForCollection('words');
		await repo.createPost({ slug: 'p', frontmatter: {} });
		await deletePostCollection('words');
		expect(listPostCollections()).toHaveLength(0);
		expect(readPostsSettings().collectionOrder).toEqual([]);
	});
});
