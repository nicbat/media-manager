import type { EntitySettingsAdapter } from './types.js';
import { fieldLabel, schemaUserFields } from '$lib/core/fieldKeys.js';
import type { SchemaDefinition } from '$lib/core/types.js';
import {
	apiGetClass,
	apiUpdateClassConfig,
	apiDeleteClass,
	apiAddClassField,
	apiUpdateClassField,
	apiDeleteClassField,
	apiReorderClassSchema
} from '$lib/api/files.js';
import {
	apiGetTypeSettings,
	apiUpdateTypeSettings,
	apiDeleteMediaType,
	apiGetSchemaForType,
	apiAddSchemaFieldForType,
	apiUpdateSchemaFieldForType,
	apiDeleteSchemaFieldForType,
	apiReorderSchemaFieldsForType
} from '$lib/api/client.js';
import {
	apiGetPostCollection,
	apiUpdatePostCollection,
	apiDeletePostCollection,
	apiGetPostCollectionSchema,
	apiAddPostCollectionField,
	apiUpdatePostCollectionField,
	apiDeletePostCollectionField,
	apiReorderPostCollectionSchema
} from '$lib/api/posts.js';

/** `{ key, label }` list for a class schema's title/group selects, in schema (manual) order. */
function classFields(schema: SchemaDefinition): { key: string; label: string }[] {
	return Object.keys(schema).map((k) => ({ key: k, label: fieldLabel(k) }));
}

/**
 * Entity-settings adapter for a Files **class** (`/api/classes/[id]`). General tab persists
 * `displayName`, `displayField` (title-by), `gridGroupByField` (group-by), and the class's
 * `compressionPresets` **subscription** (Item 15 phase 2); Fields tab drives the class schema; Danger
 * tab deletes the class.
 */
export function classSettingsAdapter(classId: string): EntitySettingsAdapter {
	return {
		noun: 'class',
		recordNoun: 'record',
		hasGroupBy: true,
		hasSubtitle: false,
		// Classes own blobs, so they're the one entity that can subscribe to compression presets.
		hasCompression: true,
		load: async () => {
			const detail = await apiGetClass(classId);
			return {
				displayName: detail.config.displayName ?? '',
				icon: detail.config.icon ?? '',
				titleBy: detail.config.displayField ?? '',
				subtitleBy: '',
				groupBy: detail.config.gridGroupByField ?? '',
				compressionPresets: detail.config.compressionPresets ?? [],
				fields: classFields(detail.schema)
			};
		},
		save: async ({ displayName, icon, titleBy, groupBy, compressionPresets }) => {
			await apiUpdateClassConfig(classId, {
				displayName,
				// '' is sent verbatim to clear (it resolves to the generic fallback when rendered).
				icon,
				displayField: titleBy || undefined,
				gridGroupByField: groupBy || undefined,
				// Always sent (an empty array is how the server clears the subscription). Saving it makes
				// the server regenerate/prune this class's members in the background — never a prompt.
				compressionPresets
			});
		},
		schema: {
			entityKind: 'class',
			entityId: classId,
			getSchema: async () => (await apiGetClass(classId)).schema,
			addField: (body) => apiAddClassField(classId, body),
			updateField: (body) => apiUpdateClassField(classId, body),
			deleteField: (fieldName, removeFromRecords) =>
				apiDeleteClassField(classId, fieldName, removeFromRecords),
			reorderFields: (order) => apiReorderClassSchema(classId, order)
		},
		remove: () => apiDeleteClass(classId)
	};
}

/** `{ key, label }` list for a record type: user fields + `name`, name first (shared helper). */
const typeFields = schemaUserFields;

/**
 * Media-type schema key ordering for the schema editor: hide system keys, float the `name` field
 * first, otherwise preserve schema (manual) order. Stable sort keeps non-`name` keys in object order.
 */
function orderTypeKeys(s: SchemaDefinition): string[] {
	return Object.keys(s)
		.filter((k) => !['file_name', 'last_modified', 'default'].includes(k))
		.sort((a, b) => (a === 'name' ? -1 : b === 'name' ? 1 : 0));
}

/**
 * Entity-settings adapter for a Records **type** (`/api/media-types/[typeId]`). General tab persists
 * `displayName` + `displayField` (title-by); there is no persisted group-by (it stays an ephemeral
 * header control). Fields tab drives the type schema; Danger tab deletes the type.
 */
export function typeSettingsAdapter(typeId: string): EntitySettingsAdapter {
	return {
		noun: 'record type',
		recordNoun: 'record',
		hasGroupBy: false,
		hasSubtitle: true,
		// A record type holds no blobs, so there is nothing for a compression preset to act on.
		hasCompression: false,
		load: async () => {
			const [settings, schema] = await Promise.all([
				apiGetTypeSettings(typeId),
				apiGetSchemaForType(typeId)
			]);
			return {
				displayName: settings.displayName,
				icon: settings.icon,
				titleBy: settings.displayField,
				subtitleBy: settings.subtitleField,
				groupBy: '',
				compressionPresets: [],
				fields: typeFields(schema)
			};
		},
		save: async ({ displayName, icon, titleBy, subtitleBy }) => {
			await apiUpdateTypeSettings(typeId, {
				displayName,
				icon,
				displayField: titleBy,
				subtitleField: subtitleBy
			});
		},
		schema: {
			entityKind: 'type',
			entityId: typeId,
			getSchema: () => apiGetSchemaForType(typeId),
			addField: (body) => apiAddSchemaFieldForType(typeId, body),
			updateField: (body) => apiUpdateSchemaFieldForType(typeId, body),
			deleteField: (fieldName, removeFromRecords) =>
				apiDeleteSchemaFieldForType(typeId, { fieldName, removeFromImages: removeFromRecords }),
			orderKeys: orderTypeKeys,
			reorderFields: (order) => apiReorderSchemaFieldsForType(typeId, order)
		},
		remove: async () => {
			await apiDeleteMediaType(typeId);
		}
	};
}

/**
 * Entity-settings adapter for a Posts **collection** (`/api/posts/[collection]`). General tab persists
 * `displayName`, `icon`, and `displayField` (title-by — which frontmatter field titles a post in the
 * rail); Fields tab drives the collection's frontmatter schema (add/edit/delete/**reorder**); Danger
 * tab deletes the collection. No group-by/subtitle, and no relation-link UI (posts are neither a class
 * nor a type, so `entityKind` is left unset).
 */
export function postsSettingsAdapter(collection: string): EntitySettingsAdapter {
	return {
		noun: 'collection',
		recordNoun: 'post',
		hasGroupBy: false,
		hasSubtitle: false,
		// Posts are markdown documents, not blobs — nothing here to compress.
		hasCompression: false,
		load: async () => {
			const detail = await apiGetPostCollection(collection);
			return {
				displayName: detail.displayName,
				icon: detail.icon ?? '',
				titleBy: detail.displayField ?? '',
				subtitleBy: '',
				groupBy: '',
				compressionPresets: [],
				fields: Object.keys(detail.schema).map((k) => ({ key: k, label: fieldLabel(k) }))
			};
		},
		save: async ({ displayName, icon, titleBy }) => {
			await apiUpdatePostCollection(collection, {
				displayName,
				icon,
				displayField: titleBy || ''
			});
		},
		schema: {
			getSchema: () => apiGetPostCollectionSchema(collection),
			addField: (body) => apiAddPostCollectionField(collection, body),
			updateField: (body) => apiUpdatePostCollectionField(collection, body),
			deleteField: (fieldName, removeFromRecords) =>
				apiDeletePostCollectionField(collection, fieldName, removeFromRecords),
			reorderFields: (order) => apiReorderPostCollectionSchema(collection, order)
		},
		remove: () => apiDeletePostCollection(collection)
	};
}
