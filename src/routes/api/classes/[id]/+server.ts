import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { z } from 'zod';
import { readClassFile, updateClassConfig, deleteClass } from '$lib/storage/classRepo.js';
import { purgeClassLinks } from '$lib/storage/relationLinks.js';
import { MAX_VERBOSE_FIELDS } from '$lib/core/recordDisplay.js';
import { scheduleCompression } from '$lib/server/compression/queue.js';

const ConfigPatchSchema = z.object({
	displayName: z.string().min(1).max(256).optional(),
	gridGroupByField: z.string().optional(),
	displayField: z.string().optional(),
	// List sort (Item 9): a built-in or schema field key + direction. '' clears the override (default).
	sortField: z.string().max(256).optional(),
	sortDir: z.enum(['asc', 'desc']).optional(),
	gridSize: z.enum(['small', 'medium', 'large']).optional(),
	// Per-class icon id (a curated Lucide id; '' resolves to the generic fallback when rendered).
	icon: z.string().max(64).optional(),
	// Verbose grid (Item 8): show each catalog tile's chosen fields as key/value rows.
	verbose: z.boolean().optional(),
	// Compression subscription (Item 15 phase 2): preset ids this class's members get on top of the
	// workspace-wide subscription. An empty array clears it.
	compressionPresets: z.array(z.string().max(64)).max(32).optional(),
	// Verbose grid (Item 8): the class schema field keys shown per tile (capped at MAX_VERBOSE_FIELDS).
	verboseFields: z.array(z.string().max(256)).optional()
});

/** GET: A class's schema + config (the editor/grid bootstrap). */
export const GET: RequestHandler = async ({ params }) => {
	try {
		const file = await readClassFile(params.id);
		return json({ id: params.id, schema: file.schema, config: file.config });
	} catch (err) {
		const e = err as Error;
		if (e.message?.includes('not found')) throw error(404, 'Class not found');
		if (e.message?.includes('Invalid class id')) throw error(400, e.message);
		throw error(500, { message: 'Failed to load class' });
	}
};

/** PATCH: Update a class's config (rename displayName, grid prefs). */
export const PATCH: RequestHandler = async ({ params, request }) => {
	const parsed = ConfigPatchSchema.safeParse(await request.json());
	if (!parsed.success) throw error(400, 'Invalid config payload');
	try {
		// Empty `sortField` clears the per-class sort override (back to default).
		const patch = { ...parsed.data };
		if (patch.sortField === '') patch.sortField = undefined;
		// Verbose grid (Item 8): clamp the field set defensively; drop an off+empty pair to undefined.
		if (patch.verboseFields !== undefined)
			patch.verboseFields = patch.verboseFields.length
				? patch.verboseFields.slice(0, MAX_VERBOSE_FIELDS)
				: undefined;
		if (patch.verbose === false) patch.verbose = undefined;
		// An empty subscription is stored as absent, so `readClassPresetMap` doesn't carry empty entries.
		const subscriptionChanged = patch.compressionPresets !== undefined;
		if (patch.compressionPresets?.length === 0) patch.compressionPresets = undefined;
		const config = await updateClassConfig(params.id, patch);
		// Item 15 phase 2: changing what this class subscribes to changes its members' preset union —
		// generate what's newly wanted and prune what nothing wants any more. Never awaited, never
		// confirmed: originals are untouched, so there is nothing to ask about.
		if (subscriptionChanged) scheduleCompression('all');
		return json({ success: true, config });
	} catch (err) {
		const e = err as Error;
		if (e.message?.includes('not found')) throw error(404, 'Class not found');
		if (e.message?.includes('Invalid class id')) throw error(400, e.message);
		throw error(500, { message: 'Failed to update class' });
	}
};

/** DELETE: Remove a class (destroys its metadata; blobs are untouched). */
export const DELETE: RequestHandler = async ({ params }) => {
	try {
		await deleteClass(params.id);
		// Strip class scope + link from any type file field that pointed at this class.
		await purgeClassLinks(params.id);
		return json({ success: true });
	} catch (err) {
		const e = err as Error;
		if (e.message?.includes('Invalid class id')) throw error(400, e.message);
		throw error(500, { message: 'Failed to delete class' });
	}
};
