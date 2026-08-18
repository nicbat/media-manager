import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { getGlobalFilesDir } from '$lib/storage/paths.js';
import { assertSafeBasename } from '$lib/storage/filenames.js';
import { registerBlob } from '$lib/storage/classRepo.js';
import { maybeConvertHeic } from '$lib/server/heicConvert.js';
import { scheduleCompression } from '$lib/server/compression/queue.js';
import { readCompressionSettings } from '$lib/storage/compressionSettings.js';
import {
	getAccessToken,
	listPickedItems,
	downloadPickedItem,
	deleteSession
} from '$lib/server/googlePhotos.js';

/** Append (1), (2)… to a basename until it is unique within `dir`. */
function uniqueName(baseFilename: string, dir: string): string {
	if (!fs.existsSync(path.join(dir, baseFilename))) return baseFilename;
	const ext = path.extname(baseFilename);
	const name = path.basename(baseFilename, ext);
	for (let n = 1; n <= 9999; n++) {
		const candidate = `${name} (${n})${ext}`;
		if (!fs.existsSync(path.join(dir, candidate))) return candidate;
	}
	throw new Error('Too many filename conflicts');
}

/**
 * POST: download every photo picked in a session into `media/files/` (unclassified, like any upload),
 * then delete the session.
 *
 * **Partial-failure resilient (Item 37):** each item is downloaded + registered under its own
 * try/catch so one bad/expired `baseUrl` can't abort the batch. Returns a summary
 * `{ imported, failed, fileIds, failures[] }` (mirrors the `/api/files/missing` summary shape).
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => ({}))) as { sessionId?: string };
	const sessionId = body.sessionId?.trim();
	if (!sessionId) throw error(400, 'sessionId is required.');

	let accessToken: string;
	let items;
	try {
		accessToken = await getAccessToken();
		items = await listPickedItems(accessToken, sessionId);
	} catch (err) {
		throw error(400, (err as Error).message);
	}

	const filesDir = getGlobalFilesDir();
	if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir, { recursive: true });

	const fileIds: string[] = [];
	const failures: { filename: string; reason: string }[] = [];

	for (const item of items) {
		const originalName = item.mediaFile?.filename ?? `${item.id}.jpg`;
		try {
			const bytes = await downloadPickedItem(item, accessToken);
			const { buffer, filename } = await maybeConvertHeic(
				bytes,
				originalName,
				item.mediaFile?.mimeType ?? ''
			);
			const safe = uniqueName(
				assertSafeBasename(path.basename(filename).replace(/[^a-zA-Z0-9.\-_ ]/g, '_')),
				filesDir
			);
			fs.writeFileSync(path.join(filesDir, safe), buffer);
			const id = await registerBlob(safe, buffer.length);
			fileIds.push(id);
		} catch (err) {
			failures.push({ filename: originalName, reason: (err as Error).message });
		}
	}

	await deleteSession(accessToken, sessionId);

	// Item 15: `registerBlob` has two callers and compression hooks **both**. Wiring only upload would
	// leave every imported photo uncompressed until someone happened to run a manual backfill.
	if (fileIds.length > 0 && readCompressionSettings().autoCompress) scheduleCompression(fileIds);

	return json({ imported: fileIds.length, failed: failures.length, fileIds, failures });
};
