import { z } from 'zod';
import { ImageIdSchema } from './ids.js';
import { RESERVED_FIELD_KEYS } from './fieldKeys.js';

/**
 * Allowed schema field primitive types.
 *
 * Use case:
 * - Used by the schema editor and dynamic form rendering to decide which input control to show.
 * - Used by validation/migrations to ensure schema values are coherent.
 */
export const FieldTypeSchema = z.enum([
	'string',
	'number',
	'boolean',
	'dropdown',
	'list',
	'url',
	'file',
	'record',
	'date'
]);
export type FieldType = z.infer<typeof FieldTypeSchema>;

/**
 * URL field value: display name and URL (snake_case for stored JSON).
 *
 * Use case:
 * - Stored in records and schema defaults for fields of type `url`.
 * - Normalize legacy string values to this shape on read via normalizeUrlValue().
 */
export const UrlValueSchema = z.object({
	display_name: z.string(),
	url: z.string()
});
export type UrlValue = z.infer<typeof UrlValueSchema>;

/**
 * Normalizes a URL field value to UrlValue.
 * Legacy data may store a plain string; treat as url-only with empty display_name.
 *
 * @param value - Raw value (string or UrlValue object)
 * @returns Normalized UrlValue
 */
export function normalizeUrlValue(value: unknown): UrlValue {
	if (
		value != null &&
		typeof value === 'object' &&
		'url' in value &&
		typeof (value as UrlValue).url === 'string'
	) {
		const o = value as Record<string, unknown>;
		return {
			display_name: typeof o.display_name === 'string' ? o.display_name : '',
			url: o.url as string
		};
	}
	if (typeof value === 'string') {
		return { display_name: '', url: value };
	}
	return { display_name: '', url: '' };
}

/**
 * Allowed item types for list fields (string, number, url).
 * Used in schema to define which types of items a list field may contain.
 */
export const ListItemTypeSchema = z.enum(['string', 'number', 'url']);
export type ListItemType = z.infer<typeof ListItemTypeSchema>;

/**
 * Single list item value: string, number, or URL object.
 * Used in list field values and in record catchall.
 */
export const ListItemValueSchema = z.union([z.string(), z.number(), UrlValueSchema]);
export type ListItemValue = z.infer<typeof ListItemValueSchema>;

/**
 * Field definition stored in `schema.json`.
 *
 * Concerns / future improvements:
 * - `defaultValue` depends on `type`; if we expand types, consider a discriminated union schema.
 * - For dropdown: `options` defines the selectable values; `defaultValue` must be in options.
 * - For list: `defaultValue` is array (usually []); `itemTypes` optionally restricts allowed item types.
 * - For url: `defaultValue` may be UrlValue object or legacy string.
 */
export const FieldDefinitionSchema = z.object({
	type: FieldTypeSchema,
	removable: z.boolean(),
	defaultValue: z
		.union([
			z.string(),
			z.number(),
			z.boolean(),
			z.array(z.string()),
			z.array(ListItemValueSchema),
			UrlValueSchema
		])
		.optional(),
	options: z.array(z.string()).optional(),
	itemTypes: z.array(ListItemTypeSchema).optional(),
	/**
	 * When true, the field stores an array instead of a single value. Meaningful for `dropdown`
	 * (string[] of options), `file` (string[] of blob ids), and `record` (string[] of record ids).
	 * Omit/false = single value. Ignored for other types.
	 */
	multiselect: z.boolean().optional(),
	/**
	 * For `record` fields: the target json record type id (`records/<typeId>`) whose records this
	 * field references. The picker scopes its search to this one type; a `record` field without a
	 * `recordType` cannot resolve a target. Ignored for all other field types.
	 */
	recordType: z.string().optional(),
	/**
	 * For `file` fields: the class id (`media/classes/<id>`) whose members this field is scoped to.
	 * When set, the file picker offers only blobs that are members of that class (a hard limit — a
	 * non-member id is flagged out-of-class). Omit = any file. Ignored for all other field types.
	 */
	classId: z.string().optional(),
	/**
	 * Two-way relation link. The counterpart field *key* on the partner schema. Present on both
	 * linked fields and self-describing: on a `record` field the partner type is `recordType` and the
	 * partner field is `linkedField`; on a `file` field the partner class is `classId` and the partner
	 * field is `linkedField`. Both pointers must be set and reference each other for the pair to be
	 * "linked"; edits to either side propagate to the other. Omit = unlinked.
	 */
	linkedField: z.string().optional(),
	/**
	 * When true, the editor offers an autocomplete combobox of the distinct values already
	 * entered for this field across the class/record-type (Excel-style "Pick From Drop-down List").
	 * Free text is still allowed — suggestions are a convenience, not a constraint. Meaningful only
	 * for `string` and `list` fields with string items; ignored for other types. Omit/false = plain input.
	 */
	suggest: z.boolean().optional()
});
export type FieldDefinition = z.infer<typeof FieldDefinitionSchema>;

/**
 * Whether a field type can carry the `suggest` (autocomplete-from-existing-values) flag.
 *
 * Only free-text-ish fields qualify: a plain `string`, or a `list` whose items are strings
 * (the tags use case). A `list` defaults to string items when `itemTypes` is absent. Dropdowns
 * already are a fixed list, numbers/booleans/urls/files have no free-text column to mine — so they
 * never carry the flag, and the UI hides the toggle for them.
 *
 * @param type - The field's type.
 * @param itemTypes - For `list` fields, the allowed item types (first entry is authoritative).
 * @returns true when a `suggest` toggle is meaningful for this field.
 */
export function fieldSupportsSuggest(type: string, itemTypes?: readonly string[]): boolean {
	if (type === 'string') return true;
	if (type === 'list') return (itemTypes?.[0] ?? 'string') === 'string';
	return false;
}

/**
 * Schema definition (map of fieldKey -> field definition).
 */
export const SchemaDefinitionSchema = z.record(FieldDefinitionSchema);
export type SchemaDefinition = z.infer<typeof SchemaDefinitionSchema>;

/**
 * File-backed catalog row as stored on disk (`image-data.json` / generic `data.json`).
 *
 * Notes:
 * - `id` is the row's primary key. For file-backed kinds its value is the blob's stable,
 *   workspace-scoped identity from the global manifest (`<root>/files/manifest.json`) — i.e. the
 *   manifest key. Unlike a `json` record's `id` (unique to one record), a file-backed `id` is the
 *   **blob's** identity, so the *same* `id` appears in every catalog that references that blob. The
 *   filename is **not** stored here — it is resolved from the manifest at read time (no denormalized
 *   copy), so a rename touches only the manifest.
 * - Presence of a row means "linked"; a manifest id with no row in this catalog is "unlinked".
 *
 * Concerns / future improvements:
 * - Consider splitting system fields from user fields explicitly instead of `catchall`.
 * - When adding richer field types, revisit `catchall` union.
 */
export const ImageRecordSchema = z
	.object({
		id: ImageIdSchema,
		image_name: z.string().default(''),
		last_modified: z.string().optional(),
		width: z.number().optional(),
		height: z.number().optional(),
		_missing_files: z.record(z.string()).optional(),
		_missing_records: z.record(z.string()).optional(),
		_out_of_class: z.record(z.string()).optional()
	})
	.catchall(
		z
			.union([
				z.string(),
				z.number(),
				z.boolean(),
				z.array(ListItemValueSchema),
				UrlValueSchema,
				z.null()
			])
			.optional()
	);
export type ImageRecord = z.infer<typeof ImageRecordSchema>;

/**
 * Wrapper document for `image-data.json`.
 */
export const ImageDataFileSchema = z.object({
	images: z.array(ImageRecordSchema).default([])
});
export type ImageDataFile = z.infer<typeof ImageDataFileSchema>;

/**
 * Wrapper document for `schema.json`.
 */
export const SchemaFileSchema = z.object({
	schema: SchemaDefinitionSchema.default({})
});
export type SchemaFile = z.infer<typeof SchemaFileSchema>;

/**
 * JSON media-type record (no file attachment).
 * Stable id (UUID); last_modified optional; all other keys are schema-driven (catchall).
 *
 * Use case:
 * - Pure JSON media types (e.g. projects list) store records in data.json with this shape.
 *
 * Concerns / future improvements:
 * - Reuses ImageId for id; could introduce RecordId alias or separate type if needed.
 */
export const JsonRecordSchema = z
	.object({
		id: ImageIdSchema,
		last_modified: z.string().optional(),
		_missing_files: z.record(z.string()).optional(),
		_missing_records: z.record(z.string()).optional(),
		_out_of_class: z.record(z.string()).optional()
	})
	.catchall(
		z
			.union([
				z.string(),
				z.number(),
				z.boolean(),
				z.array(ListItemValueSchema),
				UrlValueSchema,
				z.null()
			])
			.optional()
	);
export type JsonRecord = z.infer<typeof JsonRecordSchema>;

/**
 * Wrapper document for JSON media-type data file (e.g. data.json).
 */
export const JsonDataFileSchema = z.object({
	records: z.array(JsonRecordSchema).default([])
});
export type JsonDataFile = z.infer<typeof JsonDataFileSchema>;

/**
 * Minimal JSON record info for list views.
 * Includes optional name for sidebar/grid display; when the list API is called with groupBy, each item includes group_by_value.
 */
export const JsonListItemSchema = z.object({
	id: ImageIdSchema,
	name: z.string().optional(),
	group_by_value: z
		.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()])
		.optional(),
	/**
	 * Display title for a record when the list is requested with a `titleField`. Lets the records
	 * Explorer title rows by a chosen schema field (not just `name`), so types without a `name` field
	 * no longer fall back to the raw id. Derived (not persisted); absent unless `titleField` was sent.
	 */
	title_value: z.string().optional(),
	/**
	 * Optional muted secondary line for a record row, derived from the type's persisted `subtitleField`.
	 * Absent unless a subtitle field is configured (or sent) and the record's value is non-empty.
	 */
	subtitle_value: z.string().optional(),
	/**
	 * Verbose-grid field payload (Item 8): the fields the caller requested via `?fields=`, each mapped
	 * to its stringified value (`''` when empty, so rows align tile-to-tile). Derived, not persisted;
	 * absent unless `fields` was sent. Built by `buildFieldValues`; capped at `MAX_VERBOSE_FIELDS`.
	 */
	field_values: z.record(z.string()).optional(),
	missing_file_fields: z.array(z.string()).optional(),
	/** `record`-type field keys whose referenced record id no longer resolves in the target type. */
	missing_record_fields: z.array(z.string()).optional(),
	/** `file`-type field keys whose blob exists but isn't a member of the field's `classId` scope. */
	out_of_class_fields: z.array(z.string()).optional()
});
export type JsonListItem = z.infer<typeof JsonListItemSchema>;

/**
 * API: JSON record list response (single list; no linked/unlinked/missing_files).
 */
export const JsonListResponseSchema = z.object({
	records: z.array(JsonListItemSchema).default([])
});
export type JsonListResponse = z.infer<typeof JsonListResponseSchema>;

/**
 * Lazy-heal summary returned by a list call: how many blobs the manifest gained (new files appeared on
 * disk and were minted a `file_id`) or lost (a manifest entry's blob is gone) during reconciliation.
 * The client surfaces a toast when present.
 */
export const HealSummarySchema = z.object({
	added: z.number().default(0),
	missing: z.number().default(0)
});
export type HealSummary = z.infer<typeof HealSummarySchema>;

/**
 * Per-class configuration (lives in each class file's `config`, not in `media/settings.json`).
 * `displayName` is freely renamable; the class **id** (the class filename stem) is fixed at creation.
 */
export const ClassConfigSchema = z.object({
	displayName: z.string().default(''),
	gridGroupByField: z.string().optional(),
	displayField: z.string().optional(),
	/** List sort key (Item 9): a built-in (`name` | `created_at` | `size` | `last_modified`) or a schema field key. */
	sortField: z.string().optional(),
	/** List sort direction. */
	sortDir: z.enum(['asc', 'desc']).optional(),
	/** Optional per-class icon — a curated Lucide id (see `core/icons.ts`); absent ⇒ generic fallback. */
	icon: z.string().optional(),
	/** Verbose grid (Item 8): when true the catalog tiles show `verboseFields` as key/value rows. */
	verbose: z.boolean().optional(),
	/** Verbose grid (Item 8): the class schema field keys (≤ `MAX_VERBOSE_FIELDS`) shown per tile. */
	verboseFields: z.array(z.string()).optional(),
	/**
	 * Compression preset ids this class subscribes to (Item 15 phase 2) — recipes its **members** get on
	 * top of the workspace-wide subscription.
	 *
	 * This is a subscription, not a setting: a blob's derivative set is the *union* of every class it
	 * belongs to plus the workspace default, so two classes asking for different recipes never conflict.
	 * See `presetsForBlob` in `storage/compressionSettings.ts`.
	 */
	compressionPresets: z.array(z.string()).optional()
});
export type ClassConfig = z.infer<typeof ClassConfigSchema>;

/**
 * A class file (`media/classes/<id>.json`) — the source of truth for one class: an embedded schema,
 * config, and the opt-in per-blob metadata `records`, keyed by the blob's manifest `file_id`. A class
 * with `schema: {}` is a valid pure-tag class (membership with no metadata).
 */
export const ClassFileSchema = z.object({
	schema: SchemaDefinitionSchema.default({}),
	config: ClassConfigSchema.default({ displayName: '' }),
	records: z.record(JsonRecordSchema).default({})
});
export type ClassFile = z.infer<typeof ClassFileSchema>;

/** A class row is identical in shape to a json record; its `id` is the blob's manifest id. */
export type ClassRecord = JsonRecord;

/** Summary of a class for sidebar / filter bar (member count is derived). */
export const ClassSummarySchema = z.object({
	id: z.string(),
	displayName: z.string(),
	count: z.number().default(0),
	/** Per-class icon id (see `core/icons.ts`); absent ⇒ generic fallback in the rail/header/palette. */
	icon: z.string().optional()
});
export type ClassSummary = z.infer<typeof ClassSummarySchema>;

/**
 * One blob as surfaced by the All Files grid: manifest identity + derived class membership + intrinsic
 * info. `classes` is the denormalized membership index (so the grid renders chips from one read).
 */
/**
 * A blob's compression state, flattened for the grid (Item 15 phase 2).
 *
 * Deliberately a **summary**, not the manifest's whole `derived` map: the grid needs one savings figure,
 * one quality figure and the preset names, and shipping the full per-preset detail on every row of a
 * 400-tile masonry would be pure weight. The per-file editor fetches the detail separately.
 */
export const FileCompressionSchema = z.object({
	/** Preset ids that actually produced a derivative (skipped ones are omitted). */
	presets: z.array(z.string()).default([]),
	/** Bytes saved by the **reported** preset (see `savedPreset`) — not a sum across presets, which would be meaningless. */
	savedBytes: z.number(),
	/** The same saving as a percentage of the original, 0–100. */
	savedPct: z.number(),
	/** Which preset the savings figures describe: the workspace-wide one when present, else the first generated. */
	savedPreset: z.string(),
	/**
	 * The **lowest** SSIM across this blob's generated derivatives, or null if none scored. Lowest rather
	 * than mean or primary: it answers "what is the worst thing I'm actually serving for this photo?",
	 * which is the question the flagged list exists for.
	 */
	ssim: z.number().nullable()
});
export type FileCompression = z.infer<typeof FileCompressionSchema>;

export const FileItemSchema = z.object({
	id: ImageIdSchema,
	file_name: z.string(),
	classes: z.array(z.string()).default([]),
	missing: z.boolean().default(false),
	size: z.number().optional(),
	created_at: z.string().optional(),
	width: z.number().optional(),
	height: z.number().optional(),
	/** Set only when one class is selected (the catalog view): that class's group-by value. */
	group_by_value: z
		.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()])
		.optional(),
	/**
	 * Set only in the one-class catalog view when that class has a "Title by" field (`config.displayField`)
	 * and this member has a non-empty value for it: the stringified field value the tile shows instead of
	 * the filename. Mirrors the records side's `title_value`; absent ⇒ the tile falls back to `file_name`.
	 */
	title_value: z.string().optional(),
	/** Compression summary (Item 15 phase 2); absent when the blob has no generated derivative. */
	compression: FileCompressionSchema.optional(),
	/**
	 * Verbose-grid field payload (Item 8): requested class-schema fields → stringified value (`''` when
	 * empty). Set only in the single-class catalog view when `?fields=` was sent (mirrors `title_value`'s
	 * scope). Derived, not persisted; built by `buildFieldValues`, capped at `MAX_VERBOSE_FIELDS`.
	 */
	field_values: z.record(z.string()).optional(),
	/** Broken `file`-type field references on this blob's record in the selected class. */
	missing_file_fields: z.array(z.string()).optional(),
	/** Broken `record`-type field references on this blob's record in the selected class. */
	missing_record_fields: z.array(z.string()).optional(),
	/** `file`-type field keys whose blob exists but isn't a member of the field's `classId` scope. */
	out_of_class_fields: z.array(z.string()).optional()
});
export type FileItem = z.infer<typeof FileItemSchema>;

/** API: All Files (or one-class catalog) list response. */
export const FileListResponseSchema = z.object({
	files: z.array(FileItemSchema).default([]),
	healed: HealSummarySchema.optional()
});
export type FileListResponse = z.infer<typeof FileListResponseSchema>;

const FieldKeySchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-z_][a-z0-9_]*$/, 'Field keys must be snake_case')
	.refine((k) => !RESERVED_FIELD_KEYS.has(k), 'This field name is reserved');

/**
 * API: payload for adding a new field to the schema.
 * For list fields, itemTypes defaults to ['string'] if omitted.
 */
export const AddFieldRequestSchema = z.object({
	fieldName: FieldKeySchema,
	fieldType: FieldTypeSchema,
	defaultValue: z
		.union([
			z.string(),
			z.number(),
			z.boolean(),
			z.array(z.string()),
			z.array(ListItemValueSchema),
			UrlValueSchema
		])
		.optional(),
	options: z.array(z.string()).optional(),
	itemTypes: z.array(ListItemTypeSchema).optional(),
	multiselect: z.boolean().optional(),
	recordType: z.string().optional(),
	classId: z.string().optional(),
	linkedField: z.string().optional(),
	/**
	 * How to reconcile pre-existing data when this field's two-way link is (re)declared: `'class'` =
	 * the record (class) side wins, `'type'` = the file (type) side wins. Absent ⇒ the default
	 * class→type backfill. Only meaningful when `linkedField` is set on a `record` field.
	 */
	linkSync: z.enum(['class', 'type']).optional(),
	suggest: z.boolean().optional()
});
export type AddFieldRequest = z.infer<typeof AddFieldRequestSchema>;

/**
 * API: payload for deleting an existing field from the schema.
 *
 * @param removeFromImages - When true, delete the field from all image records; otherwise only remove from schema (data becomes custom fields).
 */
export const DeleteFieldRequestSchema = z.object({
	fieldName: FieldKeySchema,
	removeFromImages: z.boolean().optional()
});
export type DeleteFieldRequest = z.infer<typeof DeleteFieldRequestSchema>;

/**
 * API: payload for updating an existing field in the schema (rename, type, default, options).
 * For list fields, itemTypes can be updated.
 */
export const UpdateFieldRequestSchema = z.object({
	fieldName: FieldKeySchema,
	newFieldName: FieldKeySchema.optional(),
	fieldType: FieldTypeSchema.optional(),
	defaultValue: z
		.union([
			z.string(),
			z.number(),
			z.boolean(),
			z.array(z.string()),
			z.array(ListItemValueSchema),
			UrlValueSchema
		])
		.optional(),
	options: z.array(z.string()).optional(),
	itemTypes: z.array(ListItemTypeSchema).optional(),
	multiselect: z.boolean().optional(),
	recordType: z.string().optional(),
	classId: z.string().optional(),
	linkedField: z.string().optional(),
	/**
	 * How to reconcile pre-existing data when this field's two-way link is (re)declared: `'class'` =
	 * the record (class) side wins, `'type'` = the file (type) side wins. Absent ⇒ the default
	 * class→type backfill. Only meaningful when `linkedField` is set on a `record` field.
	 */
	linkSync: z.enum(['class', 'type']).optional(),
	suggest: z.boolean().optional()
});
export type UpdateFieldRequest = z.infer<typeof UpdateFieldRequestSchema>;

/**
 * API: payload for reordering a schema's fields. `order` is the desired field-key order; the server
 * rewrites the schema object so its keys follow this list (keys it omits are appended, preserving
 * their prior relative order). Field definitions are moved verbatim — no def is rewritten.
 */
export const ReorderFieldsRequestSchema = z.object({
	order: z.array(z.string())
});
export type ReorderFieldsRequest = z.infer<typeof ReorderFieldsRequestSchema>;

/**
 * API: properties update payload.
 *
 * Notes:
 * - Keys are user-defined; values are primitive, array (list), url object, or null.
 * - Use null to remove a key from the record (e.g. custom field removal).
 */
export const UpdatePropertiesRequestSchema = z.record(
	z
		.union([
			z.string(),
			z.number(),
			z.boolean(),
			z.array(ListItemValueSchema),
			UrlValueSchema,
			z.null()
		])
		.optional()
);
export type UpdatePropertiesRequest = z.infer<typeof UpdatePropertiesRequestSchema>;

/**
 * API: generic success response.
 */
export const SuccessResponseSchema = z.object({
	success: z.literal(true)
});
export type SuccessResponse = z.infer<typeof SuccessResponseSchema>;
