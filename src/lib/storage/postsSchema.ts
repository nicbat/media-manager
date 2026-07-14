import * as fssync from 'node:fs';
import { getPostsSettingsPath, getPostFilePath, listPostSlugs } from './paths.js';
import { withFileLock } from './lock.js';
import { readTextFile, writeTextFileAtomic } from './json.js';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter.js';
import {
	readPostsSettings,
	writePostsSettings,
	collectionSchema,
	type CollectionConfig
} from './postsSettings.js';
import { reorderSchemaObject } from '$lib/core/fieldKeys.js';
import {
	FieldTypeSchema,
	fieldSupportsSuggest,
	normalizeUrlValue,
	type AddFieldRequest,
	type FieldDefinition,
	type SchemaDefinition
} from '$lib/core/types.js';

/**
 * Schema CRUD for a Posts **collection** (Item 14 convergence). A collection's frontmatter schema is a
 * full {@link SchemaDefinition} stored in `posts/settings.json` — the same shape a Records type / Files
 * class uses — so the shared schema editor (`SchemaEditorBody`) and settings dialog (`EntitySettingsDialog`)
 * drive it. These functions are the Posts analogue of `jsonRepo`'s `addSchemaField`/`updateSchemaField`/
 * `deleteSchemaField`/`reorderSchemaFields`, minus record-value seeding (posts render every schema field
 * whether or not the `.md` frontmatter carries a value) and minus two-way relation links (posts are
 * neither a class nor a type, so `linkedField` never applies).
 *
 * Rename + delete optionally propagate into each post's frontmatter (rename the key / strip it), keeping
 * the `.md` files consistent with the schema.
 */

const lockPath = () => `${getPostsSettingsPath()}.lock`;

/** Read a collection's effective schema (stored schema, else legacy-hint conversion, else empty). */
export function getCollectionSchema(collection: string): SchemaDefinition {
	return collectionSchema(readPostsSettings().collections?.[collection]);
}

/**
 * Mutate one collection's config under the settings lock, preserving every other collection. The
 * mutator receives the current config (or `{}`) and returns the next one; the effective schema is
 * pre-resolved onto `cfg.schema` first so a legacy-`fieldHints` collection upgrades to `schema` on the
 * first edit.
 */
async function mutateCollection(
	collection: string,
	mutator: (cfg: CollectionConfig) => CollectionConfig
): Promise<CollectionConfig> {
	return withFileLock(lockPath(), async () => {
		const settings = readPostsSettings();
		const collections = { ...(settings.collections ?? {}) };
		const current: CollectionConfig = {
			...(collections[collection] ?? {}),
			schema: collectionSchema(collections[collection])
		};
		delete (current as { fieldHints?: unknown }).fieldHints; // upgraded → drop the legacy key
		const next = mutator(current);
		collections[collection] = next;
		await writePostsSettings({ collections });
		return next;
	});
}

/** Build a {@link FieldDefinition} from an add-field request (no relation-link handling). */
function buildFieldDef(body: AddFieldRequest): FieldDefinition {
	const type = FieldTypeSchema.parse(body.fieldType);
	const canMultiselect = type === 'dropdown' || type === 'file' || type === 'record';
	return {
		type,
		removable: true,
		...(body.defaultValue !== undefined ? { defaultValue: body.defaultValue } : {}),
		...(type === 'dropdown' && body.options?.length ? { options: body.options } : {}),
		...(canMultiselect && body.multiselect ? { multiselect: true } : {}),
		...(type === 'record' && body.recordType ? { recordType: body.recordType } : {}),
		...(type === 'file' && body.classId ? { classId: body.classId } : {}),
		...(type === 'list' && body.itemTypes?.length ? { itemTypes: body.itemTypes } : {}),
		...(body.suggest && fieldSupportsSuggest(type, body.itemTypes) ? { suggest: true } : {})
	} as FieldDefinition;
}

/** Add a field to a collection's schema. Throws if the key already exists. */
export async function addCollectionField(
	collection: string,
	body: AddFieldRequest
): Promise<{ schema: SchemaDefinition }> {
	const cfg = await mutateCollection(collection, (c) => {
		const schema = { ...(c.schema ?? {}) };
		if (schema[body.fieldName]) throw new Error('Field already exists');
		schema[body.fieldName] = buildFieldDef(body);
		return { ...c, schema };
	});
	return { schema: cfg.schema ?? {} };
}

/** Field-definition updates accepted by {@link updateCollectionField}. */
export interface CollectionFieldUpdate {
	newKey?: string;
	type?: string;
	defaultValue?: unknown;
	options?: string[];
	itemTypes?: string[];
	multiselect?: boolean;
	suggest?: boolean;
	recordType?: string;
	classId?: string;
}

/** Update / rename a field. A rename also renames the key in every post's frontmatter. */
export async function updateCollectionField(
	collection: string,
	oldKey: string,
	updates: CollectionFieldUpdate
): Promise<{ schema: SchemaDefinition }> {
	let renamedTo: string | null = null;
	const cfg = await mutateCollection(collection, (c) => {
		const schema = { ...(c.schema ?? {}) };
		const def = schema[oldKey];
		if (!def) throw new Error('Field not found');
		const newKey = updates.newKey?.trim() || oldKey;
		if (newKey !== oldKey && schema[newKey]) throw new Error('Field already exists');
		const type = updates.type ? FieldTypeSchema.parse(updates.type) : def.type;
		const canMultiselect = type === 'dropdown' || type === 'file' || type === 'record';
		const multiselect = canMultiselect
			? (updates.multiselect ?? (def as { multiselect?: boolean }).multiselect ?? false)
			: false;
		let defaultValue = updates.defaultValue ?? def.defaultValue;
		if (type === 'url' && typeof defaultValue === 'string')
			defaultValue = normalizeUrlValue(defaultValue);
		const options = updates.options ?? def.options;
		const itemTypes = updates.itemTypes ?? (def as { itemTypes?: string[] }).itemTypes;
		const nextDef = {
			type,
			removable: def.removable ?? true,
			...(defaultValue !== undefined ? { defaultValue } : {}),
			...(type === 'dropdown' && options?.length ? { options } : {}),
			...(canMultiselect && multiselect ? { multiselect: true } : {}),
			...(type === 'record' && (updates.recordType ?? (def as { recordType?: string }).recordType)
				? { recordType: updates.recordType ?? (def as { recordType?: string }).recordType }
				: {}),
			...(type === 'file' && (updates.classId ?? (def as { classId?: string }).classId)
				? { classId: updates.classId ?? (def as { classId?: string }).classId }
				: {}),
			...(type === 'list' && itemTypes?.length ? { itemTypes } : {}),
			...(updates.suggest && fieldSupportsSuggest(type, itemTypes) ? { suggest: true } : {})
		} as FieldDefinition;
		// Rebuild the object so a rename keeps the field's position (replace the key in place).
		const rebuilt: SchemaDefinition = {};
		for (const [k, v] of Object.entries(schema))
			rebuilt[k === oldKey ? newKey : k] = k === oldKey ? nextDef : v;
		if (newKey !== oldKey) renamedTo = newKey;
		return { ...c, schema: rebuilt };
	});
	if (renamedTo) await renameFrontmatterKeyInPosts(collection, oldKey, renamedTo);
	return { schema: cfg.schema ?? {} };
}

/** Delete a field from a collection's schema; `stripFromPosts` also removes it from every post's frontmatter. */
export async function deleteCollectionField(
	collection: string,
	key: string,
	stripFromPosts: boolean
): Promise<{ schema: SchemaDefinition }> {
	const cfg = await mutateCollection(collection, (c) => {
		const schema = { ...(c.schema ?? {}) };
		if (!schema[key]) throw new Error('Field not found');
		delete schema[key];
		const displayField = c.displayField === key ? undefined : c.displayField;
		return { ...c, schema, displayField };
	});
	if (stripFromPosts) await removeFrontmatterKeyFromPosts(collection, key);
	return { schema: cfg.schema ?? {} };
}

/** Reorder a collection's schema fields to `orderedKeys` (omitted keys are appended). */
export async function reorderCollectionSchema(
	collection: string,
	orderedKeys: string[]
): Promise<{ schema: SchemaDefinition }> {
	const cfg = await mutateCollection(collection, (c) => ({
		...c,
		schema: reorderSchemaObject(c.schema ?? {}, orderedKeys)
	}));
	return { schema: cfg.schema ?? {} };
}

/** Update a collection's general config (display name, icon, title-by field). */
export async function setCollectionConfig(
	collection: string,
	patch: { displayName?: string; icon?: string; displayField?: string }
): Promise<CollectionConfig> {
	return mutateCollection(collection, (c) => ({
		...c,
		...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
		...(patch.icon !== undefined ? { icon: patch.icon || undefined } : {}),
		...(patch.displayField !== undefined ? { displayField: patch.displayField || undefined } : {})
	}));
}

/** Rename a frontmatter key across every post in a collection (preserves the value). Best-effort. */
async function renameFrontmatterKeyInPosts(collection: string, oldKey: string, newKey: string) {
	for (const slug of listPostSlugs(collection)) {
		const filePath = getPostFilePath(collection, slug);
		try {
			const { frontmatter, body } = parseFrontmatter(await readTextFile(filePath));
			if (!(oldKey in frontmatter)) continue;
			const next: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(frontmatter)) next[k === oldKey ? newKey : k] = v;
			await writeTextFileAtomic(filePath, serializeFrontmatter(next, body));
		} catch {
			/* skip unreadable posts */
		}
	}
}

/** Remove a frontmatter key from every post in a collection. Best-effort. */
async function removeFrontmatterKeyFromPosts(collection: string, key: string) {
	for (const slug of listPostSlugs(collection)) {
		const filePath = getPostFilePath(collection, slug);
		try {
			if (!fssync.existsSync(filePath)) continue;
			const { frontmatter, body } = parseFrontmatter(await readTextFile(filePath));
			if (!(key in frontmatter)) continue;
			const next = { ...frontmatter };
			delete next[key];
			await writeTextFileAtomic(filePath, serializeFrontmatter(next, body));
		} catch {
			/* skip unreadable posts */
		}
	}
}
