import * as fs from 'node:fs/promises';
import * as fssync from 'node:fs';
import path from 'node:path';
import {
	getRootDir,
	getMediaTypeBaseDir,
	listMediaTypeIds,
	MEDIA_DIR_NAME,
	RECORDS_DIR_NAME,
	POSTS_DIR_NAME,
	GLOBALS_TYPE_ID
} from './paths.js';
import { readMediaTypeSettingsFileSync, writeMediaTypeSettingsFile } from './settingsFile.js';
import type { MediaTypeKind } from './settingsFile.js';
import { writeJsonFileAtomic } from './json.js';
import type { SchemaDefinition } from '$lib/core/types.js';

/** Canonical globals singleton record id (must satisfy ImageIdSchema UUID validation). */
export const GLOBALS_RECORD_ID = '00000000-0000-4000-8000-000000000001' as const;

/**
 * Type ids that are auto-managed/protected on the records side. After the file-first redesign the
 * `files` blob store is no longer a media type (it is the `media/` hub); only the `globals` json
 * singleton remains reserved.
 */
export const RESERVED_TYPE_IDS = new Set<string>([GLOBALS_TYPE_ID]);

/**
 * Folder names that can never be a user typeId — they collide with structural data-root folders
 * (`media/`, `records/`) or are reserved. Enforced at creation (slug) time.
 */
const RESERVED_TYPE_FOLDER_NAMES = new Set<string>([
	GLOBALS_TYPE_ID,
	MEDIA_DIR_NAME,
	RECORDS_DIR_NAME,
	POSTS_DIR_NAME
]);

/** Media type summary (id = folder name). All top-level media types are now `json`. */
export interface MediaTypeSummary {
	id: string;
	displayName: string;
	kind: MediaTypeKind;
	/** Per-type icon id (see `core/icons.ts`); absent ⇒ generic fallback in the rail/palette. */
	icon?: string;
}

/** List all valid top-level (`json`) media types with display name and kind. */
export function listMediaTypes(): MediaTypeSummary[] {
	const ids = listMediaTypeIds();
	const result: MediaTypeSummary[] = [];
	for (const id of ids) {
		const settings = readMediaTypeSettingsFileSync(getMediaTypeBaseDir(id));
		if (!settings) continue;
		result.push({
			id,
			displayName: settings.displayName ?? id,
			kind: settings.kind,
			icon: settings.icon
		});
	}
	return result;
}

/** Slugify a display name for use as a folder name (typeId). */
function slugify(displayName: string): string {
	return (
		displayName
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '') || 'type'
	);
}

/**
 * Create a new `json` media type folder with settings.json and an empty data file.
 *
 * @param displayName - Human-readable name (used to derive slug)
 * @returns The typeId (folder name)
 */
export async function createMediaType(displayName: string): Promise<string> {
	let typeId = slugify(displayName);
	if (RESERVED_TYPE_FOLDER_NAMES.has(typeId)) {
		throw new Error(`"${typeId}" is a reserved name and cannot be used for a media type`);
	}
	let candidate = typeId;
	let n = 1;
	while (fssync.existsSync(getMediaTypeBaseDir(candidate))) {
		candidate = `${typeId}-${n}`;
		n++;
	}
	typeId = candidate;
	const finalBaseDir = getMediaTypeBaseDir(typeId);
	await fs.mkdir(finalBaseDir, { recursive: true });

	const defaultSchema: SchemaDefinition = {
		name: { type: 'string', removable: false, defaultValue: '' }
	} as unknown as SchemaDefinition;

	await writeMediaTypeSettingsFile(finalBaseDir, {
		displayName: displayName.trim() || typeId,
		kind: 'json',
		schema: defaultSchema
	});
	await writeJsonFileAtomic(path.join(finalBaseDir, 'data.json'), { records: [] });
	return typeId;
}

/** Delete a `json` media type folder and all its contents. */
export async function deleteMediaType(typeId: string): Promise<void> {
	if (RESERVED_TYPE_IDS.has(typeId)) {
		throw new Error(`Cannot delete the protected "${typeId}" media type`);
	}
	const rootDir = getRootDir();
	const baseDir = getMediaTypeBaseDir(typeId);
	const resolvedBase = path.resolve(baseDir);
	const resolvedRoot = path.resolve(rootDir);
	if (!resolvedBase.startsWith(resolvedRoot) || resolvedBase === resolvedRoot) {
		throw new Error('Invalid media type path');
	}
	if (!fssync.existsSync(path.join(baseDir, 'settings.json'))) {
		throw new Error('Not a media type folder');
	}
	await fs.rm(baseDir, { recursive: true, force: true });
}

/**
 * Ensure the default "globals" json singleton exists and is healthy (exactly one record with the
 * canonical id). Stays on the records side per the file-first redesign.
 */
export async function ensureGlobalsGroupExists(): Promise<void> {
	const baseDir = getMediaTypeBaseDir(GLOBALS_TYPE_ID);
	const settingsPath = path.join(baseDir, 'settings.json');

	if (!fssync.existsSync(settingsPath)) {
		await fs.mkdir(baseDir, { recursive: true });
		await writeMediaTypeSettingsFile(baseDir, {
			displayName: 'Globals',
			kind: 'json',
			schema: {}
		});
		await writeJsonFileAtomic(path.join(baseDir, 'data.json'), {
			records: [{ id: GLOBALS_RECORD_ID }]
		});
		return;
	}

	const dataPath = path.join(baseDir, 'data.json');
	let records: unknown[] = [];
	try {
		const raw = JSON.parse(await fs.readFile(dataPath, 'utf-8')) as { records?: unknown[] };
		records = Array.isArray(raw.records) ? raw.records : [];
	} catch {
		records = [];
	}

	if (
		records.length === 1 &&
		!!records[0] &&
		typeof records[0] === 'object' &&
		(records[0] as Record<string, unknown>).id === GLOBALS_RECORD_ID
	) {
		return;
	}

	const canonical =
		(records.find(
			(r) => !!r && typeof r === 'object' && (r as Record<string, unknown>).id === GLOBALS_RECORD_ID
		) as Record<string, unknown> | undefined) ??
		(records[0] && typeof records[0] === 'object' ? (records[0] as Record<string, unknown>) : null);
	const healed: Record<string, unknown> = { ...(canonical ?? {}), id: GLOBALS_RECORD_ID };
	if (healed.name === 'Global Settings') delete healed.name;
	await writeJsonFileAtomic(dataPath, { records: [healed] });
}
