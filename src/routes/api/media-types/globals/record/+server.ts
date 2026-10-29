import { readJsonBody } from '$lib/server/requestJson.js';
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getMediaTypeRepo } from '$lib/server/imageRepo.js';
import { GLOBALS_RECORD_ID, ensureGlobalsGroupExists } from '$lib/storage/mediaTypes.js';

/**
 * GET: Return the singleton globals record.
 *
 * Use case:
 * - Globals editor loads one free-form object (no schema).
 */
export const GET: RequestHandler = async () => {
	await ensureGlobalsGroupExists();
	try {
		const repo = getMediaTypeRepo('globals') as import('$lib/storage/jsonRepo.js').JsonRepo;
		const rec = await repo.getRecordById(GLOBALS_RECORD_ID);
		if (!rec) throw error(404, 'Globals record not found');
		return json(rec);
	} catch (err) {
		if (err && typeof err === 'object' && 'status' in err) throw err as never;
		throw error(500, { message: 'Failed to load globals record' });
	}
};

/**
 * POST: Patch globals fields (free-form). `null` removes a field.
 *
 * Request body is a plain object of field updates.
 */
export const POST: RequestHandler = async ({ request }) => {
	await ensureGlobalsGroupExists();
	const body = await readJsonBody(request);
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		throw error(400, 'Globals patch must be an object');
	}
	try {
		const repo = getMediaTypeRepo('globals') as import('$lib/storage/jsonRepo.js').JsonRepo;
		await repo.updatePropertiesById(GLOBALS_RECORD_ID, body as Record<string, unknown>);
		// Re-read so the response carries the recomputed `_missing_files` / `_missing_records` (the bare
		// update path returns the raw record). Without this the editor's missing-ref badges would freeze at
		// load and re-appear for a now-valid reference right after the user fixes it. Parity with GET.
		const updated = await repo.getRecordById(GLOBALS_RECORD_ID);
		return json(updated);
	} catch (err) {
		if (err && typeof err === 'object' && 'status' in err) throw err as never;
		throw error(500, { message: 'Failed to update globals record' });
	}
};
