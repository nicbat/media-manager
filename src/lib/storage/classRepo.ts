import * as fs from 'node:fs/promises';
import * as fssync from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import {
	getClassFilePath,
	getClassesDir,
	getGlobalFilesDir,
	getManifestPath,
	listClassIds
} from './paths.js';
import { readJsonFile, writeJsonFileAtomic } from './json.js';
import { withFileLock } from './lock.js';
import { assertSafeBasename } from './filenames.js';
import { normalizeFieldKey } from './migrate.js';
import { deleteDerivedForBlob, renameDerivedForBlob } from './derived.js';
import { readCompressionSettings } from './compressionSettings.js';
import {
	isProtectedSchemaKey,
	schemaUserFieldKeys,
	reorderSchemaObject
} from '$lib/core/fieldKeys.js';
import {
	buildFieldValues,
	stringifyFieldValue,
	type RecordRefRenderer
} from '$lib/core/recordDisplay.js';
import { isValidIsoDate } from '$lib/core/dates.js';
import { readImageDimensions } from '$lib/server/fileMetadata.js';
import {
	readManifest,
	reconcile,
	mintFileId,
	renameFileId as manifestRenameFileId,
	removeFileId,
	setClassMembership,
	removeClassFromIndex,
	applyMembershipIndex,
	setEntryDimensions,
	setEntrySizes,
	availableFromManifest,
	missingFileFields,
	missingFilesMap,
	outOfClassFields,
	outOfClassMap,
	getAvailableFileIds,
	readGlobalBlobNames,
	type Manifest,
	type ManifestEntry
} from './manifest.js';
import {
	resolveRecordRefs,
	recordRefRenderer,
	missingRecordFields,
	missingRecordsMap,
	schemaHasRecordField
} from './recordRefs.js';

import {
	ClassFileSchema,
	JsonRecordSchema,
	normalizeUrlValue,
	fieldSupportsSuggest,
	type ClassFile,
	type ClassSummary,
	type FileCompression,
	type FileItem,
	type FileListResponse,
	type JsonRecord,
	type SchemaDefinition
} from '$lib/core/types.js';
import { hasAllowedImageExtension } from '$lib/core/images.js';
import {
	type FilterClause,
	OPERATORS,
	VALUE_LESS_OPERATORS,
	isEmptyValue,
	recordHasEmptyField
} from '$lib/core/filters.js';
import type { FieldType } from '$lib/core/types.js';
import {
	sortItems,
	fieldSortValue,
	resolveSort,
	type SortDir,
	type RawSortValue
} from '$lib/core/sort.js';
import { readMediaSettings } from './mediaSettings.js';

/**
 * File-first class storage. A **class** is a schema + opt-in per-blob metadata stored as a single
 * source-of-truth file (`media/classes/<id>.json` = `{ schema, config, records }`), with `records`
 * keyed by the blob's manifest `file_id`. Membership is binary (member / not-member): a blob is a
 * member iff the class file has a record for its id. There is no linked/unlinked/excluded tri-state.
 *
 * The global blob store (`media/files/`) and its manifest are the primary entity; classes sit on top.
 * All Files listing is manifest-driven; a one-class listing is just the class's records as a catalog.
 */

/** Class id guard: filename-safe stem, no traversal (mirrors the API-layer regex). */
function assertSafeClassId(id: string): string {
	if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`Invalid class id: ${id}`);
	return id;
}

function classLockPath(id: string): string {
	return `${getClassFilePath(id)}.lock`;
}

/** Whether a class file exists on disk. */
export function classExists(id: string): boolean {
	return fssync.existsSync(getClassFilePath(assertSafeClassId(id)));
}

/** Read + validate a class file. Throws if the class does not exist. */
export async function readClassFile(id: string): Promise<ClassFile> {
	assertSafeClassId(id);
	const raw = await readJsonFile(getClassFilePath(id)).catch((err) => {
		const e = err as NodeJS.ErrnoException;
		if (e.code === 'ENOENT') throw new Error(`Class not found: ${id}`);
		throw err;
	});
	return ClassFileSchema.parse(raw);
}

async function writeClassFile(id: string, file: ClassFile): Promise<void> {
	await fs.mkdir(getClassesDir(), { recursive: true });
	await writeJsonFileAtomic(getClassFilePath(id), ClassFileSchema.parse(file));
}

/** Slugify a display name into a class id (fixed at creation). */
function slugify(displayName: string): string {
	return (
		displayName
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '') || 'class'
	);
}

// ---------------------------------------------------------------------------
// Class management
// ---------------------------------------------------------------------------

/** List every class with its display name and member count. */
export function listClasses(): ClassSummary[] {
	const out: ClassSummary[] = [];
	for (const id of listClassIds()) {
		try {
			const raw = JSON.parse(fssync.readFileSync(getClassFilePath(id), 'utf-8')) as {
				config?: { displayName?: string; icon?: string };
				records?: Record<string, unknown>;
			};
			out.push({
				id,
				displayName: raw.config?.displayName || id,
				count: raw.records ? Object.keys(raw.records).length : 0,
				icon: typeof raw.config?.icon === 'string' ? raw.config.icon : undefined
			});
		} catch {
			/* skip corrupt class file */
		}
	}
	return out;
}

/**
 * Create a new class. The id is the slug of `displayName`, fixed at creation; a numeric suffix is
 * appended on collision. An empty schema is allowed (a pure-tag class).
 *
 * @returns The new class id.
 */
export async function createClass(
	displayName: string,
	schema: SchemaDefinition = {}
): Promise<string> {
	let base = slugify(displayName);
	let id = base;
	let n = 1;
	while (fssync.existsSync(getClassFilePath(id))) {
		id = `${base}-${n}`;
		n++;
	}
	await writeClassFile(id, {
		schema,
		config: { displayName: displayName.trim() || id },
		records: {}
	});
	return id;
}

/** Delete a class: remove its file and strip its id from the manifest membership index. Blobs untouched. */
export async function deleteClass(id: string): Promise<void> {
	assertSafeClassId(id);
	await withFileLock(classLockPath(id), async () => {
		await fs.rm(getClassFilePath(id), { force: true });
	});
	await removeClassFromIndex(id);
}

/** Update a class's config (display name, grid prefs). */
export async function updateClassConfig(
	id: string,
	patch: Partial<ClassFile['config']>
): Promise<ClassFile['config']> {
	return await withFileLock(classLockPath(id), async () => {
		const file = await readClassFile(id);
		const config = { ...file.config, ...patch };
		await writeClassFile(id, { ...file, config });
		return config;
	});
}

// ---------------------------------------------------------------------------
// Schema editing (per class)
// ---------------------------------------------------------------------------

/** Compute the default value for a schema field definition. */
function defaultForFieldDef(def: {
	type?: string;
	defaultValue?: unknown;
	options?: string[];
	multiselect?: boolean;
}): unknown {
	if (def?.defaultValue !== undefined && def.defaultValue !== null) {
		return def.type === 'url' ? normalizeUrlValue(def.defaultValue) : def.defaultValue;
	}
	switch (def?.type) {
		case 'boolean':
			return false;
		case 'number':
			return 0;
		case 'dropdown':
			return def.multiselect ? [] : (def.options?.[0] ?? '');
		case 'list':
			return [];
		case 'url':
			return { display_name: '', url: '' };
		case 'file':
		case 'record':
			// Single ⇒ empty id string; multiselect ⇒ empty id array.
			return def.multiselect ? [] : '';
		default:
			return '';
	}
}

export async function getClassSchema(id: string): Promise<SchemaDefinition> {
	return (await readClassFile(id)).schema;
}

const SchemaFieldTypeSchema = z.enum([
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

export async function addSchemaField(
	id: string,
	fieldName: string,
	fieldType: string,
	defaultValue: unknown,
	options?: string[],
	itemTypes?: string[],
	multiselect?: boolean,
	suggest?: boolean,
	recordType?: string,
	classId?: string,
	linkedField?: string
): Promise<{ schema: SchemaDefinition }> {
	const parsedType = SchemaFieldTypeSchema.parse(fieldType);
	const key = normalizeFieldKey(fieldName);
	return await withFileLock(classLockPath(id), async () => {
		const file = await readClassFile(id);
		const def: SchemaDefinition[string] = {
			type: parsedType,
			removable: true,
			defaultValue: defaultValue as never
		};
		if (parsedType === 'dropdown' && options?.length) {
			def.options = options;
		}
		// `multiselect` is meaningful for dropdown, file, and record (array vs single value).
		if (
			multiselect &&
			(parsedType === 'dropdown' || parsedType === 'file' || parsedType === 'record')
		)
			def.multiselect = true;
		if (parsedType === 'record' && recordType) def.recordType = recordType;
		// `linkedField` declares the two-way relation counterpart (record fields are the declaration site).
		if (parsedType === 'record' && linkedField) def.linkedField = linkedField;
		// `classId` scopes a `file` field's picker to one class's members.
		if (parsedType === 'file' && classId) def.classId = classId;
		if (parsedType === 'list' && itemTypes?.length) def.itemTypes = itemTypes as never;
		if (suggest && fieldSupportsSuggest(parsedType, itemTypes)) def.suggest = true;
		const schema = { ...file.schema, [key]: def };
		const fill = defaultForFieldDef(def);
		const records = applyToRecords(file.records, (rec) =>
			rec[key] === undefined ? { ...rec, [key]: fill } : rec
		);
		await writeClassFile(id, { ...file, schema, records });
		return { schema };
	});
}

export async function updateSchemaField(
	id: string,
	oldKey: string,
	updates: {
		newKey?: string;
		type?: string;
		defaultValue?: unknown;
		options?: string[];
		itemTypes?: string[];
		multiselect?: boolean;
		suggest?: boolean;
		recordType?: string;
		classId?: string;
		linkedField?: string;
	}
): Promise<{ schema: SchemaDefinition }> {
	const key = normalizeFieldKey(oldKey);
	if (isProtectedSchemaKey(key)) throw new Error('Field not modifiable');
	return await withFileLock(classLockPath(id), async () => {
		const file = await readClassFile(id);
		const def = file.schema[key];
		if (!def) throw new Error('Field not found');

		const newKey = updates.newKey ? normalizeFieldKey(updates.newKey) : key;
		if (newKey !== key && isProtectedSchemaKey(newKey)) throw new Error('Field not modifiable');

		const type = (updates.type ? SchemaFieldTypeSchema.parse(updates.type) : def.type) as FieldType;
		const wasMultiselect = (def as { multiselect?: boolean }).multiselect === true;
		// `multiselect` is meaningful for dropdown, file, and record; forced off for every other type.
		const canMultiselect = type === 'dropdown' || type === 'file' || type === 'record';
		const multiselect = canMultiselect
			? (updates.multiselect ?? (def as { multiselect?: boolean }).multiselect ?? false)
			: false;

		let defaultValue = updates.defaultValue ?? def.defaultValue;
		if (type === 'url' && typeof defaultValue === 'string')
			defaultValue = normalizeUrlValue(defaultValue);
		if (wasMultiselect && !multiselect && Array.isArray(defaultValue)) {
			defaultValue = defaultValue[0] ?? '';
		}
		const options = updates.options ?? def.options;
		const itemTypes = updates.itemTypes ?? (def as { itemTypes?: string[] }).itemTypes;
		const recordType =
			type === 'record'
				? (updates.recordType ?? (def as { recordType?: string }).recordType)
				: undefined;
		const classId =
			type === 'file' ? (updates.classId ?? (def as { classId?: string }).classId) : undefined;
		// `linkedField` is meaningful only for record fields (the link declaration site). An explicit
		// '' clears it (unlink); undefined preserves the existing value.
		const linkedField =
			type === 'record'
				? (updates.linkedField ?? (def as { linkedField?: string }).linkedField)
				: undefined;
		const suggest =
			(updates.suggest ?? (def as { suggest?: boolean }).suggest ?? false) &&
			fieldSupportsSuggest(type, itemTypes);

		const schema = { ...file.schema };
		delete schema[key];
		schema[newKey] = {
			type,
			removable: def.removable,
			defaultValue: defaultValue as never,
			...(options?.length ? { options } : {}),
			...(type === 'list' && itemTypes?.length ? { itemTypes: itemTypes as never } : {}),
			...(multiselect ? { multiselect: true } : {}),
			...(recordType ? { recordType } : {}),
			...(linkedField ? { linkedField } : {}),
			...(classId ? { classId } : {}),
			...(suggest ? { suggest: true } : {})
		};

		let records = file.records;
		if (newKey !== key) {
			records = applyToRecords(records, (rec) => {
				if (!(key in rec)) return rec;
				const next = { ...rec, [newKey]: rec[key] };
				delete next[key];
				return next;
			});
		}
		// Convert stored values when the cardinality flips (array ⇄ single), independent of rename.
		if (wasMultiselect && !multiselect) {
			records = applyToRecords(records, (rec) => {
				const v = rec[newKey];
				return Array.isArray(v) ? { ...rec, [newKey]: v[0] ?? '' } : rec;
			});
		} else if (!wasMultiselect && multiselect) {
			records = applyToRecords(records, (rec) => {
				const v = rec[newKey];
				if (v === undefined || Array.isArray(v)) return rec;
				return { ...rec, [newKey]: v === '' || v == null ? [] : [v] };
			});
		}
		await writeClassFile(id, { ...file, schema, records });
		return { schema };
	});
}

export async function deleteSchemaField(
	id: string,
	fieldName: string,
	removeFromRecords?: boolean
): Promise<{ schema: SchemaDefinition }> {
	const key = normalizeFieldKey(fieldName);
	if (isProtectedSchemaKey(key)) throw new Error('Field not removable');
	return await withFileLock(classLockPath(id), async () => {
		const file = await readClassFile(id);
		const def = file.schema[key];
		if (!def) throw new Error('Field not found');
		if (def.removable === false) throw new Error('Field not removable');
		const schema = { ...file.schema };
		delete schema[key];
		const records = removeFromRecords
			? applyToRecords(file.records, (rec) => {
					const next = { ...rec };
					delete next[key];
					return next;
				})
			: file.records;
		await writeClassFile(id, { ...file, schema, records });
		return { schema };
	});
}

/** Replace a class's entire schema, backfilling defaults into existing records. */
export async function importSchema(
	id: string,
	schema: SchemaDefinition
): Promise<{ schema: SchemaDefinition }> {
	return await withFileLock(classLockPath(id), async () => {
		const file = await readClassFile(id);
		const records = applyToRecords(file.records, (rec) => {
			const next = { ...rec };
			let changed = false;
			for (const [k, def] of Object.entries(schema)) {
				if (next[k] === undefined) {
					next[k] = defaultForFieldDef(def) as never;
					changed = true;
				}
			}
			return changed ? next : rec;
		});
		await writeClassFile(id, { ...file, schema, records });
		return { schema };
	});
}

/**
 * Reorder this class's schema fields. Rewrites the schema object so its keys follow `orderedKeys`;
 * any existing keys not listed are appended afterwards (preserving their prior relative order), and
 * keys in `orderedKeys` that don't exist are ignored. Field definitions are moved verbatim — nothing
 * else changes, and records are untouched (their key order is irrelevant).
 *
 * @param id - Class id.
 * @param orderedKeys - Desired field-key order (a subset/superset is tolerated).
 * @returns The reordered schema.
 */
export async function reorderSchemaFields(
	id: string,
	orderedKeys: string[]
): Promise<{ schema: SchemaDefinition }> {
	return await withFileLock(classLockPath(id), async () => {
		const file = await readClassFile(id);
		const schema = reorderSchemaObject(file.schema, orderedKeys);
		await writeClassFile(id, { ...file, schema });
		return { schema };
	});
}

/** Map over a records object, preserving identity when unchanged. */
function applyToRecords(
	records: Record<string, JsonRecord>,
	fn: (rec: Record<string, unknown>) => Record<string, unknown>
): Record<string, JsonRecord> {
	const out: Record<string, JsonRecord> = {};
	for (const [fileId, rec] of Object.entries(records)) {
		out[fileId] = JsonRecordSchema.parse(fn(rec as Record<string, unknown>));
	}
	return out;
}

// ---------------------------------------------------------------------------
// Membership + per-record metadata
// ---------------------------------------------------------------------------

/** Build a blank record (schema defaults) for a newly-added member. */
function blankRecord(fileId: string, schema: SchemaDefinition): JsonRecord {
	const rec: Record<string, unknown> = { id: fileId, last_modified: new Date().toISOString() };
	for (const [key, def] of Object.entries(schema)) {
		if (key === 'id' || key === 'last_modified') continue;
		rec[key] = defaultForFieldDef(def);
	}
	return JsonRecordSchema.parse(rec);
}

/**
 * Add blobs to a class, creating empty member records (fields filled later inline). Existing members
 * are left untouched. Updates the manifest membership index.
 *
 * @returns The created/existing records.
 */
export async function addMembers(id: string, fileIds: string[]): Promise<JsonRecord[]> {
	const result = await withFileLock(classLockPath(id), async () => {
		const file = await readClassFile(id);
		const records = { ...file.records };
		const added: string[] = [];
		const out: JsonRecord[] = [];
		for (const fileId of fileIds) {
			if (records[fileId]) {
				out.push(records[fileId]);
				continue;
			}
			const rec = blankRecord(fileId, file.schema);
			records[fileId] = rec;
			added.push(fileId);
			out.push(rec);
		}
		if (added.length) await writeClassFile(id, { ...file, records });
		return { added, out };
	});
	for (const fileId of result.added) await setClassMembership(fileId, id, true);
	return result.out;
}

/** Remove blobs from a class (drops their member records). Updates the manifest membership index. */
export async function removeMembers(id: string, fileIds: string[]): Promise<void> {
	const removed = await withFileLock(classLockPath(id), async () => {
		const file = await readClassFile(id);
		const records = { ...file.records };
		const removed: string[] = [];
		for (const fileId of fileIds) {
			if (records[fileId]) {
				delete records[fileId];
				removed.push(fileId);
			}
		}
		if (removed.length) await writeClassFile(id, { ...file, records });
		return removed;
	});
	for (const fileId of removed) await setClassMembership(fileId, id, false);
}

/**
 * Get one blob's record in a class (null if not a member), with url fields normalized, the resolved
 * `file_name` attached, and `_missing_files` annotated for broken `file`-field references.
 */
export async function getRecord(id: string, fileId: string): Promise<JsonRecord | null> {
	const file = await readClassFile(id);
	const rec = file.records[fileId];
	if (!rec) return null;
	const { manifest, available } = await getAvailableFileIds();
	const out = { ...(rec as Record<string, unknown>) };
	out.file_name = manifest.files[fileId]?.file_name ?? '';
	for (const [key, def] of Object.entries(file.schema)) {
		if (def?.type === 'url' && key in out && out[key] != null)
			out[key] = normalizeUrlValue(out[key]);
	}
	const missing = missingFilesMap(out, file.schema, manifest, available);
	if (missing) out._missing_files = missing;
	const outOfClass = outOfClassMap(out, file.schema, manifest);
	if (outOfClass) out._out_of_class = outOfClass;
	if (schemaHasRecordField(file.schema)) {
		const resolver = await resolveRecordRefs(file.schema);
		const missingRecords = missingRecordsMap(out, file.schema, resolver);
		if (missingRecords) out._missing_records = missingRecords;
	}
	return out as JsonRecord;
}

/** Update a member's metadata fields (schema-defined keys only; null removes orphan keys). */
export async function updateRecord(
	id: string,
	fileId: string,
	patch: Record<string, unknown>
): Promise<JsonRecord> {
	return await withFileLock(classLockPath(id), async () => {
		const file = await readClassFile(id);
		const rec = file.records[fileId];
		if (!rec) throw new Error('Not a member of this class');
		const allowed = new Set(Object.keys(file.schema));
		allowed.delete('id');
		allowed.delete('last_modified');
		const next: Record<string, unknown> = { ...(rec as Record<string, unknown>) };
		for (const [k, v] of Object.entries(patch)) {
			if (allowed.has(k)) next[k] = v;
			else if (k in next && k !== 'id' && k !== 'last_modified' && v === null) delete next[k];
		}
		next.last_modified = new Date().toISOString();
		const parsed = JsonRecordSchema.parse(next);
		await writeClassFile(id, { ...file, records: { ...file.records, [fileId]: parsed } });
		return parsed;
	});
}

/** Unique non-empty values for a field across a class's members (for filter/dropdown suggestions). */
export async function getUniqueFieldValues(id: string, fieldName: string): Promise<string[]> {
	const file = await readClassFile(id);
	const seen = new Set<string>();
	const itemToStr = (item: unknown): string => {
		if (item != null && typeof item === 'object' && 'url' in (item as object)) {
			const o = item as { display_name?: string; url?: string };
			return (o.display_name ?? '').trim() || (o.url ?? '').trim();
		}
		return String(item).trim();
	};
	for (const rec of Object.values(file.records)) {
		const v = (rec as Record<string, unknown>)[fieldName];
		if (v === undefined || v === null) continue;
		if (Array.isArray(v)) {
			for (const item of v) {
				const s = itemToStr(item);
				if (s) seen.add(s);
			}
		} else if (typeof v === 'string' && v.trim()) seen.add(v.trim());
		else if (v != null && typeof v === 'object' && 'url' in v) {
			const s = itemToStr(v);
			if (s) seen.add(s);
		} else if (typeof v === 'number' && !Number.isNaN(v)) seen.add(String(v));
	}
	return [...seen].sort();
}

// ---------------------------------------------------------------------------
// Filtering (shared with the one-class catalog view)
// ---------------------------------------------------------------------------

function getFieldType(schema: SchemaDefinition, fieldKey: string): FieldType {
	return (schema[fieldKey]?.type as FieldType) ?? 'string';
}

function evaluateClause(
	rec: Record<string, unknown>,
	clause: FilterClause,
	schema: SchemaDefinition
): boolean {
	const { field, operator, value } = clause;
	const raw = rec[field];
	const fieldType = getFieldType(schema, field);

	if (operator === OPERATORS.is_empty) return isEmptyValue(raw);
	if (operator === OPERATORS.is_not_empty) return !isEmptyValue(raw);
	if (!VALUE_LESS_OPERATORS.has(operator) && value === undefined) return false;

	if (fieldType === 'number') {
		const num = typeof raw === 'number' && !Number.isNaN(raw) ? raw : Number(raw);
		const filterNum = typeof value === 'number' ? value : Number(value);
		if (Number.isNaN(num)) return false;
		if (Number.isNaN(filterNum) && operator !== OPERATORS.equals) return false;
		switch (operator) {
			case OPERATORS.equals:
				return num === filterNum;
			case OPERATORS.less_than:
				return num < filterNum;
			case OPERATORS.less_than_or_equal:
				return num <= filterNum;
			case OPERATORS.greater_than:
				return num > filterNum;
			case OPERATORS.greater_than_or_equal:
				return num >= filterNum;
			default:
				return false;
		}
	}
	if (fieldType === 'list') {
		const arr = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
		const strVal = String(value ?? '').toLowerCase();
		const itemToStr = (item: unknown): string => {
			if (item != null && typeof item === 'object' && 'url' in (item as object)) {
				const o = item as { display_name?: string; url?: string };
				return (o.display_name ?? '') || (o.url ?? '');
			}
			return String(item);
		};
		switch (operator) {
			case OPERATORS.contains:
				return arr.some((item) => itemToStr(item).toLowerCase() === strVal);
			case OPERATORS.does_not_contain:
				return !arr.some((item) => itemToStr(item).toLowerCase() === strVal);
			default:
				return false;
		}
	}
	if (fieldType === 'boolean') {
		const bool = raw === true || raw === 'true';
		const target = value === true || value === 'true';
		return operator === OPERATORS.equals ? bool === target : false;
	}
	if (fieldType === 'date') {
		// Date-only ISO strings (`YYYY-MM-DD`) compare chronologically as plain strings; empty/invalid
		// matches nothing (is_empty/is_not_empty handled above). Mirrors jsonRepo.evaluateClause.
		const d = isValidIsoDate(raw) ? raw : '';
		const f = value != null ? String(value) : '';
		if (!d) return false;
		switch (operator) {
			case OPERATORS.equals:
				return d === f;
			case OPERATORS.less_than:
				return d < f;
			case OPERATORS.less_than_or_equal:
				return d <= f;
			case OPERATORS.greater_than:
				return d > f;
			case OPERATORS.greater_than_or_equal:
				return d >= f;
			default:
				return false;
		}
	}
	if (fieldType === 'url') {
		const urlVal = normalizeUrlValue(raw);
		const str = (urlVal.display_name + ' ' + urlVal.url).trim().toLowerCase();
		const filterStr = value != null ? String(value).toLowerCase() : '';
		switch (operator) {
			case OPERATORS.equals:
				return str === filterStr;
			case OPERATORS.contains:
				return str.includes(filterStr);
			case OPERATORS.starts_with:
				return str.startsWith(filterStr);
			case OPERATORS.ends_with:
				return str.endsWith(filterStr);
			default:
				return false;
		}
	}
	if (fieldType === 'dropdown') {
		const def = schema[field];
		if (def && (def as { multiselect?: boolean }).multiselect && Array.isArray(raw)) {
			const filterStr = value != null ? String(value) : '';
			const arr = raw as string[];
			switch (operator) {
				case OPERATORS.equals:
					return arr.includes(filterStr);
				case OPERATORS.contains:
					return arr.some((s) => s.toLowerCase().includes(filterStr.toLowerCase()));
				case OPERATORS.starts_with:
					return arr.some((s) => s.toLowerCase().startsWith(filterStr.toLowerCase()));
				case OPERATORS.ends_with:
					return arr.some((s) => s.toLowerCase().endsWith(filterStr.toLowerCase()));
				default:
					return false;
			}
		}
	}
	const str = raw != null ? String(raw).toLowerCase() : '';
	const filterStr = value != null ? String(value).toLowerCase() : '';
	switch (operator) {
		case OPERATORS.equals:
			return str === filterStr;
		case OPERATORS.contains:
			return str.includes(filterStr);
		case OPERATORS.starts_with:
			return str.startsWith(filterStr);
		case OPERATORS.ends_with:
			return str.endsWith(filterStr);
		default:
			return false;
	}
}

function groupByValue(
	rec: Record<string, unknown>,
	schema: SchemaDefinition,
	groupBy: string,
	resolveRef?: RecordRefRenderer
): string | number | boolean | string[] | null {
	const val = rec[groupBy];
	const def = schema[groupBy];
	if (val === undefined || val === null) return null;
	if (def?.type === 'record') {
		// Group by the referenced record's title(s) rather than the raw id; fall back to the id when no
		// cross-type resolver is supplied.
		const resolved = resolveRef?.(groupBy, val);
		if (resolved !== undefined) return resolved;
		return Array.isArray(val) ? (val as string[]).join(', ') : String(val);
	}
	if (def?.type === 'url') {
		const urlVal = normalizeUrlValue(val);
		return (urlVal.display_name ?? '').trim() || urlVal.url || '';
	}
	if (def?.type === 'list' && Array.isArray(val)) {
		return val
			.map((item: unknown) =>
				item != null && typeof item === 'object' && 'url' in (item as object)
					? ((item as { display_name?: string; url?: string }).display_name ?? '').trim() ||
						(item as { url: string }).url ||
						''
					: String(item)
			)
			.join(', ');
	}
	if (
		def?.type === 'dropdown' &&
		(def as { multiselect?: boolean }).multiselect &&
		Array.isArray(val)
	) {
		return (val as string[]).join(', ');
	}
	return val as string | number | boolean | string[];
}

/**
 * Lowercased searchable text for one field of a class record, reusing {@link groupByValue} so
 * url/list/dropdown values are matched the same way they group/render. Empty string when absent.
 */
function fieldSearchText(
	rec: Record<string, unknown>,
	schema: SchemaDefinition,
	field: string
): string {
	const v = groupByValue(rec, schema, field);
	if (v == null) return '';
	return (Array.isArray(v) ? v.join(', ') : String(v)).toLowerCase();
}

// ---------------------------------------------------------------------------
// Reconcile + dimension backfill helpers (shared by both listings)
// ---------------------------------------------------------------------------

/** Reconcile the manifest against disk and resync the membership index if any class file is stale. */
async function reconcileAndResync(): Promise<{
	manifest: Manifest;
	diskNames: Set<string>;
	healed: { added: number; missing: number };
}> {
	const diskNames = await readGlobalBlobNames();
	const { added, missing, manifest } = await reconcile(diskNames);

	// mtime-gated resync: if any class file is newer than the manifest, rebuild membership from classes.
	let resynced = manifest;
	let manifestMtime = 0;
	try {
		manifestMtime = fssync.statSync(getManifestPath()).mtimeMs;
	} catch {
		/* manifest not written yet → treat everything as stale */
	}
	let stale = false;
	for (const cid of listClassIds()) {
		try {
			if (fssync.statSync(getClassFilePath(cid)).mtimeMs > manifestMtime) {
				stale = true;
				break;
			}
		} catch {
			/* ignore */
		}
	}
	if (stale) {
		const membership = new Map<string, Set<string>>();
		for (const cid of listClassIds()) {
			try {
				const raw = JSON.parse(fssync.readFileSync(getClassFilePath(cid), 'utf-8')) as {
					records?: Record<string, unknown>;
				};
				for (const fileId of Object.keys(raw.records ?? {})) {
					if (!membership.has(fileId)) membership.set(fileId, new Set());
					membership.get(fileId)!.add(cid);
				}
			} catch {
				/* skip */
			}
		}
		resynced = await applyMembershipIndex(membership);
	}

	return {
		manifest: resynced,
		diskNames: new Set(diskNames),
		healed: { added: added.length, missing: missing.length }
	};
}

/** Backfill intrinsic image dimensions into the manifest for on-disk image blobs lacking them. */
async function backfillDimensions(manifest: Manifest, diskNames: Set<string>): Promise<void> {
	const filesDir = getGlobalFilesDir();
	const dims = new Map<string, { width?: number; height?: number }>();
	for (const [id, entry] of Object.entries(manifest.files)) {
		if (entry.width != null || entry.height != null) continue;
		if (!diskNames.has(entry.file_name)) continue;
		if (!hasAllowedImageExtension(entry.file_name)) continue;
		try {
			const d = await readImageDimensions(path.join(filesDir, entry.file_name));
			if (d.width != null || d.height != null) {
				dims.set(id, d);
				entry.width = d.width;
				entry.height = d.height;
			}
		} catch {
			/* skip */
		}
	}
	await setEntryDimensions(dims);
}

/**
 * Backfill byte sizes into the manifest for on-disk blobs lacking them — the size twin of
 * {@link backfillDimensions}, and lazy for the same reason (only entries with no `size` are stat'ed, so
 * steady state costs nothing).
 *
 * `size` was historically written **only at mint**, so every blob adopted by {@link reconcile} — anything
 * hand-dropped into the blob dir — had none. That is visible today as an empty `file:size` cell in the
 * verbose grid, and it is load-bearing for compression (Item 15): the savings headline sums original
 * bytes, and `derived.source_size` is compared against this to notice a re-uploaded original.
 *
 * @param manifest - The reconciled manifest (mutated in place so the caller's projection sees the sizes).
 * @param diskNames - Basenames currently present in the blob dir.
 */
async function backfillSizes(manifest: Manifest, diskNames: Set<string>): Promise<void> {
	const filesDir = getGlobalFilesDir();
	const sizes = new Map<string, number>();
	for (const [id, entry] of Object.entries(manifest.files)) {
		if (entry.size != null) continue;
		if (!diskNames.has(entry.file_name)) continue;
		try {
			const stat = await fs.stat(path.join(filesDir, entry.file_name));
			sizes.set(id, stat.size);
			entry.size = stat.size;
		} catch {
			/* skip */
		}
	}
	await setEntrySizes(sizes);
}

/**
 * Flatten a blob's `derived` map into the grid's compression summary (Item 15 phase 2).
 *
 * @param entry - The manifest entry.
 * @param primaryPresetId - The workspace-wide preset, whose savings are the headline figure.
 * @returns The summary, or undefined when nothing was generated (so the row stays compact).
 */
function fileCompressionSummary(
	entry: ManifestEntry | undefined,
	primaryPresetId: string | undefined
): FileCompression | undefined {
	const derived = entry?.derived;
	if (!derived) return undefined;
	const generated = Object.entries(derived).filter(([, d]) => d.file_name && !d.skipped);
	if (generated.length === 0) return undefined;

	// Report savings against the workspace-wide preset when it's there, so the number means the same
	// thing on every row; fall back to the first generated preset for a blob that only a class subscribes.
	const chosen = generated.find(([presetId]) => presetId === primaryPresetId) ?? generated[0];
	const [savedPreset, d] = chosen;
	const source = d.source_size ?? entry?.size ?? 0;
	const savedBytes = Math.max(0, source - (d.size ?? 0));

	const scores = generated.map(([, x]) => x.ssim).filter((v): v is number => v != null);

	return {
		presets: generated.map(([presetId]) => presetId),
		savedBytes,
		savedPct: source > 0 ? Math.round((savedBytes / source) * 1000) / 10 : 0,
		savedPreset,
		// Lowest, not mean: "what is the worst thing I'm serving for this photo?".
		ssim: scores.length > 0 ? Math.min(...scores) : null
	};
}

function fileItemFromEntry(id: string, manifest: Manifest, primaryPresetId?: string): FileItem {
	const e = manifest.files[id];
	return {
		id,
		file_name: e?.file_name ?? '',
		classes: e?.classes ?? [],
		missing: e?.missing ?? false,
		size: e?.size,
		created_at: e?.created_at,
		width: e?.width,
		height: e?.height,
		compression: fileCompressionSummary(e, primaryPresetId)
	};
}

/** The workspace-wide preset id, whose savings the grid reports per row. */
function primaryPresetId(): string | undefined {
	return readCompressionSettings().workspacePresets[0];
}

/**
 * Built-in (intrinsic, class-agnostic) sort keys offered on every file listing (Item 9).
 * `saved`/`quality` are the compression pair (Item 15 phase 2).
 */
const FILE_SORT_KEYS = new Set<string>(['name', 'created_at', 'size', 'saved', 'quality']);

/** Read a built-in blob sort value off a {@link FileItem}. `name` ⇒ filename; else the intrinsic field. */
function fileBuiltinSortValue(f: FileItem, key: string): RawSortValue {
	if (key === 'name') return f.file_name;
	if (key === 'created_at') return f.created_at ?? null;
	if (key === 'size') return f.size ?? null;
	// Uncompressed blobs sort as empty rather than 0, so the shared comparator puts them last instead of
	// mixing them in with genuinely zero-saving files.
	if (key === 'saved') return f.compression?.savedBytes ?? null;
	if (key === 'quality') return f.compression?.ssim ?? null;
	return null;
}

// ---------------------------------------------------------------------------
// All Files listing (manifest-driven)
// ---------------------------------------------------------------------------

/**
 * The Files hub home: every blob in the store, with derived class chips. Supports a filename search,
 * class filter (`classIds`, ANY/ALL), and the lone built-in `unclassified` pseudo-filter.
 */
export async function listAllFiles(params?: {
	query?: string | null;
	classIds?: string[] | null;
	matchAll?: boolean;
	unclassified?: boolean;
	/**
	 * Group the result by one class's field (the multi-class "all of" view): each item gets a
	 * `group_by_value` read from that class's record. The field is qualified by class so callers can
	 * disambiguate same-named fields across the intersected classes.
	 */
	groupBy?: { classId: string; field: string } | null;
	/**
	 * Scope {@link query}. Encodings:
	 * - `null`/empty in a plain All-Files / "any of" view → **filename only**.
	 * - `null`/empty in an intersection ("all of", 2+ classes) → **All fields**: filename + every user
	 *   field of every intersected class.
	 * - `"<classId>::<field>"` → one specific field of one intersected class (mirrors the cross
	 *   group-by encoding).
	 */
	searchField?: string | null;
	/**
	 * Sort key (Item 9): a built-in (`name` | `created_at` | `size`). Falls back to the persisted
	 * media-wide `sortField`, then the default `created_at` (no per-record context on the hub).
	 */
	sortField?: string | null;
	/** Sort direction; falls back to the persisted `sortDir`, then `desc` (newest first). */
	sortDir?: SortDir | null;
}): Promise<FileListResponse> {
	const { manifest, diskNames, healed } = await reconcileAndResync();
	await backfillDimensions(manifest, diskNames);
	await backfillSizes(manifest, diskNames);
	const primaryPreset = primaryPresetId();

	const q = params?.query ? params.query.toLowerCase() : null;
	const classIds = params?.classIds ?? null;
	const matchAll = params?.matchAll ?? false;
	const unclassified = params?.unclassified ?? false;
	const groupBy = params?.groupBy ?? null;
	const searchField = params?.searchField || null;
	const crossMode = matchAll && !unclassified && !!classIds && classIds.length > 1;

	// Load the group-by class once so we can read each member's field value (best-effort). When the
	// group-by field is a `record` reference, build a cross-type resolver so the group key is the
	// referenced record's title rather than its raw id.
	let groupByClassFile: ClassFile | null = null;
	let groupByResolveRef: RecordRefRenderer | undefined;
	if (groupBy) {
		try {
			groupByClassFile = await readClassFile(groupBy.classId);
			if (groupByClassFile && schemaHasRecordField(groupByClassFile.schema)) {
				const refResolver = await resolveRecordRefs(groupByClassFile.schema);
				groupByResolveRef = recordRefRenderer(groupByClassFile.schema, refResolver);
			}
		} catch {
			groupByClassFile = null;
		}
	}

	// Load the class file(s) needed to evaluate a field-scoped search (intersection only). A specific
	// `classId::field` loads that one class; an All-fields search in cross mode loads every intersected
	// class. Outside an intersection there is no single field context, so search stays filename-only.
	const [sfClassId, sfField] =
		searchField && searchField.includes('::') ? searchField.split('::') : [null, null];
	const searchClassFiles: { schema: SchemaDefinition; records: Record<string, unknown> }[] = [];
	if (q) {
		const idsToLoad = sfClassId ? [sfClassId] : crossMode ? (classIds ?? []) : [];
		for (const cid of idsToLoad) {
			const cf = await readClassFile(cid).catch(() => null);
			if (cf)
				searchClassFiles.push({
					schema: cf.schema,
					records: cf.records as Record<string, unknown>
				});
		}
	}

	/** Whether a blob matches the active text query given the (possibly field-scoped) search mode. */
	const matchesSearch = (id: string, fileName: string): boolean => {
		if (!q) return true;
		if (sfField) {
			const cf = searchClassFiles[0];
			if (!cf) return false;
			const rec = (cf.records[id] ?? {}) as Record<string, unknown>;
			return fieldSearchText(rec, cf.schema, sfField).includes(q);
		}
		if (searchClassFiles.length > 0) {
			// All-fields (intersection): filename or any user field of any intersected class.
			if (fileName.toLowerCase().includes(q)) return true;
			return searchClassFiles.some((cf) => {
				const rec = (cf.records[id] ?? {}) as Record<string, unknown>;
				return schemaUserFieldKeys(cf.schema).some((k) =>
					fieldSearchText(rec, cf.schema, k).includes(q)
				);
			});
		}
		return fileName.toLowerCase().includes(q); // filename only
	};

	const files: FileItem[] = [];
	for (const [id, entry] of Object.entries(manifest.files)) {
		if (!diskNames.has(entry.file_name)) continue; // hide blobs missing from disk in the grid
		if (unclassified) {
			if (entry.classes.length > 0) continue;
		} else if (classIds && classIds.length > 0) {
			const has = matchAll
				? classIds.every((c) => entry.classes.includes(c))
				: classIds.some((c) => entry.classes.includes(c));
			if (!has) continue;
		}
		if (!matchesSearch(id, entry.file_name)) continue;
		const item = fileItemFromEntry(id, manifest, primaryPreset);
		if (groupByClassFile) {
			const rec = (groupByClassFile.records[id] ?? {}) as Record<string, unknown>;
			item.group_by_value = groupByValue(
				rec,
				groupByClassFile.schema,
				groupBy!.field,
				groupByResolveRef
			);
		}
		files.push(item);
	}
	// Sort (Item 9). The hub has no per-record context, so only intrinsic blob keys are offered; default
	// is created_at desc (newest first). Precedence: explicit param → persisted media setting → default.
	const mediaSettings = readMediaSettings();
	const { field: sortField, dir: sortDir } = resolveSort(
		params?.sortField ?? mediaSettings.sortField,
		params?.sortDir ?? mediaSettings.sortDir,
		FILE_SORT_KEYS,
		{ field: 'created_at', dir: 'desc' }
	);
	const sorted = sortItems(files, sortDir, {
		value: (f) => fileBuiltinSortValue(f, sortField),
		id: (f) => f.id
	});
	return { files: sorted, healed };
}

/**
 * The one-class catalog view: every member of a class as a {@link FileItem}, with the class's group-by
 * value, filename search, schema filters, and broken `file`-field annotations.
 */
export async function listClassMembers(
	id: string,
	params?: {
		query?: string | null;
		groupBy?: string | null;
		filters?: FilterClause[] | null;
		/**
		 * Scope {@link query} to one field key. `null`/empty = **All fields** (filename + every user
		 * field). A field key restricts the match to that class field only.
		 */
		searchField?: string | null;
		/**
		 * Sort key (Item 9): a built-in (`name` | `created_at` | `size` | `last_modified`) or a class
		 * schema field key. Falls back to the class's persisted `sortField`, then `last_modified` desc.
		 */
		sortField?: string | null;
		/** Sort direction; falls back to the class's persisted `sortDir`, then `desc`. */
		sortDir?: SortDir | null;
		/**
		 * Incomplete filter (Item 10): when true, keep only members with **at least one empty field**
		 * among the class's user fields ({@link schemaUserFieldKeys}). ANDs with `filters`/`query`.
		 */
		incomplete?: boolean | null;
		/**
		 * Verbose-grid field set (Item 8): class schema field keys whose values to inline on each member
		 * as `field_values`. Empty/nullish ⇒ compact rows. Capped at `MAX_VERBOSE_FIELDS`.
		 */
		fields?: string[] | null;
	}
): Promise<FileListResponse> {
	const file = await readClassFile(id);
	const { manifest, diskNames, healed } = await reconcileAndResync();
	await backfillDimensions(manifest, diskNames);
	await backfillSizes(manifest, diskNames);
	const primaryPreset = primaryPresetId();
	const available = availableFromManifest(manifest, diskNames);

	const groupBy = params?.groupBy ?? null;
	const filters = params?.filters ?? null;
	const q = params?.query ? params.query.toLowerCase() : null;
	const searchField = params?.searchField || null;
	const incomplete = params?.incomplete ?? false;
	const incompleteKeys = incomplete ? schemaUserFieldKeys(file.schema) : [];
	// "Title by" (Item: class title-by parity with records): the persisted `config.displayField` names a
	// schema field whose value labels each tile in place of the filename. Resolved server-side into
	// `title_value` so the grid renders it the same way the records list trusts `title_value` first.
	const titleField = file.config.displayField || null;
	// Resolve cross-type `record` references (target titles + missing-ref detection) once per list.
	const refResolver = schemaHasRecordField(file.schema)
		? await resolveRecordRefs(file.schema)
		: null;
	const resolveRef = refResolver ? recordRefRenderer(file.schema, refResolver) : undefined;

	const files: FileItem[] = [];
	// Keep each kept blob's class record around so the sort can read its `last_modified` + schema fields
	// (the `FileItem` carries only intrinsic blob data).
	const recById = new Map<string, Record<string, unknown>>();
	for (const [fileId, rec] of Object.entries(file.records)) {
		const entry = manifest.files[fileId];
		const fileName = entry?.file_name ?? '';
		const recObj = rec as Record<string, unknown>;
		if (q) {
			const match = searchField
				? fieldSearchText(recObj, file.schema, searchField).includes(q)
				: fileName.toLowerCase().includes(q) ||
					schemaUserFieldKeys(file.schema).some((k) =>
						fieldSearchText(recObj, file.schema, k).includes(q)
					);
			if (!match) continue;
		}
		if (filters && filters.length > 0) {
			if (!filters.every((c) => evaluateClause(recObj, c, file.schema))) continue;
		}
		// Incomplete filter (Item 10): drop members where every class field has a value.
		if (incomplete && !recordHasEmptyField(recObj, incompleteKeys)) continue;
		const item = fileItemFromEntry(fileId, manifest, primaryPreset);
		if (groupBy) item.group_by_value = groupByValue(recObj, file.schema, groupBy, resolveRef);
		if (titleField) {
			const tv = stringifyFieldValue(file.schema, titleField, recObj[titleField], resolveRef);
			if (tv !== undefined && tv !== '') item.title_value = tv;
		}
		const fv = buildFieldValues(file.schema, recObj, params?.fields, resolveRef);
		if (fv) item.field_values = fv;
		const miss = missingFileFields(recObj, file.schema, available);
		if (miss.length) item.missing_file_fields = miss;
		const ooc = outOfClassFields(recObj, file.schema, manifest);
		if (ooc.length) item.out_of_class_fields = ooc;
		if (refResolver) {
			const missRec = missingRecordFields(recObj, file.schema, refResolver);
			if (missRec.length) item.missing_record_fields = missRec;
		}
		recById.set(fileId, recObj);
		files.push(item);
	}
	// Sort (Item 9). Built-in blob keys come off the FileItem; `last_modified` + schema fields come off
	// the class record. Default is last_modified desc. Precedence: param → class config → default.
	const { field: sortField, dir: sortDir } = resolveSort(
		params?.sortField ?? file.config.sortField,
		params?.sortDir ?? file.config.sortDir,
		new Set<string>([...FILE_SORT_KEYS, 'last_modified', ...schemaUserFieldKeys(file.schema)]),
		{ field: 'last_modified', dir: 'desc' }
	);
	const sorted = sortItems(files, sortDir, {
		value: (f) => {
			const rec = recById.get(f.id);
			if (sortField === 'last_modified') return (rec?.last_modified as string) ?? null;
			if (FILE_SORT_KEYS.has(sortField)) return fileBuiltinSortValue(f, sortField);
			return rec ? fieldSortValue(file.schema, sortField, rec[sortField], resolveRef) : null;
		},
		id: (f) => f.id
	});
	return { files: sorted, healed };
}

// ---------------------------------------------------------------------------
// Per-blob operations (intrinsic; class-agnostic)
// ---------------------------------------------------------------------------

/** Resolve a manifest id to its filename, verifying the blob is on disk. Null if unknown/missing. */
export async function getFilenameForId(id: string): Promise<string | null> {
	const manifest = await readManifest();
	const name = manifest.files[id]?.file_name;
	if (!name) return null;
	const safe = assertSafeBasename(name);
	try {
		await fs.access(path.join(getGlobalFilesDir(), safe));
		return safe;
	} catch {
		return null;
	}
}

/** Ensure a blob exists in the manifest for a freshly-uploaded filename; returns its id. */
export async function registerBlob(fileName: string, size?: number): Promise<string> {
	return await mintFileId(assertSafeBasename(fileName), size);
}

/**
 * Delete a blob from disk, drop its manifest entry, and strip its member record from every class.
 */
export async function deleteFromDiskById(id: string): Promise<void> {
	const manifest = await readManifest();
	const entry = manifest.files[id];
	if (!entry) throw new Error('File not found');
	await fs.unlink(path.join(getGlobalFilesDir(), entry.file_name)).catch((err) => {
		const e = err as NodeJS.ErrnoException;
		if (e.code !== 'ENOENT') throw err;
	});
	// Compressed twins of a blob that no longer exists are pure garbage (Item 15). Done before the
	// manifest entry goes, since that entry is what names them.
	await deleteDerivedForBlob(id);
	await removeFileId(id);
	for (const cid of listClassIds()) {
		await withFileLock(classLockPath(cid), async () => {
			const file = await readClassFile(cid).catch(() => null);
			if (!file || !file.records[id]) return;
			const records = { ...file.records };
			delete records[id];
			await writeClassFile(cid, { ...file, records });
		});
	}
}

/** Delete many blobs from disk. */
export async function bulkDeleteFromDiskByIds(ids: string[]): Promise<void> {
	for (const id of ids) await deleteFromDiskById(id);
}

/**
 * Rename a blob: rename on disk, then update the single manifest entry (O(1); every `id` reference is
 * unaffected). Returns the new filename.
 */
export async function renameBlobById(id: string, newFilename: string): Promise<string> {
	const safe = assertSafeBasename(newFilename);
	const manifest = await readManifest();
	const entry = manifest.files[id];
	if (!entry) throw new Error('File not found');
	if (safe === entry.file_name) return safe;

	const filesDir = getGlobalFilesDir();
	const oldPath = path.join(filesDir, entry.file_name);
	const newPath = path.join(filesDir, safe);
	if (fssync.existsSync(newPath)) {
		const err = new Error('Target filename already exists');
		(err as { status?: number }).status = 409;
		throw err;
	}
	await fs.rename(oldPath, newPath);
	try {
		await manifestRenameFileId(id, safe);
	} catch (err) {
		await fs.rename(newPath, oldPath).catch(() => {});
		throw err;
	}
	// Keep the derivatives' stem in step (Item 15). Deliberately **after** the original's rename has
	// committed, and deliberately not part of the rollback path above: a derivative left under its old
	// name is harmless (every lookup reads its `file_name` from the manifest), whereas unwinding a
	// half-completed rename of the original is not.
	await renameDerivedForBlob(id, safe);
	return safe;
}

/** One dangling reference to a missing blob (for the global missing-files warning). */
export interface MissingFileRef {
	file_id: string;
	file_name: string;
	context: string;
	label: string;
	field: string | null;
}

/**
 * Find every dangling reference to a blob absent from disk: class **memberships** whose blob vanished,
 * and `file`-type field values (in classes and `json` types, incl. globals) pointing at an unavailable
 * id. The filename shown is the manifest's last-known name. Grouped per missing blob by the caller.
 */
export async function listMissingFileReferences(): Promise<MissingFileRef[]> {
	const { manifest, available } = await getAvailableFileIds();
	const out: MissingFileRef[] = [];
	const nameFor = (id: string) => manifest.files[id]?.file_name ?? '';

	const recordLabel = (
		rec: Record<string, unknown>,
		schema: SchemaDefinition,
		fallback: string
	) => {
		for (const [k, def] of Object.entries(schema)) {
			if (def?.type === 'string' && typeof rec[k] === 'string' && (rec[k] as string).trim())
				return rec[k] as string;
		}
		return fallback;
	};

	const scan = (
		context: string,
		schema: SchemaDefinition,
		records: Record<string, Record<string, unknown>>,
		opts: { membershipKeyedByFileId: boolean }
	) => {
		for (const [recId, rec] of Object.entries(records)) {
			const label = recordLabel(rec, schema, opts.membershipKeyedByFileId ? nameFor(recId) : recId);
			if (opts.membershipKeyedByFileId && !available.has(recId)) {
				out.push({ file_id: recId, file_name: nameFor(recId), context, label, field: null });
			}
			for (const [key, def] of Object.entries(schema)) {
				if (def?.type !== 'file') continue;
				const v = rec[key];
				if (typeof v !== 'string' || v === '' || available.has(v)) continue;
				out.push({ file_id: v, file_name: nameFor(v), context, label, field: key });
			}
		}
	};

	for (const cid of listClassIds()) {
		try {
			const file = await readClassFile(cid);
			scan(file.config.displayName || cid, file.schema, file.records as never, {
				membershipKeyedByFileId: true
			});
		} catch {
			/* skip */
		}
	}

	// json-kind types (incl. globals): only `file`-field references can dangle (rows aren't blobs).
	const { listMediaTypeIds, getMediaTypePaths } = await import('./paths.js');
	const { readMediaTypeSettingsFileSync } = await import('./settingsFile.js');
	for (const tId of listMediaTypeIds()) {
		try {
			const mp = getMediaTypePaths(tId);
			const settings = readMediaTypeSettingsFileSync(mp.baseDir);
			if (!settings) continue;
			const raw = JSON.parse(fssync.readFileSync(mp.dataPath, 'utf-8')) as {
				records?: Record<string, unknown>[];
			};
			const records: Record<string, Record<string, unknown>> = {};
			for (const r of raw.records ?? []) {
				const id = (r as { id?: string }).id;
				if (id) records[id] = r as Record<string, unknown>;
			}
			scan(settings.displayName || tId, settings.schema ?? {}, records, {
				membershipKeyedByFileId: false
			});
		} catch {
			/* skip */
		}
	}

	return out;
}

/**
 * Which classes currently have a member record for a blob (used for delete confirmations and the
 * missing-files warning).
 */
export function listClassesReferencingFileId(
	fileId: string
): { id: string; displayName: string }[] {
	const out: { id: string; displayName: string }[] = [];
	for (const cid of listClassIds()) {
		try {
			const raw = JSON.parse(fssync.readFileSync(getClassFilePath(cid), 'utf-8')) as {
				config?: { displayName?: string };
				records?: Record<string, unknown>;
			};
			if (raw.records && fileId in raw.records) {
				out.push({ id: cid, displayName: raw.config?.displayName || cid });
			}
		} catch {
			/* skip */
		}
	}
	return out;
}
