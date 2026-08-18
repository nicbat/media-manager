import type { SchemaEditorAdapter } from '../schema-editor/types.js';

/**
 * General-tab configuration for an entity (a Files **class** or a Records **type**), loaded into the
 * shared {@link EntitySettingsDialog}. `fields` is the list of schema fields eligible for the
 * "title by" / "group by" selects (each side decides which keys qualify and how they're labelled).
 */
export interface EntityGeneralConfig {
	displayName: string;
	/** Persisted icon id ('' = unset → generic fallback). A curated Lucide id (see `core/icons.ts`). */
	icon: string;
	/** Persisted "title by" field key ('' = default). */
	titleBy: string;
	/** Persisted "subtitle by" field key ('' = none). Only meaningful when {@link EntitySettingsAdapter.hasSubtitle}. */
	subtitleBy: string;
	/** Persisted "group by" field key ('' = none). Only meaningful when {@link EntitySettingsAdapter.hasGroupBy}. */
	groupBy: string;
	/**
	 * Compression preset ids this entity **subscribes** to (Item 15 phase 2). Only meaningful when
	 * {@link EntitySettingsAdapter.hasCompression} (classes have blobs; record types don't).
	 *
	 * A subscription, never a setting: a blob's derivative set is the *union* of the workspace-wide
	 * subscription and every class it belongs to, so this list only ever *adds*.
	 */
	compressionPresets: string[];
	fields: { key: string; label: string }[];
}

/**
 * Injected data layer for the shared {@link EntitySettingsDialog}, so one tabbed settings popup
 * (General / Fields / Danger) drives **both** a Files class (`/api/classes/[id]`) and a Records type
 * (`/api/media-types/[typeId]`). The dialog owns no API coupling — only this adapter. Mirrors the
 * {@link SchemaEditorAdapter} pattern already used by the shared schema editor.
 *
 * @param noun - Singular label for the entity ("class" | "record type"), used in titles/buttons.
 * @param recordNoun - What a row is called in schema-editor confirmations ("image" | "record").
 * @param hasGroupBy - When true the General tab shows a persisted "group by" select (Files only;
 *   Records keeps group-by as an ephemeral header control).
 * @param hasSubtitle - When true the General tab shows a persisted "subtitle by" select (Records only;
 *   the records list rows are text-first and can carry a secondary line).
 * @param hasCompression - When true the General tab shows the **compression subscription** checkbox
 *   list (Files classes only — a record type has no blobs to compress).
 * @param load - Read current general config (name + icon + title-by + subtitle-by + group-by +
 *   compression subscription + eligible fields).
 * @param save - Persist the general config (display name, icon, title-by, subtitle-by, group-by,
 *   compression subscription). Adapters without a capability simply ignore that key.
 * @param schema - Data layer for the Fields tab (the shared {@link SchemaEditorBody}).
 * @param remove - Delete the entity.
 */
export interface EntitySettingsAdapter {
	noun: string;
	recordNoun: string;
	hasGroupBy: boolean;
	hasSubtitle: boolean;
	hasCompression: boolean;
	load: () => Promise<EntityGeneralConfig>;
	save: (patch: {
		displayName: string;
		icon: string;
		titleBy: string;
		subtitleBy: string;
		groupBy: string;
		compressionPresets: string[];
	}) => Promise<void>;
	schema: SchemaEditorAdapter;
	remove: () => Promise<void>;
}
