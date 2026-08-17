import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import fs from 'node:fs';
import { z } from 'zod';

import { getGlobalFilesDir, isStaticAssetsMode } from '$lib/storage/paths.js';
import { readManifest } from '$lib/storage/manifest.js';
import { migrateBlobs } from '$lib/storage/assetsMigrate.js';
import {
	getConfigPath,
	configExists,
	configWritable,
	resolveStorageTarget,
	persistStorageConfig,
	applyStorageEnv
} from '$lib/server/storageConfig.js';

/**
 * Storage-location settings: where the workspace's blobs live, and the migration that moves them.
 *
 * - `GET`  — current state (mode / dir / baseUrl / blob count / whether the change can be persisted).
 * - `POST` — commit a change: run {@link migrateBlobs}, then (on a clean, non-aborted result) persist the
 *   config's `assets` block and flip the live env so the next request serves from the new folder. An
 *   aborted preflight (name conflict / missing-at-source) returns `409` with the report, changing nothing.
 *
 * The dry-run preview lives at the sibling `POST /api/settings/storage/preview`.
 */

/** Commit / preview payload (preview ignores `force`). */
const StorageRequestSchema = z.object({
	mode: z.enum(['static', 'classic']),
	dir: z.string().max(4096).optional(),
	baseUrl: z.string().max(2048).optional(),
	strategy: z.enum(['move', 'copy', 'leave']),
	force: z.boolean().optional()
});

/** GET: current storage state. */
export const GET: RequestHandler = async () => {
	const manifest = await readManifest();
	const configPath = getConfigPath();
	return json({
		mode: isStaticAssetsMode() ? 'static' : 'classic',
		dir: getGlobalFilesDir(),
		baseUrl: process.env.MEDIA_MANAGER_ASSETS_BASE_URL?.trim() || null,
		blobCount: Object.keys(manifest.files).length,
		configPath,
		configExists: configExists(),
		canChange: configWritable()
	});
};

/** POST: commit a storage-location change (migrate blobs → persist config → apply live env). */
export const POST: RequestHandler = async ({ request }) => {
	if (request.headers.get('content-type')?.includes('application/json') === false) {
		throw error(400, 'Content-Type must be application/json');
	}
	const parsed = StorageRequestSchema.safeParse(await request.json());
	if (!parsed.success) throw error(400, 'Invalid storage payload');

	if (!configWritable()) {
		throw error(409, `Config file is not writable, cannot persist: ${getConfigPath()}`);
	}

	let target;
	try {
		target = resolveStorageTarget(parsed.data);
	} catch (e) {
		throw error(400, (e as Error).message);
	}

	const result = await migrateBlobs({
		toDir: target.toDir,
		strategy: parsed.data.strategy,
		force: parsed.data.force
	});

	// Preflight blocked it — nothing moved, nothing persisted.
	if (result.aborted) {
		return json({ ...result, persisted: false }, { status: 409 });
	}

	const { configPath, created } = persistStorageConfig(target.assets);
	applyStorageEnv(target.assets);

	return json({
		...result,
		persisted: true,
		mode: target.assets ? 'static' : 'classic',
		baseUrl: target.assets?.baseUrl ?? null,
		configPath,
		configCreated: created,
		// Re-report post-apply state for the UI.
		configExists: fs.existsSync(configPath)
	});
};
