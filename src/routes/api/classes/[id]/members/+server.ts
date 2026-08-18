import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { z } from 'zod';
import { ImageIdSchema } from '$lib/core/ids.js';
import { listClassMembers, addMembers, removeMembers } from '$lib/storage/classRepo.js';
import { scheduleCompression } from '$lib/server/compression/queue.js';
import { unlinkBlobFromClass } from '$lib/storage/relationLinks.js';
import { FilterClauseSchema } from '$lib/core/filters.js';

const FiltersParamSchema = z.array(FilterClauseSchema);
const IdsBodySchema = z.object({ ids: z.array(ImageIdSchema).min(1) });

/** GET: The one-class catalog view — every member as a FileItem (group-by, filters, search). */
export const GET: RequestHandler = async ({ params, url }) => {
	try {
		const groupBy = url.searchParams.get('groupBy') || undefined;
		const query = url.searchParams.get('query');
		const searchField = url.searchParams.get('searchField') || undefined;
		const sortField = url.searchParams.get('sort') || undefined;
		const sortDirRaw = url.searchParams.get('dir');
		const sortDir = sortDirRaw === 'asc' || sortDirRaw === 'desc' ? sortDirRaw : undefined;
		// Incomplete filter (Item 10): `?incomplete=1` → only members with ≥1 empty field.
		const incomplete = url.searchParams.get('incomplete') === '1';
		// Verbose grid (Item 8): `?fields=a,b,c` → inline those field values on each member.
		const fieldsRaw = url.searchParams.get('fields');
		const fields = fieldsRaw
			? fieldsRaw
					.split(',')
					.map((f) => f.trim())
					.filter(Boolean)
			: undefined;
		const filtersRaw = url.searchParams.get('filters');
		let filters: z.infer<typeof FiltersParamSchema> | null = null;
		if (filtersRaw) {
			try {
				filters = FiltersParamSchema.parse(JSON.parse(filtersRaw));
			} catch {
				/* ignore invalid filters */
			}
		}
		return json(
			await listClassMembers(params.id, {
				groupBy,
				query,
				filters,
				searchField,
				sortField,
				sortDir,
				incomplete,
				fields
			})
		);
	} catch (err) {
		const e = err as Error;
		if (e.message?.includes('not found')) throw error(404, 'Class not found');
		if (e.message?.includes('Invalid class id')) throw error(400, e.message);
		throw error(500, { message: 'Failed to list members' });
	}
};

/** POST: Add blobs to the class (creates empty member records). Body: { ids }. */
export const POST: RequestHandler = async ({ params, request }) => {
	const parsed = IdsBodySchema.safeParse(await request.json());
	if (!parsed.success) throw error(400, 'ids array is required');
	try {
		const records = await addMembers(params.id, parsed.data.ids);
		// Item 15 phase 2: membership changes the *union* of presets these blobs are subscribed to, so
		// re-plan them. Not awaited — the encode must never delay the membership write.
		scheduleCompression(parsed.data.ids);
		return json({ success: true, added: records.length });
	} catch (err) {
		const e = err as Error;
		if (e.message?.includes('not found')) throw error(404, 'Class not found');
		if (e.message?.includes('Invalid class id')) throw error(400, e.message);
		throw error(500, { message: 'Failed to add members' });
	}
};

/** DELETE: Remove blobs from the class (drops their member records). Body: { ids }. */
export const DELETE: RequestHandler = async ({ params, request }) => {
	const parsed = IdsBodySchema.safeParse(await request.json());
	if (!parsed.success) throw error(400, 'ids array is required');
	try {
		// Drop these blobs from any linked record's file field before they leave the class.
		for (const fileId of parsed.data.ids) await unlinkBlobFromClass(params.id, fileId);
		await removeMembers(params.id, parsed.data.ids);
		// Leaving a class can shrink the union — the worker's prune pass drops any derivative no remaining
		// subscriber wants, and keeps the ones another class still does.
		scheduleCompression(parsed.data.ids);
		return json({ success: true });
	} catch (err) {
		const e = err as Error;
		if (e.message?.includes('not found')) throw error(404, 'Class not found');
		if (e.message?.includes('Invalid class id')) throw error(400, e.message);
		throw error(500, { message: 'Failed to remove members' });
	}
};
