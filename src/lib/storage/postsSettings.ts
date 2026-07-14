import * as fssync from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { getPostsSettingsPath } from './paths.js';
import { writeJsonFileAtomic } from './json.js';
import { SchemaDefinitionSchema, type FieldType, type SchemaDefinition } from '$lib/core/types.js';

/**
 * Legacy per-frontmatter-key typing hint for a collection (Item 14, pre-convergence).
 *
 * **Deprecated:** a collection's frontmatter fields are now a full {@link SchemaDefinition}
 * (`CollectionConfig.schema`) so the Posts sub-app reuses the **same** schema editor + settings dialog
 * as Records/classes. This shape is kept only to read + convert older `posts/settings.json` files; new
 * writes always emit `schema`. `kind` → `FieldDefinition.type`; `meta` → its options/multiselect/itemType.
 */
export interface CollectionFieldHint {
	kind: FieldType;
	meta?: {
		options?: string[];
		multiselect?: boolean;
		itemType?: string;
	};
}

/**
 * A single collection's registry entry (Item 14): display name, optional icon, the "title by" field,
 * and its frontmatter **schema** — a full {@link SchemaDefinition} identical in shape to a Records type
 * / Files class schema, so the shared schema editor drives it.
 */
export interface CollectionConfig {
	displayName?: string;
	/** Optional Lucide icon id (see `core/icons.ts`); absent ⇒ generic fallback in the rail/palette. */
	icon?: string;
	/** The schema field whose value titles each post in the rail ("title by"); absent ⇒ frontmatter `title` → slug. */
	displayField?: string;
	/** The collection's frontmatter schema (key → field definition), in manual field order. */
	schema?: SchemaDefinition;
	/** @deprecated Legacy typed hints; read + converted to {@link schema} on load, never written back. */
	fieldHints?: Record<string, CollectionFieldHint>;
}

/**
 * Convert a legacy {@link CollectionFieldHint} map into a {@link SchemaDefinition} (back-compat read).
 * Preserves key order. Each hint's `kind` becomes the field `type`; options/multiselect/itemType map
 * onto the field definition. All converted fields are `removable`.
 */
export function fieldHintsToSchema(hints: Record<string, CollectionFieldHint>): SchemaDefinition {
	const schema: SchemaDefinition = {};
	for (const [key, hint] of Object.entries(hints)) {
		const type = hint.kind;
		const canMultiselect = type === 'dropdown' || type === 'file' || type === 'record';
		schema[key] = {
			type,
			removable: true,
			...(type === 'dropdown' && hint.meta?.options?.length ? { options: hint.meta.options } : {}),
			...(canMultiselect && hint.meta?.multiselect ? { multiselect: true } : {}),
			...(type === 'list' && hint.meta?.itemType
				? { itemTypes: [hint.meta.itemType as 'string' | 'number' | 'url'] }
				: {})
		} as SchemaDefinition[string];
	}
	return schema;
}

/**
 * Resolve a collection's effective schema: its stored {@link CollectionConfig.schema}, else a
 * back-compat conversion of legacy {@link CollectionConfig.fieldHints}, else empty.
 */
export function collectionSchema(cfg: CollectionConfig | undefined): SchemaDefinition {
	if (cfg?.schema && Object.keys(cfg.schema).length) return cfg.schema;
	if (cfg?.fieldHints && Object.keys(cfg.fieldHints).length)
		return fieldHintsToSchema(cfg.fieldHints);
	return {};
}

/**
 * Posts-scoped settings, persisted in `<root>/posts/settings.json` (Item 14).
 *
 * The Posts-side mirror of `records/settings.json`: it registers every collection (the folders under
 * `posts/`) with a display name, an optional rail icon, and the per-collection frontmatter typing
 * hints. Unlike records, collections carry **no** per-folder `settings.json` — all collection metadata
 * is centralized here.
 *
 * @param collectionOrder - Ordering of collection ids in the rail (dormant analogue of `typeOrder`;
 *   preserved on write, honored by the rail when present).
 * @param collections - Per-collection config keyed by collection id (folder name).
 */
export interface PostsSettings {
	collectionOrder?: string[];
	collections?: Record<string, CollectionConfig>;
}

/** Defaults applied when `posts/settings.json` is missing or malformed. */
export const DEFAULT_POSTS_SETTINGS: PostsSettings = { collectionOrder: [], collections: {} };

function coerceHint(raw: unknown): CollectionFieldHint | null {
	if (!raw || typeof raw !== 'object') return null;
	const o = raw as Record<string, unknown>;
	if (typeof o.kind !== 'string') return null;
	const hint: CollectionFieldHint = { kind: o.kind as FieldType };
	if (o.meta && typeof o.meta === 'object') {
		const m = o.meta as Record<string, unknown>;
		hint.meta = {
			options: Array.isArray(m.options)
				? (m.options.filter((x) => typeof x === 'string') as string[])
				: undefined,
			multiselect: typeof m.multiselect === 'boolean' ? m.multiselect : undefined,
			itemType: typeof m.itemType === 'string' ? m.itemType : undefined
		};
	}
	return hint;
}

function coerceCollection(raw: unknown): CollectionConfig {
	const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const fieldHints: Record<string, CollectionFieldHint> = {};
	if (o.fieldHints && typeof o.fieldHints === 'object') {
		for (const [key, value] of Object.entries(o.fieldHints as Record<string, unknown>)) {
			const hint = coerceHint(value);
			if (hint) fieldHints[key] = hint;
		}
	}
	// Validate the schema loosely; a malformed schema degrades to undefined (falls back to hints/empty).
	let schema: SchemaDefinition | undefined;
	if (o.schema && typeof o.schema === 'object') {
		const parsed = SchemaDefinitionSchema.safeParse(o.schema);
		if (parsed.success) schema = parsed.data;
	}
	return {
		displayName: typeof o.displayName === 'string' ? o.displayName : undefined,
		icon: typeof o.icon === 'string' ? o.icon : undefined,
		displayField: typeof o.displayField === 'string' ? o.displayField : undefined,
		schema,
		fieldHints: Object.keys(fieldHints).length ? fieldHints : undefined
	};
}

function coerce(raw: Record<string, unknown>): PostsSettings {
	const collections: Record<string, CollectionConfig> = {};
	if (raw.collections && typeof raw.collections === 'object') {
		for (const [id, value] of Object.entries(raw.collections as Record<string, unknown>)) {
			collections[id] = coerceCollection(value);
		}
	}
	return {
		collectionOrder: Array.isArray(raw.collectionOrder)
			? (raw.collectionOrder.filter((x) => typeof x === 'string') as string[])
			: [],
		collections
	};
}

/**
 * Read posts-scoped settings from `<root>/posts/settings.json`, merged with defaults.
 * A missing or malformed file yields the defaults rather than throwing.
 */
export function readPostsSettings(): PostsSettings {
	try {
		const raw = JSON.parse(fssync.readFileSync(getPostsSettingsPath(), 'utf-8')) as Record<
			string,
			unknown
		>;
		return coerce(raw);
	} catch {
		return { collectionOrder: [], collections: {} };
	}
}

/**
 * Merge a partial update into `<root>/posts/settings.json` and persist atomically.
 * Unknown keys already on disk are preserved.
 *
 * @param patch - The subset of settings to change.
 * @returns The full settings object after the merge.
 */
export async function writePostsSettings(patch: Partial<PostsSettings>): Promise<PostsSettings> {
	const settingsPath = getPostsSettingsPath();
	let existing: Record<string, unknown> = {};
	try {
		existing = JSON.parse(fssync.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
	} catch {
		existing = {};
	}
	const merged = { ...existing, ...patch };
	await fs.mkdir(path.dirname(settingsPath), { recursive: true });
	await writeJsonFileAtomic(settingsPath, merged);
	return coerce(merged);
}
