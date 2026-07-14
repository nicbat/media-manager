import { describe, expect, it, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createPostCollection, createPostsRepoForCollection } from './postsRepo.js';
import {
	getCollectionSchema,
	addCollectionField,
	updateCollectionField,
	deleteCollectionField,
	reorderCollectionSchema
} from './postsSchema.js';
import { writePostsSettings, collectionSchema, readPostsSettings } from './postsSettings.js';
import type { AddFieldRequest } from '$lib/core/types.js';

const field = (fieldName: string, fieldType: string): AddFieldRequest =>
	({ fieldName, fieldType }) as AddFieldRequest;

describe('postsSchema — collection schema CRUD', () => {
	beforeEach(() => {
		const root = path.join(
			tmpdir(),
			`mm-postsschema-${Date.now()}-${Math.random().toString(16).slice(2)}`
		);
		fs.mkdirSync(root, { recursive: true });
		process.env.MEDIA_MANAGER_ROOT = root;
	});

	it('adds fields in order and rejects duplicates', async () => {
		await createPostCollection('Words');
		await addCollectionField('words', field('title', 'string'));
		await addCollectionField('words', field('date', 'date'));
		expect(Object.keys(getCollectionSchema('words'))).toEqual(['title', 'date']);
		expect(getCollectionSchema('words').date.type).toBe('date');
		await expect(addCollectionField('words', field('title', 'string'))).rejects.toThrow();
	});

	it('renames a field in the schema and across post frontmatter', async () => {
		await createPostCollection('Words');
		await addCollectionField('words', field('author', 'string'));
		const repo = createPostsRepoForCollection('words');
		await repo.createPost({ slug: 'p', frontmatter: { author: 'Ada' }, body: 'x' });

		await updateCollectionField('words', 'author', { newKey: 'writer' });
		expect(Object.keys(getCollectionSchema('words'))).toEqual(['writer']);
		const post = await repo.readPost('p');
		expect(post.frontmatter.writer).toBe('Ada');
		expect('author' in post.frontmatter).toBe(false);
	});

	it('deletes a field and strips it from posts when asked', async () => {
		await createPostCollection('Words');
		await addCollectionField('words', field('draft', 'boolean'));
		const repo = createPostsRepoForCollection('words');
		await repo.createPost({ slug: 'p', frontmatter: { draft: true }, body: 'x' });

		await deleteCollectionField('words', 'draft', true);
		expect(getCollectionSchema('words').draft).toBeUndefined();
		expect('draft' in (await repo.readPost('p')).frontmatter).toBe(false);
	});

	it('reorders schema fields', async () => {
		await createPostCollection('Words');
		await addCollectionField('words', field('a', 'string'));
		await addCollectionField('words', field('b', 'string'));
		await addCollectionField('words', field('c', 'string'));
		await reorderCollectionSchema('words', ['c', 'a', 'b']);
		expect(Object.keys(getCollectionSchema('words'))).toEqual(['c', 'a', 'b']);
	});

	it('reads legacy fieldHints as a schema (back-compat) and upgrades on first edit', async () => {
		await createPostCollection('Words');
		// Simulate an older settings.json using fieldHints.
		await writePostsSettings({
			collections: {
				words: {
					displayName: 'Words',
					fieldHints: { cover: { kind: 'file' }, date: { kind: 'date' } }
				}
			}
		});
		const schema = getCollectionSchema('words');
		expect(schema.cover.type).toBe('file');
		expect(schema.date.type).toBe('date');

		// First edit upgrades the stored shape to `schema` and drops `fieldHints`.
		await addCollectionField('words', field('title', 'string'));
		const cfg = readPostsSettings().collections?.words;
		expect(cfg?.schema).toBeDefined();
		expect(cfg?.fieldHints).toBeUndefined();
		expect(Object.keys(collectionSchema(cfg))).toEqual(['cover', 'date', 'title']);
	});
});
