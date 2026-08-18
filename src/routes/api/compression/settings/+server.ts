import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

import {
	CompressionSettingsSchema,
	readCompressionSettings,
	writeCompressionSettings
} from '$lib/storage/compressionSettings.js';
import { scheduleCompression } from '$lib/server/compression/queue.js';
import { removeDerivedEntries } from '$lib/storage/manifest.js';
import { sweepDerived } from '$lib/server/compression/sweep.js';

/** GET: the current preset registry + subscriptions. */
export const GET: RequestHandler = async () => {
	return json({ settings: readCompressionSettings() });
};

/**
 * PATCH: update the preset registry / subscriptions.
 *
 * Editing a preset's quality rewrites its recipe string, which makes every derivative built from the old
 * recipe stale, which the background worker then picks up — so this endpoint kicks the worker itself.
 * **The user is never asked to confirm a regeneration:** originals are never at risk, so there is
 * nothing to confirm; the page reports what it is doing instead of asking permission.
 *
 * Deleting a preset drops its manifest records and sweeps its directory, so its bytes are reclaimed
 * rather than left orphaned.
 */
export const PATCH: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	const parsed = CompressionSettingsSchema.partial().safeParse(body);
	if (!parsed.success) throw error(400, 'Invalid compression settings');

	const before = readCompressionSettings();
	let settings;
	try {
		settings = await writeCompressionSettings(parsed.data);
	} catch (err) {
		throw error(400, (err as Error).message);
	}

	// A preset that no longer exists leaves derivatives nothing will ever reference again.
	const removedIds = before.presets
		.map((p) => p.id)
		.filter((id) => !settings.presets.some((p) => p.id === id));
	for (const id of removedIds) await removeDerivedEntries({ presetId: id });
	if (removedIds.length > 0) await sweepDerived();

	const job = scheduleCompression('all');
	return json({ settings, job, regenerating: job.running });
};
