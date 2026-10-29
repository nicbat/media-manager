/** Repeatable storage microbenchmark. Run: node scripts/perf-storage.mjs [1000 5000 10000]
 * Uses temporary synthetic workspaces, excludes seeding/warmup, and removes them on exit.
 * Non-image one-byte blobs isolate JSON/storage costs; this does not benchmark image decoding or UI.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createServer } from 'vite';

const sizes = process.argv.slice(2).map(Number);
if (!sizes.length) sizes.push(1000, 5000, 10000);
if (sizes.some((size) => !Number.isInteger(size) || size < 100)) {
	throw new Error('Sizes must be integers >= 100');
}
const server = await createServer({
	logLevel: 'error',
	server: { middlewareMode: true },
	appType: 'custom'
});
const repo = await server.ssrLoadModule('/src/lib/storage/classRepo.ts');
const roots = [];
const savedEnv = Object.fromEntries(
	['MEDIA_MANAGER_ROOT', 'MEDIA_MANAGER_ASSETS_DIR', 'MEDIA_MANAGER_ASSETS_BASE_URL'].map((key) => [
		key,
		process.env[key]
	])
);
for (const key of Object.keys(savedEnv)) delete process.env[key];
const results = [];
try {
	for (const count of sizes) {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mm-perf-storage-'));
		roots.push(root);
		process.env.MEDIA_MANAGER_ROOT = root;
		await fs.mkdir(path.join(root, 'media', 'files'), { recursive: true });
		await fs.mkdir(path.join(root, 'media', 'classes'), { recursive: true });
		const files = {};
		const records = Array.from({ length: 5 }, () => ({}));
		for (let i = 0; i < count; i++) {
			const id = randomUUID();
			const name = `file-${String(i).padStart(6, '0')}.txt`;
			files[id] = {
				file_name: name,
				classes: [`class-${i % 5}`],
				missing: false,
				size: 1,
				created_at: '2026-01-01T00:00:00.000Z'
			};
			records[i % 5][id] = {
				id,
				caption: `Caption ${i}`,
				last_modified: '2026-01-01T00:00:00.000Z'
			};
			await fs.writeFile(path.join(root, 'media', 'files', name), 'x');
		}
		for (let i = 0; i < 5; i++) {
			await fs.writeFile(
				path.join(root, 'media', 'classes', `class-${i}.json`),
				JSON.stringify({
					schema: { caption: { type: 'string', removable: true } },
					config: { displayName: `Class ${i}` },
					records: records[i]
				})
			);
		}
		await fs.writeFile(
			path.join(root, 'media', 'manifest.json'),
			JSON.stringify({ version: 2, files }, null, 2)
		);
		await repo.createClass('Batch target', {});
		const selected = Object.keys(files).slice(0, 100);
		const operations = {
			listAllFiles: () => repo.listAllFiles(),
			listClassMembers: () => repo.listClassMembers('class-0'),
			missingReferences: () => repo.listMissingFileReferences(),
			add100: () => repo.addMembers('batch-target', selected),
			remove100: () => repo.removeMembers('batch-target', selected)
		};
		const samples = Object.fromEntries(Object.keys(operations).map((name) => [name, []]));
		for (let round = 0; round < 6; round++) {
			for (const [name, operation] of Object.entries(operations)) {
				const started = performance.now();
				await operation();
				if (round) samples[name].push(performance.now() - started);
			}
		}
		for (const [operation, values] of Object.entries(samples)) {
			const sorted = [...values].sort((a, b) => a - b);
			results.push({
				files: count,
				operation,
				medianMs: +sorted[2].toFixed(2),
				samplesMs: values.map((n) => +n.toFixed(2))
			});
		}
	}
	console.log(
		JSON.stringify(
			{ node: process.version, platform: process.platform, rounds: 5, warmupRounds: 1, results },
			null,
			2
		)
	);
} finally {
	await server.close();
	for (const root of roots) await fs.rm(root, { recursive: true, force: true });
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}
