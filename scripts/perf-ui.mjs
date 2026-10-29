/**
 * Production Files-grid benchmark: npm run build && node scripts/perf-ui.mjs
 * PERF_UI_COUNT=1000 PERF_UI_RUNS=3 node scripts/perf-ui.mjs
 * Uses an isolated temporary data root; never opens a user's workspace.
 * Fresh browser contexts, warm server/cache, tiny PNGs: CPU/render benchmark, not image throughput.
 */
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const count = Number(process.env.PERF_UI_COUNT ?? 1000);
const runs = Number(process.env.PERF_UI_RUNS ?? 3);
assert(Number.isInteger(count) && count > 0);
assert(Number.isInteger(runs) && runs > 0);
const root = await mkdtemp(join(tmpdir(), 'media-manager-perf-ui-'));
let server;
let browser;
try {
	await mkdir(join(root, 'media', 'files'), { recursive: true });
	await mkdir(join(root, 'media', 'classes'), { recursive: true });
	await writeFile(join(root, 'settings.json'), '{}');
	const png = await readFile('test-fixtures/media/files/sunset.png');
	const files = {};
	for (let i = 0; i < count; i++) {
		const name = `photo-${String(i).padStart(5, '0')}.png`;
		files[randomUUID()] = {
			file_name: name,
			classes: [],
			width: 32,
			height: 32,
			missing: false,
			created_at: '2026-01-01T00:00:00Z'
		};
		await writeFile(join(root, 'media', 'files', name), png);
	}
	await writeFile(join(root, 'media', 'manifest.json'), JSON.stringify({ version: 2, files }));
	// A host CLI's static-assets override must never escape the disposable workspace.
	const env = { ...process.env, MEDIA_MANAGER_ROOT: root, HOST: '127.0.0.1', PORT: '0' };
	delete env.MEDIA_MANAGER_ASSETS_DIR;
	delete env.MEDIA_MANAGER_ASSETS_BASE_URL;
	delete env.MEDIA_MANAGER_CONFIG_PATH;
	server = spawn(
		process.execPath,
		[
			'--input-type=module',
			'-e',
			`import { createServer } from 'node:http'; import { handler } from './build/handler.js'; const s = createServer(handler); s.listen(0, '127.0.0.1', () => console.log('http://127.0.0.1:' + s.address().port));`
		],
		{
			env,
			stdio: ['ignore', 'pipe', 'pipe']
		}
	);
	let output = '';
	const baseURL = await new Promise((resolveUrl, reject) => {
		const timeout = setTimeout(
			() => reject(new Error(`Server readiness timeout: ${output}`)),
			30000
		);
		const collect = (data) => {
			output += data.toString();
			const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
			if (match) {
				clearTimeout(timeout);
				resolveUrl(match[0]);
			}
		};
		server.stdout.on('data', collect);
		server.stderr.on('data', collect);
		server.once('exit', (code) => {
			clearTimeout(timeout);
			reject(new Error(`Server exited ${code}: ${output}`));
		});
	});
	// Warm the disk reconciliation and server route imports before browser measurements.
	await fetch(`${baseURL}/api/files`).then((r) => r.json());
	browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined });
	const results = [];
	for (let run = 0; run < runs; run++) {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		const page = await context.newPage();
		const requests = [];
		const errors = [];
		page.on('request', (req) => requests.push(new URL(req.url()).pathname));
		page.on('pageerror', (err) => errors.push(err.message));
		page.on('response', (res) => {
			if (res.status() >= 400 && new URL(res.url()).pathname.startsWith('/api/'))
				errors.push(`${res.status()} ${res.url()}`);
		});
		await page.addInitScript(() => {
			const seenTiles = new WeakSet();
			window.__perf = { mountedTiles: 0, lastTileMutationMs: 0, longTasks: [] };
			new PerformanceObserver((list) =>
				window.__perf.longTasks.push(...list.getEntries().map((e) => e.duration))
			).observe({ type: 'longtask', buffered: true });
			new MutationObserver((records) => {
				for (const record of records)
					for (const node of record.addedNodes) {
						if (!(node instanceof Element)) continue;
						if (
							node.matches('[data-slot="card"][role="button"]') ||
							node.querySelector('[data-slot="card"][role="button"]')
						)
							window.__perf.lastTileMutationMs = performance.now();
						const tiles = [...node.querySelectorAll('[data-slot="card"][role="button"]')];
						if (node.matches('[data-slot="card"][role="button"]')) tiles.push(node);
						for (const tile of tiles)
							if (!seenTiles.has(tile)) {
								seenTiles.add(tile);
								window.__perf.mountedTiles++;
							}
					}
			}).observe(document, { childList: true, subtree: true });
		});
		await page.goto(`${baseURL}/files`);
		await page.waitForFunction(
			(n) =>
				document.querySelectorAll('.masonry [data-slot="card"]').length === n &&
				document.querySelectorAll('.masonry-column').length > 1,
			count
		);
		await page.evaluate(
			() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
		);
		await page.waitForLoadState('networkidle');
		const initialRequests = [...requests];
		const initial = await page.evaluate(() => ({
			// Includes Playwright's 500ms network-idle window; use lastTileMutationMs for DOM work.
			settledMs: performance.now(),
			...window.__perf,
			domNodes: document.querySelectorAll('*').length,
			columns: document.querySelectorAll('.masonry-column').length
		}));
		await page.getByRole('button', { name: 'Select', exact: true }).click();
		const selectStart = await page.evaluate(() => performance.now());
		await page.getByRole('checkbox', { name: 'Select all', exact: true }).click();
		await page.waitForFunction(
			(n) => document.querySelectorAll('.masonry [data-slot="card"].ring-2').length === n,
			count
		);
		const selectAllMs = await page.evaluate((start) => performance.now() - start, selectStart);
		// Resize must retain all tiles and recompute responsive columns.
		await page.setViewportSize({ width: 1024, height: 900 });
		await page.waitForFunction(
			(cols) => document.querySelectorAll('.masonry-column').length !== cols,
			initial.columns
		);
		assert.equal(await page.locator('.masonry [data-slot="card"]').count(), count);
		assert.deepEqual(errors, []);
		results.push({
			run: run + 1,
			...initial,
			selectAllMs,
			requests: initialRequests.length,
			blobRequests: initialRequests.filter((p) => /\/blob$/.test(p)).length,
			apiRequests: initialRequests.filter((p) => p.startsWith('/api/') && !p.endsWith('/blob'))
		});
		await context.close();
	}
	console.log(JSON.stringify({ count, runs, browser: browser.version(), results }, null, 2));
} finally {
	await browser?.close();
	if (server && server.exitCode === null) {
		server.kill('SIGTERM');
		await new Promise((resolve) => server.once('exit', resolve));
	}
	await rm(root, { recursive: true, force: true });
}
