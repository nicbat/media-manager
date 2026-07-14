import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	AddFieldRequestSchema,
	UpdateFieldRequestSchema,
	DeleteFieldRequestSchema
} from '$lib/core/types.js';
import { assertSafeSegment } from '$lib/server/postsGuard.js';
import { listPostCollections } from '$lib/storage/postsRepo.js';
import {
	getCollectionSchema,
	addCollectionField,
	updateCollectionField,
	deleteCollectionField
} from '$lib/storage/postsSchema.js';

function assertCollection(collection: string) {
	if (!listPostCollections().some((c) => c.id === collection))
		throw error(404, 'Collection not found');
}

/** GET: The collection's frontmatter schema (`SchemaDefinition`). */
export const GET: RequestHandler = async ({ params }) => {
	const collection = assertSafeSegment(params.collection, 'collection');
	assertCollection(collection);
	return json(getCollectionSchema(collection));
};

/** POST: Add a field to the collection schema. */
export const POST: RequestHandler = async ({ params, request }) => {
	const collection = assertSafeSegment(params.collection, 'collection');
	assertCollection(collection);
	const parsed = AddFieldRequestSchema.safeParse(await request.json());
	if (!parsed.success) throw error(400, 'Invalid schema field payload');
	try {
		const result = await addCollectionField(collection, parsed.data);
		return json({ success: true, schema: result.schema });
	} catch (err) {
		const e = err as Error;
		if (e.message === 'Field already exists') throw error(409, e.message);
		throw error(500, { message: e.message ?? 'Failed to add field' });
	}
};

/** PATCH: Update / rename a field (renames the key across every post's frontmatter). */
export const PATCH: RequestHandler = async ({ params, request }) => {
	const collection = assertSafeSegment(params.collection, 'collection');
	assertCollection(collection);
	const parsed = UpdateFieldRequestSchema.safeParse(await request.json());
	if (!parsed.success) throw error(400, 'Invalid update payload');
	try {
		const result = await updateCollectionField(collection, parsed.data.fieldName, {
			newKey: parsed.data.newFieldName,
			type: parsed.data.fieldType,
			defaultValue: parsed.data.defaultValue,
			options: parsed.data.options,
			itemTypes: parsed.data.itemTypes,
			multiselect: parsed.data.multiselect,
			suggest: parsed.data.suggest,
			recordType: parsed.data.recordType,
			classId: parsed.data.classId
		});
		return json({ success: true, schema: result.schema });
	} catch (err) {
		const e = err as Error;
		if (e.message === 'Field not found') throw error(404, e.message);
		if (e.message === 'Field already exists') throw error(409, e.message);
		throw error(500, { message: e.message ?? 'Failed to update field' });
	}
};

/** DELETE: Remove a field; `removeFromImages` also strips it from every post's frontmatter. */
export const DELETE: RequestHandler = async ({ params, request }) => {
	const collection = assertSafeSegment(params.collection, 'collection');
	assertCollection(collection);
	const parsed = DeleteFieldRequestSchema.safeParse(await request.json());
	if (!parsed.success) throw error(400, 'Invalid delete payload');
	try {
		const result = await deleteCollectionField(
			collection,
			parsed.data.fieldName,
			parsed.data.removeFromImages ?? false
		);
		return json({ success: true, schema: result.schema });
	} catch (err) {
		const e = err as Error;
		if (e.message === 'Field not found') throw error(404, e.message);
		throw error(500, { message: e.message ?? 'Failed to delete field' });
	}
};
