import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
	createClass,
	deleteClass,
	classExists,
	listClasses,
	addMembers,
	removeMembers,
	updateRecord,
	getRecord,
	listAllFiles,
	listClassMembers,
	updateClassConfig,
	addSchemaField,
	updateSchemaField,
	reorderSchemaFields,
	getClassSchema,
	getUniqueFieldValues,
	renameBlobById,
	deleteFromDiskById
} from './classRepo.js';
import { readManifest, setDerivedEntries, type DerivedEntry } from './manifest.js';
import { createMediaType } from './mediaTypes.js';
import { getMediaTypeRepo } from '$lib/server/imageRepo.js';
import type { SchemaDefinition } from '$lib/core/types.js';

const schema = {
	caption: { type: 'string', removable: true, defaultValue: '' }
} as unknown as SchemaDefinition;

describe('classRepo — opt-in class membership', () => {
	let filesDir: string;
	beforeEach(() => {
		const root = path.join(
			tmpdir(),
			`mm-class-test-${Date.now()}-${Math.random().toString(16).slice(2)}`
		);
		filesDir = path.join(root, 'media', 'files');
		fs.mkdirSync(filesDir, { recursive: true });
		fs.mkdirSync(path.join(root, 'media', 'classes'), { recursive: true });
		process.env.MEDIA_MANAGER_ROOT = root;
	});

	it('mints a file_id for a disk blob and starts it unclassified', async () => {
		fs.writeFileSync(path.join(filesDir, 'a.png'), 'x');
		const { files } = await listAllFiles();
		expect(files).toHaveLength(1);
		expect(files[0].file_name).toBe('a.png');
		expect(files[0].classes).toEqual([]);
	});

	it('round-trips membership, metadata, and the derived index', async () => {
		fs.writeFileSync(path.join(filesDir, 'a.png'), 'x');
		const fileId = (await listAllFiles()).files[0].id;

		const id = await createClass('Gallery', schema);
		expect(id).toBe('gallery');
		expect(classExists(id)).toBe(true);

		await addMembers(id, [fileId]);
		expect(listClasses().find((c) => c.id === id)?.count).toBe(1);

		// The manifest's derived index now reflects membership.
		expect((await listAllFiles()).files[0].classes).toEqual(['gallery']);

		// One-class catalog view shows the member.
		expect((await listClassMembers(id)).files.map((f) => f.id)).toEqual([fileId]);

		await updateRecord(id, fileId, { caption: 'hello' });
		expect((await getRecord(id, fileId))?.caption).toBe('hello');

		await removeMembers(id, [fileId]);
		expect((await listAllFiles()).files[0].classes).toEqual([]);
		expect(await getRecord(id, fileId)).toBeNull();
	});

	it('deleting a class leaves the blob (now unclassified) on disk', async () => {
		fs.writeFileSync(path.join(filesDir, 'a.png'), 'x');
		const fileId = (await listAllFiles()).files[0].id;
		const id = await createClass('Temp', schema);
		await addMembers(id, [fileId]);

		await deleteClass(id);
		expect(classExists(id)).toBe(false);
		const { files } = await listAllFiles();
		expect(files).toHaveLength(1);
		expect(files[0].classes).toEqual([]);
	});

	it('groups the multi-class "all of" listing by a chosen class field', async () => {
		fs.writeFileSync(path.join(filesDir, 'a.png'), 'x');
		const fileId = (await listAllFiles()).files[0].id;

		const images = await createClass('Images', schema);
		const docs = await createClass('Documents', {
			description: { type: 'string', removable: true, defaultValue: '' }
		} as unknown as SchemaDefinition);
		await addMembers(images, [fileId]);
		await addMembers(docs, [fileId]);
		await updateRecord(docs, fileId, { description: 'Scenic' });

		// Intersection of both classes, grouped by the Documents field.
		const { files } = await listAllFiles({
			classIds: [images, docs],
			matchAll: true,
			groupBy: { classId: docs, field: 'description' }
		});
		expect(files.map((f) => f.id)).toEqual([fileId]);
		expect(files[0].group_by_value).toBe('Scenic');

		// Without groupBy the value is absent.
		const plain = await listAllFiles({ classIds: [images, docs], matchAll: true });
		expect(plain.files[0].group_by_value).toBeUndefined();
	});

	it('an empty-schema class is a valid pure tag', async () => {
		fs.writeFileSync(path.join(filesDir, 'a.png'), 'x');
		const fileId = (await listAllFiles()).files[0].id;
		const id = await createClass('Favorites');
		await addMembers(id, [fileId]);
		const rec = await getRecord(id, fileId);
		expect(rec).not.toBeNull();
		expect((await listAllFiles()).files[0].classes).toEqual(['favorites']);
	});

	it('searches a single class by field value, by All-fields, and respects field scope', async () => {
		fs.writeFileSync(path.join(filesDir, 'a.png'), 'x');
		fs.writeFileSync(path.join(filesDir, 'b.png'), 'y');
		const files0 = (await listAllFiles()).files;
		const aId = files0.find((f) => f.file_name === 'a.png')!.id;
		const bId = files0.find((f) => f.file_name === 'b.png')!.id;
		const id = await createClass('Gallery', schema);
		await addMembers(id, [aId, bId]);
		await updateRecord(id, aId, { caption: 'sunset' });
		await updateRecord(id, bId, { caption: 'mountain' });

		// Field-scoped: only the caption field is matched.
		expect(
			(await listClassMembers(id, { query: 'sun', searchField: 'caption' })).files.map((f) => f.id)
		).toEqual([aId]);
		// All-fields (no searchField) also matches the filename.
		expect((await listClassMembers(id, { query: 'b.png' })).files.map((f) => f.id)).toEqual([bId]);
		// A field-scoped query ignores the filename: 'a.png' won't match the caption field.
		expect(
			(await listClassMembers(id, { query: 'a.png', searchField: 'caption' })).files
		).toHaveLength(0);
	});

	it('resolves the class "Title by" (config.displayField) into per-member title_value', async () => {
		fs.writeFileSync(path.join(filesDir, 'a.png'), 'x');
		fs.writeFileSync(path.join(filesDir, 'b.png'), 'y');
		const files0 = (await listAllFiles()).files;
		const aId = files0.find((f) => f.file_name === 'a.png')!.id;
		const bId = files0.find((f) => f.file_name === 'b.png')!.id;
		const id = await createClass('Gallery', schema);
		await addMembers(id, [aId, bId]);
		await updateRecord(id, aId, { caption: 'Sunset over hills' });
		await updateRecord(id, bId, { caption: '' }); // empty ⇒ no title_value (tile falls back to filename)

		// No title-by set yet ⇒ no title_value at all.
		const before = (await listClassMembers(id)).files;
		expect(before.every((f) => f.title_value === undefined)).toBe(true);

		await updateClassConfig(id, { displayField: 'caption' });
		const after = (await listClassMembers(id)).files;
		expect(after.find((f) => f.id === aId)!.title_value).toBe('Sunset over hills');
		// Empty field value is not surfaced as a title — the client falls back to the filename.
		expect(after.find((f) => f.id === bId)!.title_value).toBeUndefined();
	});

	it('inlines requested field values per member (verbose grid, Item 8) — empty ⇒ "", capped at 6', async () => {
		fs.writeFileSync(path.join(filesDir, 'a.png'), 'x');
		const fileId = (await listAllFiles()).files[0].id;
		// A class with more than the 6-field cap so we can prove the clamp.
		const wide = await createClass('Wide', {
			f1: { type: 'string', removable: true, defaultValue: '' },
			f2: { type: 'string', removable: true, defaultValue: '' },
			f3: { type: 'string', removable: true, defaultValue: '' },
			f4: { type: 'string', removable: true, defaultValue: '' },
			f5: { type: 'string', removable: true, defaultValue: '' },
			f6: { type: 'string', removable: true, defaultValue: '' },
			f7: { type: 'string', removable: true, defaultValue: '' }
		} as unknown as SchemaDefinition);
		await addMembers(wide, [fileId]);
		await updateRecord(wide, fileId, { f1: 'one', f3: 'three' }); // f2 left empty

		// No fields requested ⇒ no verbose payload at all (compact rows).
		expect((await listClassMembers(wide)).files[0].field_values).toBeUndefined();

		// Requested fields are inlined in request order; an empty field is surfaced as '' (rows align).
		const subset = (await listClassMembers(wide, { fields: ['f1', 'f2', 'f3'] })).files[0];
		expect(subset.field_values).toEqual({ f1: 'one', f2: '', f3: 'three' });

		// More than the cap of 6 ⇒ clamped to the first 6 requested keys.
		const capped = (
			await listClassMembers(wide, { fields: ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7'] })
		).files[0];
		expect(Object.keys(capped.field_values ?? {})).toEqual(['f1', 'f2', 'f3', 'f4', 'f5', 'f6']);

		// Keys not in the schema are dropped defensively.
		const stale = (await listClassMembers(wide, { fields: ['f1', 'nope'] })).files[0];
		expect(stale.field_values).toEqual({ f1: 'one' });
	});

	it('searches an intersection by classId::field and by All-fields', async () => {
		fs.writeFileSync(path.join(filesDir, 'a.png'), 'x');
		fs.writeFileSync(path.join(filesDir, 'b.png'), 'y');
		const files0 = (await listAllFiles()).files;
		const aId = files0.find((f) => f.file_name === 'a.png')!.id;
		const bId = files0.find((f) => f.file_name === 'b.png')!.id;
		const images = await createClass('Images', schema);
		const docs = await createClass('Documents', {
			description: { type: 'string', removable: true, defaultValue: '' }
		} as unknown as SchemaDefinition);
		await addMembers(images, [aId, bId]);
		await addMembers(docs, [aId, bId]);
		await updateRecord(docs, aId, { description: 'invoice' });
		await updateRecord(docs, bId, { description: 'receipt' });

		// Specific field of the docs class via the classId::field encoding.
		const byField = await listAllFiles({
			classIds: [images, docs],
			matchAll: true,
			query: 'invo',
			searchField: `${docs}::description`
		});
		expect(byField.files.map((f) => f.id)).toEqual([aId]);

		// All-fields intersection search reaches the docs field too.
		const all = await listAllFiles({ classIds: [images, docs], matchAll: true, query: 'receipt' });
		expect(all.files.map((f) => f.id)).toEqual([bId]);
	});

	it('sorts the All Files listing by filename ascending and descending (Item 9)', async () => {
		for (const n of ['c.png', 'a.png', 'b.png']) fs.writeFileSync(path.join(filesDir, n), 'x');
		const asc = (await listAllFiles({ sortField: 'name', sortDir: 'asc' })).files.map(
			(f) => f.file_name
		);
		expect(asc).toEqual(['a.png', 'b.png', 'c.png']);
		const desc = (await listAllFiles({ sortField: 'name', sortDir: 'desc' })).files.map(
			(f) => f.file_name
		);
		expect(desc).toEqual(['c.png', 'b.png', 'a.png']);
	});

	it('sorts class members by a schema field, composes with search, and sorts empties last', async () => {
		for (const n of ['a.png', 'b.png', 'c.png']) fs.writeFileSync(path.join(filesDir, n), 'x');
		const files0 = (await listAllFiles()).files;
		const byName = Object.fromEntries(files0.map((f) => [f.file_name, f.id]));
		const id = await createClass('Gallery', schema);
		await addMembers(
			id,
			files0.map((f) => f.id)
		);
		await updateRecord(id, byName['a.png'], { caption: 'zebra' });
		await updateRecord(id, byName['b.png'], { caption: 'apple' });
		// c.png has no caption → empty, must sort last in BOTH directions.
		const asc = (await listClassMembers(id, { sortField: 'caption', sortDir: 'asc' })).files.map(
			(f) => f.file_name
		);
		expect(asc).toEqual(['b.png', 'a.png', 'c.png']); // apple, zebra, then empty
		const desc = (await listClassMembers(id, { sortField: 'caption', sortDir: 'desc' })).files.map(
			(f) => f.file_name
		);
		expect(desc).toEqual(['a.png', 'b.png', 'c.png']); // zebra, apple, empty still last

		// Composes with a field-scoped search: only 'apple' contains 'p', still under the chosen sort.
		const searched = (
			await listClassMembers(id, {
				query: 'p',
				searchField: 'caption',
				sortField: 'caption',
				sortDir: 'asc'
			})
		).files.map((f) => f.file_name);
		expect(searched).toEqual(['b.png']);
	});

	it('honors a class config sort default when no sort param is given', async () => {
		for (const n of ['a.png', 'b.png', 'c.png']) fs.writeFileSync(path.join(filesDir, n), 'x');
		const files0 = (await listAllFiles()).files;
		const id = await createClass('Gallery', schema);
		await addMembers(
			id,
			files0.map((f) => f.id)
		);
		await updateClassConfig(id, { sortField: 'name', sortDir: 'desc' });
		const names = (await listClassMembers(id)).files.map((f) => f.file_name);
		expect(names).toEqual(['c.png', 'b.png', 'a.png']);
	});

	it('filters class members to the incomplete ones, composing with search (Item 10)', async () => {
		for (const n of ['a.png', 'b.png', 'c.png']) fs.writeFileSync(path.join(filesDir, n), 'x');
		const files0 = (await listAllFiles()).files;
		const byName = Object.fromEntries(files0.map((f) => [f.file_name, f.id]));
		const id = await createClass('Gallery', schema);
		await addMembers(
			id,
			files0.map((f) => f.id)
		);
		await updateRecord(id, byName['a.png'], { caption: 'filled' });
		// b.png and c.png keep the empty default caption → incomplete.

		const incomplete = (await listClassMembers(id, { incomplete: true })).files
			.map((f) => f.file_name)
			.sort();
		expect(incomplete).toEqual(['b.png', 'c.png']);

		// Without the flag, all three come back (no-op guard).
		expect((await listClassMembers(id)).files).toHaveLength(3);

		// Composes with search: only the incomplete member whose name matches 'b'.
		const both = (await listClassMembers(id, { incomplete: true, query: 'b.png' })).files.map(
			(f) => f.file_name
		);
		expect(both).toEqual(['b.png']);
	});

	it('round-trips the `suggest` flag through add/update and gates it by type', async () => {
		const id = await createClass('Gallery', schema);

		// Qualifying fields persist the flag.
		await addSchemaField(id, 'note', 'string', '', undefined, undefined, undefined, true);
		await addSchemaField(id, 'tags', 'list', [], undefined, ['string'], undefined, true);
		// Non-qualifying field: the flag is dropped even when requested.
		await addSchemaField(id, 'count', 'number', 0, undefined, undefined, undefined, true);
		// list(number) does not qualify either.
		await addSchemaField(id, 'sizes', 'list', [], undefined, ['number'], undefined, true);

		let schemaNow = await getClassSchema(id);
		expect((schemaNow.note as { suggest?: boolean }).suggest).toBe(true);
		expect((schemaNow.tags as { suggest?: boolean }).suggest).toBe(true);
		expect((schemaNow.count as { suggest?: boolean }).suggest).toBeUndefined();
		expect((schemaNow.sizes as { suggest?: boolean }).suggest).toBeUndefined();

		// Turning it off persists (absent flag), and a rename preserves it.
		await updateSchemaField(id, 'note', { suggest: false });
		await updateSchemaField(id, 'tags', { newKey: 'labels' });
		schemaNow = await getClassSchema(id);
		expect((schemaNow.note as { suggest?: boolean }).suggest).toBeUndefined();
		expect((schemaNow.labels as { suggest?: boolean }).suggest).toBe(true);
	});

	it('getUniqueFieldValues flattens list items into distinct sorted values', async () => {
		fs.writeFileSync(path.join(filesDir, 'a.png'), 'x');
		fs.writeFileSync(path.join(filesDir, 'b.png'), 'y');
		const ids = (await listAllFiles()).files.map((f) => f.id);

		const id = await createClass('Gallery', {
			tags: { type: 'list', removable: true, itemTypes: ['string'], defaultValue: [] }
		} as unknown as SchemaDefinition);
		await addMembers(id, ids);
		await updateRecord(id, ids[0], { tags: ['warm', 'sky'] });
		await updateRecord(id, ids[1], { tags: ['sky', 'green'] });

		// Individual items, de-duped and sorted — the autocomplete source for a `suggest` tags field.
		expect(await getUniqueFieldValues(id, 'tags')).toEqual(['green', 'sky', 'warm']);
	});

	it('resolves a record-field reference to the target title and flags a dangling ref', async () => {
		// A 'people' json record type with one named record.
		const peopleId = await createMediaType('People');
		const people = getMediaTypeRepo(peopleId);
		await people.addSchemaField('name', 'string', '');
		const alice = await people.createRecord();
		await people.updatePropertiesById(alice.id, { name: 'Alice' });

		// A file in a class whose `author` record field points at people and titles each tile.
		fs.writeFileSync(path.join(filesDir, 'a.png'), 'x');
		const fileId = (await listAllFiles()).files[0].id;
		const classId = await createClass('Docs', {} as SchemaDefinition);
		await addSchemaField(
			classId,
			'author',
			'record',
			'',
			undefined,
			undefined,
			false,
			false,
			peopleId
		);
		await updateClassConfig(classId, { displayField: 'author' });
		await addMembers(classId, [fileId]);
		await updateRecord(classId, fileId, { author: alice.id });

		// Catalog view resolves the referenced record's title; nothing is missing.
		let members = await listClassMembers(classId);
		expect(members.files[0].title_value).toBe('Alice');
		expect(members.files[0].missing_record_fields).toBeUndefined();
		expect((await getRecord(classId, fileId))?._missing_records).toBeUndefined();

		// Deleting the target record leaves the reference dangling — flagged on both read paths.
		await people.deleteRecord(alice.id);
		members = await listClassMembers(classId);
		expect(members.files[0].missing_record_fields).toEqual(['author']);
		expect((await getRecord(classId, fileId))?._missing_records).toMatchObject({
			author: expect.any(String)
		});
	});
});

describe('reorderSchemaFields (class)', () => {
	let filesDir: string;
	beforeEach(() => {
		const root = path.join(
			tmpdir(),
			`mm-reorder-test-${Date.now()}-${Math.random().toString(16).slice(2)}`
		);
		filesDir = path.join(root, 'media', 'files');
		fs.mkdirSync(filesDir, { recursive: true });
		fs.mkdirSync(path.join(root, 'media', 'classes'), { recursive: true });
		process.env.MEDIA_MANAGER_ROOT = root;
	});

	it('persists a new field order and preserves it on read', async () => {
		const id = await createClass('Docs', {} as SchemaDefinition);
		await addSchemaField(id, 'alpha', 'string', '');
		await addSchemaField(id, 'beta', 'string', '');
		await addSchemaField(id, 'gamma', 'string', '');
		// Default order is insertion order.
		expect(Object.keys(await getClassSchema(id))).toEqual(['alpha', 'beta', 'gamma']);

		const { schema } = await reorderSchemaFields(id, ['gamma', 'alpha', 'beta']);
		expect(Object.keys(schema)).toEqual(['gamma', 'alpha', 'beta']);
		// And it round-trips from disk.
		expect(Object.keys(await getClassSchema(id))).toEqual(['gamma', 'alpha', 'beta']);
	});

	it('appends fields omitted from the order', async () => {
		const id = await createClass('Docs', {} as SchemaDefinition);
		await addSchemaField(id, 'alpha', 'string', '');
		await addSchemaField(id, 'beta', 'string', '');
		await addSchemaField(id, 'gamma', 'string', '');
		const { schema } = await reorderSchemaFields(id, ['gamma']);
		expect(Object.keys(schema)).toEqual(['gamma', 'alpha', 'beta']);
	});
});

describe('reorderSchemaFields (json type)', () => {
	beforeEach(() => {
		const root = path.join(
			tmpdir(),
			`mm-reorder-type-test-${Date.now()}-${Math.random().toString(16).slice(2)}`
		);
		fs.mkdirSync(path.join(root, 'media', 'files'), { recursive: true });
		fs.mkdirSync(path.join(root, 'media', 'classes'), { recursive: true });
		process.env.MEDIA_MANAGER_ROOT = root;
	});

	it('reorders a record type schema and keeps it on read', async () => {
		const typeId = await createMediaType('Tasks');
		const repo = getMediaTypeRepo(typeId);
		await repo.addSchemaField('priority', 'string', '');
		await repo.addSchemaField('due', 'string', '');
		await repo.addSchemaField('owner', 'string', '');

		const { schema } = await repo.reorderSchemaFields(['owner', 'priority', 'due']);
		const order = Object.keys(schema).filter((k) => ['owner', 'priority', 'due'].includes(k));
		expect(order).toEqual(['owner', 'priority', 'due']);

		const reread = await repo.getSchema();
		const order2 = Object.keys(reread).filter((k) => ['owner', 'priority', 'due'].includes(k));
		expect(order2).toEqual(['owner', 'priority', 'due']);
	});
});

/**
 * The blob lifecycle's compression half (Item 15): a derivative is bookkeeping *about* an original, so
 * deleting or renaming the original has to carry it along — a derivative of a deleted blob is garbage,
 * and one left under a stale name is only reachable because every lookup reads the manifest.
 */
describe('blob lifecycle keeps derivatives in step (Item 15)', () => {
	let root: string;
	let filesDir: string;
	let derivedRoot: string;

	beforeEach(() => {
		root = path.join(
			tmpdir(),
			`mm-class-derived-${Date.now()}-${Math.random().toString(16).slice(2)}`
		);
		filesDir = path.join(root, 'media', 'files');
		derivedRoot = path.join(root, 'media', 'derived');
		fs.mkdirSync(filesDir, { recursive: true });
		fs.mkdirSync(path.join(root, 'media', 'classes'), { recursive: true });
		process.env.MEDIA_MANAGER_ROOT = root;
		delete process.env.MEDIA_MANAGER_ASSETS_DIR;
	});

	afterEach(() => {
		delete process.env.MEDIA_MANAGER_ASSETS_DIR;
		fs.rmSync(root, { recursive: true, force: true });
	});

	/** Register a blob on disk, give it a `web` derivative on disk + in the manifest, return its id. */
	async function seedBlobWithDerivative(name: string, derivedName: string): Promise<string> {
		fs.writeFileSync(path.join(filesDir, name), 'original-bytes');
		const id = (await listAllFiles()).files.find((f) => f.file_name === name)!.id;
		fs.mkdirSync(path.join(derivedRoot, 'web'), { recursive: true });
		fs.writeFileSync(path.join(derivedRoot, 'web', derivedName), 'derived-bytes');
		const entry: DerivedEntry = {
			file_name: derivedName,
			size: 13,
			width: 40,
			height: 30,
			ssim: 0.99,
			recipe: 'webp:q80',
			source_size: 14
		};
		await setDerivedEntries(new Map([[id, { web: entry }]]));
		return id;
	}

	it('deleteFromDiskById removes the derivative file AND its manifest record', async () => {
		const id = await seedBlobWithDerivative('a.png', 'a.webp');
		const keeperId = await seedBlobWithDerivative('b.png', 'b.webp');

		await deleteFromDiskById(id);

		expect(fs.existsSync(path.join(filesDir, 'a.png'))).toBe(false);
		expect(fs.existsSync(path.join(derivedRoot, 'web', 'a.webp'))).toBe(false);
		const manifest = await readManifest();
		expect(manifest.files[id]).toBeUndefined();
		// The other blob's derivative is untouched.
		expect(manifest.files[keeperId].derived?.web.file_name).toBe('b.webp');
		expect(fs.existsSync(path.join(derivedRoot, 'web', 'b.webp'))).toBe(true);
	});

	it('renameBlobById renames the derivative on disk and updates its manifest file_name', async () => {
		const id = await seedBlobWithDerivative('old.png', 'old.webp');

		await renameBlobById(id, 'new.png');

		expect(fs.existsSync(path.join(filesDir, 'new.png'))).toBe(true);
		expect(fs.existsSync(path.join(derivedRoot, 'web', 'new.webp'))).toBe(true);
		expect(fs.existsSync(path.join(derivedRoot, 'web', 'old.webp'))).toBe(false);

		// Still readable *through the manifest* — the only lookup path there is.
		const entry = (await readManifest()).files[id];
		expect(entry.file_name).toBe('new.png');
		expect(entry.derived?.web.file_name).toBe('new.webp');
		expect(
			fs.readFileSync(path.join(derivedRoot, 'web', entry.derived!.web.file_name!), 'utf-8')
		).toBe('derived-bytes');
		// The rename is bookkeeping only: the staleness key and measurements survive.
		expect(entry.derived?.web).toMatchObject({ recipe: 'webp:q80', size: 13, ssim: 0.99 });
	});

	it('a rename colliding with an existing derivative stem picks a free name', async () => {
		const id = await seedBlobWithDerivative('old.png', 'old.webp');
		await seedBlobWithDerivative('taken.png', 'taken.webp');

		await renameBlobById(id, 'taken.jpg'); // different original extension, same stem

		const derived = (await readManifest()).files[id].derived?.web;
		expect(derived?.file_name).not.toBe('taken.webp');
		expect(fs.existsSync(path.join(derivedRoot, 'web', derived!.file_name!))).toBe(true);
		// The other blob's derivative was not clobbered.
		expect(fs.readFileSync(path.join(derivedRoot, 'web', 'taken.webp'), 'utf-8')).toBe(
			'derived-bytes'
		);
	});
});

describe('lazy size backfill on listing (Item 15)', () => {
	let root: string;
	let filesDir: string;

	beforeEach(() => {
		root = path.join(tmpdir(), `mm-size-heal-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		filesDir = path.join(root, 'media', 'files');
		fs.mkdirSync(filesDir, { recursive: true });
		fs.mkdirSync(path.join(root, 'media', 'classes'), { recursive: true });
		process.env.MEDIA_MANAGER_ROOT = root;
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it('gives a hand-dropped blob adopted by reconcile a size (fixes the empty file:size cell)', async () => {
		// `size` was historically written only at mint, so anything adopted from disk had none.
		const bytes = 'hand-dropped-bytes';
		fs.writeFileSync(path.join(filesDir, 'dropped.png'), bytes);

		const { files } = await listAllFiles();
		expect(files).toHaveLength(1);
		expect(files[0].size).toBe(bytes.length);

		// And it is persisted, not just projected onto the response.
		const manifest = await readManifest();
		expect(manifest.files[files[0].id].size).toBe(bytes.length);
	});

	it('backfills sizes for non-image blobs too (the dimension backfill skips those)', async () => {
		fs.writeFileSync(path.join(filesDir, 'notes.pdf'), 'pdf-ish');
		const { files } = await listAllFiles();
		expect(files[0].size).toBe('pdf-ish'.length);
		expect(files[0].width).toBeUndefined();
	});

	it('is lazy — an already-recorded size is left alone (no per-listing stat storm)', async () => {
		fs.writeFileSync(path.join(filesDir, 'a.png'), 'abcdef');
		const id = (await listAllFiles()).files[0].id;
		expect((await readManifest()).files[id].size).toBe(6);

		// Hand-edit the stored size to disagree with disk: the backfill only fills *absent* sizes, so it
		// must not re-stat and correct this one (that is `mintFileId`'s job, on re-upload).
		const manifestPath = path.join(root, 'media', 'manifest.json');
		const doc = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
		doc.files[id].size = 9999;
		fs.writeFileSync(manifestPath, JSON.stringify(doc));

		expect((await listAllFiles()).files[0].size).toBe(9999);
	});
});
