#!/usr/bin/env node
/** Real Chromium + production HTTP handler + disposable disk data. Successes use real API responses; selected cases inject delayed/failed responses.
 * npm run test:browser builds first; --skip-build is for an explicitly prepared build.
 * One-time prerequisite: npx playwright install chromium (or PW_CHANNEL=chrome).
 */
import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const script = fileURLToPath(import.meta.url);
const repo = path.resolve(path.dirname(script), '..');
if (process.argv.includes('--serve')) {
	const { handler } = await import('../build/handler.js');
	const server = createServer(handler);
	server.listen(0, '127.0.0.1', () =>
		process.send({ url: `http://127.0.0.1:${server.address().port}` })
	);
	process.on('disconnect', () => process.exit(0));
}

async function main() {
	if (!process.argv.includes('--skip-build')) {
		const build = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
			cwd: repo,
			stdio: 'inherit'
		});
		if (build.status !== 0) throw new Error('Production build failed');
	}
	const root = await mkdtemp(path.join(tmpdir(), 'media-manager-browser-'));
	let child;
	let browser;
	const watchdog = setTimeout(async () => {
		console.error('Browser suite exceeded its 300 second deadline');
		child?.kill('SIGKILL');
		await browser?.close();
		await rm(root, { recursive: true, force: true });
		process.exit(1);
	}, 300_000);
	try {
		const env = { ...process.env, MEDIA_MANAGER_ROOT: root };
		delete env.MEDIA_MANAGER_ASSETS_DIR;
		delete env.MEDIA_MANAGER_ASSETS_BASE_URL;
		delete env.MEDIA_MANAGER_CONFIG_PATH;

		browser = await chromium.launch({
			headless: true,
			...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {})
		});
		const failures = [];
		const grep = process.argv.indexOf('--grep');
		const selected =
			grep === -1
				? scenarios
				: scenarios.filter(([name]) =>
						name.toLowerCase().includes((process.argv[grep + 1] || '').toLowerCase())
					);
		assert.ok(selected.length, 'Scenario filter must match at least one case');
		for (const [name, run] of selected) {
			// The prior browser context and server are closed before replacing the disposable root.
			// Restarting also discards in-memory caches and any outstanding writes after a failure.
			await rm(root, { recursive: true, force: true });
			await cp(path.join(repo, 'test-fixtures'), root, { recursive: true });
			child = fork(script, ['--serve'], {
				cwd: repo,
				env,
				stdio: ['ignore', 'inherit', 'inherit', 'ipc']
			});
			const [{ url }] = await Promise.race([
				once(child, 'message'),
				once(child, 'exit').then(([code]) => {
					throw new Error(`Test server exited before ready (${code})`);
				})
			]);

			const context = await browser.newContext({
				baseURL: url,
				viewport: { width: 1440, height: 1000 }
			});
			await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
			const page = await context.newPage();
			page.setDefaultTimeout(10_000);
			const errors = [];
			page.on('pageerror', (error) => errors.push(error.message));
			try {
				await run(page, root);
				assert.deepEqual(errors, [], 'No uncaught browser exceptions');
				console.log(`PASS ${name}`);
			} catch (error) {
				failures.push(name);
				console.error(`FAIL ${name}: ${error.stack}`);
				const artifacts = path.join(
					repo,
					'.screenshots',
					`browser-${Date.now()}-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`
				);
				await mkdir(artifacts, { recursive: true });
				await page
					.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true })
					.catch(() => {});
				await context.tracing.stop({ path: path.join(artifacts, 'trace.zip') });
				console.error(`Failure evidence: ${artifacts}`);
			} finally {
				await context.close();
				if (child.exitCode === null && child.signalCode === null) {
					const exited = once(child, 'exit');
					child.kill('SIGKILL');
					await exited;
				}
				child = null;
			}
		}
		if (failures.length)
			throw new Error(`${failures.length} browser regression(s) failed: ${failures.join(', ')}`);
	} finally {
		clearTimeout(watchdog);
		await browser?.close();
		if (child && child.exitCode === null && child.signalCode === null) {
			const exited = once(child, 'exit');
			child.kill('SIGKILL');
			await exited;
		}
		await rm(root, { recursive: true, force: true });
	}
}

const first = '55555555-5555-4555-8555-555555555555';
const second = '66666666-6666-4666-8666-666666666666';
const file = 'bad5de29-3471-4072-8229-af28c4ae446b';
const recordUrl = `/media?type=notes&record=${first}`;
const recordApi = `/api/media-types/notes/records/by-id/${first}`;
const json = async (filename) => JSON.parse(await readFile(filename, 'utf8'));
async function poll(check, message) {
	const deadline = Date.now() + 10_000;
	do {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	} while (Date.now() < deadline);
	throw new Error(message);
}
async function focused(field, value, caret) {
	assert.deepEqual(
		await field.evaluate((el) => ({
			active: document.activeElement === el,
			value: el.value,
			start: el.selectionStart,
			end: el.selectionEnd
		})),
		{ active: true, value, start: caret, end: caret }
	);
}
async function broadcast(page, kind, responseMatch) {
	const response = page.waitForResponse(responseMatch);
	await page.evaluate((kind) => {
		const channel = new BroadcastChannel('media-manager-refresh');
		channel.postMessage(kind);
		channel.close();
	}, kind);
	await response;
	// Allow Svelte's response-driven update and an animation frame to land.
	await page.evaluate(
		() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
	);
}
/** Find a Globals free-form row by its stable field key. */
function globalField(page, key) {
	return page
		.locator('div[title="' + key + '"]')
		.locator('..')
		.locator('input, textarea')
		.first();
}

/** Find a schema-driven post metadata field in the details sidebar. */
function postField(page, key) {
	return page
		.locator('aside span[title="' + key + '"]')
		.locator('..')
		.locator('input, textarea')
		.first();
}

/** Fail one real save request; the next commit must retry and reach the production server. */
async function failNextSave(page, pattern, method) {
	let failed = false;
	await page.route(pattern, async (route) => {
		if (!failed && route.request().method() === method) {
			failed = true;
			return route.fulfill({
				status: 503,
				contentType: 'application/json',
				body: '{"message":"test save failure"}'
			});
		}
		await route.continue();
	});
}

const scenarios = [
	[
		'Files startup issues one catalog request',
		async (page) => {
			let lists = 0;
			page.on('request', (request) => {
				if (new URL(request.url()).pathname === '/api/files') lists++;
			});
			await page.goto('/files');
			await page.getByText('sunset.png', { exact: true }).first().waitFor();
			await page.waitForLoadState('networkidle');
			assert.equal(lists, 1, 'Restoring settings must not trigger duplicate startup listings');
		}
	],
	[
		'file edits typed during a delayed save remain dirty and persist',
		async (page, root) => {
			await page.goto(`/files?class=images&file=${file}`);
			const field = page
				.locator('aside')
				.last()
				.locator('div.space-y-0\\.5')
				.filter({ has: page.getByText('caption', { exact: true }) })
				.locator('input, textarea');
			let release;
			const gate = new Promise((resolve) => {
				release = resolve;
			});
			let started;
			const pending = new Promise((resolve) => {
				started = resolve;
			});
			await page.route(`**/api/classes/images/records/${file}`, async (route) => {
				if (route.request().method() !== 'PATCH') return route.continue();
				const response = await route.fetch();
				started();
				await gate;
				await route.fulfill({ response });
			});
			try {
				await field.fill('file first sent snapshot');
				await field.press('Tab');
				await pending;
				await field.fill('file newest unsent snapshot');
				release();
				await poll(
					async () =>
						(await json(path.join(root, 'media/classes/images.json'))).records[file].caption ===
						'file newest unsent snapshot',
					'Newer keystrokes must not be falsely marked saved'
				);
				await page.reload();
				await field.waitFor();
				await poll(
					async () => (await field.inputValue()) === 'file newest unsent snapshot',
					'Newest file edits survive reload'
				);
			} finally {
				release();
			}
		}
	],
	[
		'switching files queues edits typed during a delayed save',
		async (page, root) => {
			await page.goto(`/files?class=images&file=${file}`);
			const field = page
				.locator('aside')
				.last()
				.locator('div.space-y-0\\.5')
				.filter({ has: page.getByText('caption', { exact: true }) })
				.locator('input, textarea');
			let release;
			const gate = new Promise((resolve) => {
				release = resolve;
			});
			let started;
			const pending = new Promise((resolve) => {
				started = resolve;
			});
			await page.route(`**/api/classes/images/records/${file}`, async (route) => {
				if (route.request().method() !== 'PATCH') return route.continue();
				const response = await route.fetch();
				started();
				await gate;
				await route.fulfill({ response });
			});
			try {
				await field.fill('file first sent snapshot');
				await field.press('Tab');
				await pending;
				await field.fill('file newest unsent snapshot');
				await page.getByText('Deep blue ocean', { exact: true }).first().click();
				await poll(
					async () => (await field.inputValue()) === 'Deep blue ocean',
					'Incoming file must load'
				);
				release();
				await poll(
					async () =>
						(await json(path.join(root, 'media/classes/images.json'))).records[file].caption ===
						'file newest unsent snapshot',
					'Newer keystrokes must not be falsely marked saved'
				);
				await page.goto(`/files?class=images&file=${file}`);
				await field.waitFor();
				await poll(
					async () => (await field.inputValue()) === 'file newest unsent snapshot',
					'Newest file edits survive reload'
				);
			} finally {
				release();
			}
		}
	],
	[
		'record draft survives schema refresh; idle save preserves caret; reload persists',
		async (page, root) => {
			await page.goto(recordUrl);
			const field = page.locator('#body');
			await field.fill('browser draft around caret');
			await field.evaluate((el) => el.setSelectionRange(8, 8));
			await broadcast(
				page,
				'schema',
				(r) => r.url().endsWith(recordApi) && r.request().method() === 'GET'
			);
			await focused(field, 'browser draft around caret', 8);
			await page.keyboard.type('NEW ');
			const expected = 'browser NEW draft around caret';
			await poll(
				async () =>
					(await json(path.join(root, 'records/notes/data.json'))).records.find(
						(r) => r.id === first
					).body === expected,
				'Idle autosave must reach disk'
			);
			await focused(field, expected, 12);
			await page.reload();
			await field.waitFor();
			await poll(
				async () => (await field.inputValue()) === expected,
				'Saved record must survive reload'
			);
		}
	],
	[
		'file draft survives list refresh and persists through reload',
		async (page, root) => {
			await page.goto(`/files?class=images&file=${file}`);
			const field = page
				.locator('aside')
				.last()
				.locator('div.space-y-0\\.5')
				.filter({ has: page.getByText('caption', { exact: true }) })
				.locator('input, textarea');
			await field.fill('file browser draft');
			await field.evaluate((el) => el.setSelectionRange(5, 5));
			await broadcast(
				page,
				'list',
				(r) => r.url().includes('/members') && r.request().method() === 'GET'
			);
			await focused(field, 'file browser draft', 5);
			await page.keyboard.type('NEW ');
			await poll(
				async () =>
					(await json(path.join(root, 'media/classes/images.json'))).records[file].caption ===
					'file NEW browser draft',
				'File autosave must reach disk'
			);
			await focused(field, 'file NEW browser draft', 9);
			await page.reload();
			await field.waitFor();
			await poll(
				async () => (await field.inputValue()) === 'file NEW browser draft',
				'Saved file caption must survive reload'
			);
		}
	],
	[
		'delayed record save cannot overwrite a newly selected record',
		async (page, root) => {
			await page.goto(recordUrl);
			const body = page.locator('#body');
			await body.fill('outgoing record delayed save');
			let release;
			const gate = new Promise((resolve) => {
				release = resolve;
			});
			let started;
			const pending = new Promise((resolve) => {
				started = resolve;
			});
			await page.route(`**${recordApi}`, async (route) => {
				if (route.request().method() !== 'POST') return route.continue();
				const response = await route.fetch();
				started();
				await gate;
				await route.fulfill({ response });
			});
			try {
				await body.press('Tab');
				await pending;
				await body.fill('outgoing newest unsent edit');
				await page.getByText('Second note', { exact: true }).first().click();
				await poll(
					async () =>
						(await body.inputValue()) ===
						'Another record so list and filter views have something to show.',
					'Second record must load'
				);
				await body.fill('incoming record independent draft');
				release();
				await body.press('Tab');
				await poll(async () => {
					const records = (await json(path.join(root, 'records/notes/data.json'))).records;
					return (
						records.find((r) => r.id === first).body === 'outgoing newest unsent edit' &&
						records.find((r) => r.id === second).body === 'incoming record independent draft'
					);
				}, 'Both records must persist their own edits');
				await page.reload();
				await body.waitFor();
				await poll(
					async () => (await body.inputValue()) === 'incoming record independent draft',
					'Incoming draft survives late response and reload'
				);
			} finally {
				release();
			}
		}
	],
	[
		'reverting to the confirmed value during a delayed save persists the revert',
		async (page, root) => {
			await page.goto(recordUrl);
			const body = page.locator('#body');
			const original = await body.inputValue();
			const incomingOriginal = (
				await json(path.join(root, 'records/notes/data.json'))
			).records.find((r) => r.id === second).body;
			await body.fill('outgoing record delayed save');
			let release;
			const gate = new Promise((resolve) => {
				release = resolve;
			});
			let started;
			const pending = new Promise((resolve) => {
				started = resolve;
			});
			await page.route(`**${recordApi}`, async (route) => {
				if (route.request().method() !== 'POST') return route.continue();
				const response = await route.fetch();
				started();
				await gate;
				await route.fulfill({ response });
			});
			try {
				await body.press('Tab');
				await pending;
				await body.fill(original);
				await page.getByText('Second note', { exact: true }).first().click();
				await poll(
					async () => (await body.inputValue()) === incomingOriginal,
					'Second record must load'
				);
				await body.fill('incoming record independent draft');
				release();
				await body.press('Tab');
				await poll(async () => {
					const records = (await json(path.join(root, 'records/notes/data.json'))).records;
					return (
						records.find((r) => r.id === first).body === original &&
						records.find((r) => r.id === second).body === 'incoming record independent draft'
					);
				}, 'Both records must persist their own edits');
				await page.reload();
				await body.waitFor();
				await poll(
					async () => (await body.inputValue()) === 'incoming record independent draft',
					'Incoming draft survives late response and reload'
				);
			} finally {
				release();
			}
		}
	],
	[
		'Globals keeps focused edits through idle save and a real second-tab refresh, then reloads from disk',
		async (page, root) => {
			await page.goto('/globals');
			const field = globalField(page, 'site_title');
			await field.fill('Globals browser draft');
			await field.evaluate((el) => el.setSelectionRange(7, 7));
			const other = await page.context().newPage();
			try {
				await other.goto('/media?type=notes');
				await other.evaluate(() => {
					const channel = new BroadcastChannel('media-manager-refresh');
					channel.postMessage('list');
					channel.close();
				});
				// A dirty editor deliberately ignores the external refresh; its draft stays local.
				await page.evaluate(
					() =>
						new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
				);
			} finally {
				await other.close();
			}
			await poll(
				async () =>
					(await json(path.join(root, 'globals/data.json'))).records[0].site_title ===
					'Globals browser draft',
				'Globals idle save reaches disk'
			);
			await focused(field, 'Globals browser draft', 7);
			await page.reload();
			await poll(
				async () =>
					(await globalField(page, 'site_title').inputValue()) === 'Globals browser draft',
				'Globals reload preserves saved text'
			);
		}
	],
	[
		'Globals retries a failed save without losing the draft',
		async (page, root) => {
			await page.goto('/globals');
			const field = globalField(page, 'site_title');
			await failNextSave(page, '**/api/media-types/globals/record', 'POST');
			await field.fill('Globals retry draft');
			await field.press('Tab');
			await page.getByText('Failed', { exact: true }).waitFor();
			assert.equal(await field.inputValue(), 'Globals retry draft');
			await field.focus();
			await field.press('Tab');
			await poll(
				async () =>
					(await json(path.join(root, 'globals/data.json'))).records[0].site_title ===
					'Globals retry draft',
				'Globals retry persists'
			);
			await page.reload();
			await poll(
				async () => (await globalField(page, 'site_title').inputValue()) === 'Globals retry draft',
				'Globals retry survives reload'
			);
		}
	],
	[
		'Posts preserves body focus/caret through idle save and persists frontmatter across reload',
		async (page, root) => {
			await page.goto('/posts?collection=words&post=tidepooling');
			const body = page.locator('.tiptap[contenteditable="true"]');
			await body.fill('Post browser body draft');
			await body.press('End');
			const selection = () =>
				body.evaluate((el) => ({
					active: el.contains(document.activeElement),
					offset: window.getSelection()?.anchorOffset,
					text: el.textContent
				}));
			const before = await selection();
			await poll(
				async () =>
					(await readFile(path.join(root, 'posts/words/tidepooling.md'), 'utf8')).includes(
						'Post browser body draft'
					),
				'Post idle save reaches disk'
			);
			assert.deepEqual(
				await selection(),
				before,
				'Idle save must preserve the body editor selection'
			);
			const title = postField(page, 'title');
			await title.fill('Post browser title');
			await title.press('Tab');
			await poll(
				async () =>
					(await readFile(path.join(root, 'posts/words/tidepooling.md'), 'utf8')).includes(
						'Post browser title'
					),
				'Post frontmatter persists'
			);
			await page.reload();
			await poll(
				async () => (await postField(page, 'title').inputValue()) === 'Post browser title',
				'Post title survives reload'
			);
			assert.equal(await page.locator('.tiptap').textContent(), 'Post browser body draft');
		}
	],
	[
		'Posts retries a failed save and keeps newer text typed during a delayed response',
		async (page, root) => {
			await page.goto('/posts?collection=words&post=tidepooling');
			const title = postField(page, 'title');
			const pattern = '**/api/posts/words/posts/tidepooling';
			await failNextSave(page, pattern, 'PUT');
			await title.fill('Post failed draft');
			await title.press('Tab');
			await page.getByText('Failed to save', { exact: true }).waitFor();
			assert.equal(await title.inputValue(), 'Post failed draft');
			await title.focus();
			await title.press('Tab');
			await poll(
				async () =>
					(await readFile(path.join(root, 'posts/words/tidepooling.md'), 'utf8')).includes(
						'Post failed draft'
					),
				'Post retry reaches disk'
			);
			await page.getByText('Saved', { exact: true }).waitFor();
			await page.unroute(pattern);
			let release;
			let started;
			const gate = new Promise((resolve) => {
				release = resolve;
			});
			const pending = new Promise((resolve) => {
				started = resolve;
			});
			let delayed = false;
			await page.route(pattern, async (route) => {
				if (delayed || route.request().method() !== 'PUT') return route.continue();
				delayed = true;
				const response = await route.fetch();
				started();
				await gate;
				await route.fulfill({ response });
			});
			await title.fill('Post delayed request');
			await title.press('Tab');
			await pending;
			await title.fill('Post after retry');
			release();
			await title.press('Tab');
			await poll(
				async () =>
					(await readFile(path.join(root, 'posts/words/tidepooling.md'), 'utf8')).includes(
						'Post after retry'
					),
				'Post newer draft reaches disk'
			);
		}
	],
	[
		'Records retries a failed save without discarding edits',
		async (page, root) => {
			await page.goto(recordUrl);
			const body = page.locator('#body');
			await failNextSave(page, '**' + recordApi, 'POST');
			await body.fill('Record retry draft');
			await body.press('Tab');
			await page.getByText('Save failed', { exact: true }).waitFor();
			assert.equal(await body.inputValue(), 'Record retry draft');
			await body.focus();
			await body.press('Tab');
			await poll(
				async () =>
					(await json(path.join(root, 'records/notes/data.json'))).records.find(
						(r) => r.id === first
					).body === 'Record retry draft',
				'Record retry reaches disk'
			);
		}
	],
	[
		'linked references edited in a second tab refresh while preserving a local record draft',
		async (page, root) => {
			const classPath = path.join(root, 'media/classes/images.json');
			const typePath = path.join(root, 'records/notes/settings.json');
			const cls = await json(classPath);
			cls.schema.note = {
				type: 'record',
				recordType: 'notes',
				linkedField: 'photos',
				removable: true,
				defaultValue: ''
			};
			const type = await json(typePath);
			type.schema.photos = {
				type: 'file',
				classId: 'images',
				linkedField: 'note',
				multiselect: true,
				removable: true,
				defaultValue: []
			};
			await writeFile(classPath, JSON.stringify(cls));
			await writeFile(typePath, JSON.stringify(type));
			await page.goto(recordUrl);
			const body = page.locator('#body');
			await body.fill('Linked record local draft');
			const other = await page.context().newPage();
			try {
				await other.goto(`/files?class=images&file=${file}`);
				const response = await other.request.patch(`/api/classes/images/records/${file}`, {
					data: { note: first }
				});
				assert.equal(response.status(), 200);
				const refreshed = page.waitForResponse((r) =>
					r.url().includes('/api/media-types/notes/records/list')
				);
				await other.evaluate(() => {
					const channel = new BroadcastChannel('media-manager-refresh');
					channel.postMessage('list');
					channel.close();
				});
				await refreshed;
				assert.equal(await body.inputValue(), 'Linked record local draft');
				const record = (await json(path.join(root, 'records/notes/data.json'))).records.find(
					(r) => r.id === first
				);
				assert.deepEqual(record.photos, [file]);
			} finally {
				await other.close();
			}
			await body.press('Tab');
			await poll(
				async () =>
					(await json(path.join(root, 'records/notes/data.json'))).records.find(
						(r) => r.id === first
					).body === 'Linked record local draft',
				'Local draft persists after linked refresh'
			);
			assert.deepEqual(
				(await json(path.join(root, 'records/notes/data.json'))).records.find((r) => r.id === first)
					.photos,
				[file]
			);
		}
	],
	[
		'Posts queues outgoing edits when switching during a delayed save',
		async (page, root) => {
			const created = await page.request.post('/api/posts/words/posts', {
				data: { slug: 'another', frontmatter: { title: 'Another post' }, body: 'Other body' }
			});
			assert.equal(created.status(), 200);
			await page.goto('/posts?collection=words&post=tidepooling');
			const title = postField(page, 'title');
			let release;
			let started;
			const gate = new Promise((resolve) => {
				release = resolve;
			});
			const pending = new Promise((resolve) => {
				started = resolve;
			});
			let delayed = false;
			await page.route('**/api/posts/words/posts/tidepooling', async (route) => {
				if (delayed || route.request().method() !== 'PUT') return route.continue();
				delayed = true;
				const response = await route.fetch();
				started();
				await gate;
				await route.fulfill({ response });
			});
			try {
				await title.fill('Post outgoing submitted');
				await title.press('Tab');
				await pending;
				await title.fill('Post newest outgoing');
				await page.getByText('Another post', { exact: true }).first().click();
				await poll(
					async () => (await postField(page, 'title').inputValue()) === 'Another post',
					'Second post loads'
				);
				await postField(page, 'title').fill('Post incoming independent');
				release();
				await postField(page, 'title').press('Tab');
				await poll(async () => {
					const before = await readFile(path.join(root, 'posts/words/tidepooling.md'), 'utf8');
					const after = await readFile(path.join(root, 'posts/words/another.md'), 'utf8');
					return (
						before.includes('Post newest outgoing') && after.includes('Post incoming independent')
					);
				}, 'Each post persists its own snapshot after the switch');
			} finally {
				release();
			}
		}
	],
	[
		'Records retains the editor after a failed close-save and closes after retry',
		async (page, root) => {
			await page.goto(recordUrl);
			const body = page.locator('#body');
			let fail = true;
			await page.route('**' + recordApi, async (route) => {
				if (fail && route.request().method() === 'POST')
					return route.fulfill({
						status: 503,
						contentType: 'application/json',
						body: '{"message":"test failure"}'
					});
				await route.continue();
			});
			await body.fill('Keep record after failed close');
			await body.press('Tab');
			await page.getByText('Save failed', { exact: true }).waitFor();
			await page.getByTitle('Close', { exact: true }).click();
			assert.equal(await body.inputValue(), 'Keep record after failed close');
			assert.ok(await body.isVisible());
			await page.getByText('Save failed', { exact: true }).waitFor();
			fail = false;
			await page.getByTitle('Close', { exact: true }).click();
			await poll(
				async () => (await body.count()) === 0,
				'Successful retry closes the record panel'
			);
			assert.equal(
				(await json(path.join(root, 'records/notes/data.json'))).records.find((r) => r.id === first)
					.body,
				'Keep record after failed close'
			);
		}
	],
	[
		'Files retains the editor after a failed close-save and closes after retry',
		async (page, root) => {
			await page.goto(`/files?class=images&file=${file}`);
			const field = page
				.locator('aside')
				.last()
				.locator('div.space-y-0\\.5')
				.filter({ has: page.getByText('caption', { exact: true }) })
				.locator('input, textarea');
			let fail = true;
			await page.route(`**/api/classes/images/records/${file}`, async (route) => {
				if (fail && route.request().method() === 'PATCH')
					return route.fulfill({
						status: 503,
						contentType: 'application/json',
						body: '{"message":"test failure"}'
					});
				await route.continue();
			});
			await field.fill('Keep file after failed close');
			await field.press('Tab');
			await page.getByText('Save failed', { exact: true }).waitFor();
			await page.getByTitle('Close', { exact: true }).click();
			assert.equal(await field.inputValue(), 'Keep file after failed close');
			assert.ok(await field.isVisible());
			await page.getByText('Save failed', { exact: true }).waitFor();
			fail = false;
			await page.getByTitle('Close', { exact: true }).click();
			await poll(async () => (await field.count()) === 0, 'Successful retry closes the file panel');
			assert.equal(
				(await json(path.join(root, 'media/classes/images.json'))).records[file].caption,
				'Keep file after failed close'
			);
		}
	]
];

if (!process.argv.includes('--serve')) await main();
