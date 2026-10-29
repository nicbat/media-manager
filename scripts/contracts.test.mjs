import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(repo, 'bin/media-manager.js');
const recordId = '55555555-5555-4555-8555-555555555555';
const absentId = '99999999-9999-4999-8999-999999999999';
const env = { ...process.env };
for (const key of Object.keys(env)) {
	if (key.startsWith('MEDIA_MANAGER_') || ['PORT', 'HOST', 'ORIGIN'].includes(key)) delete env[key];
}

/** Own every test workspace and remove it after all child servers have stopped. */
function fixture(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-contract-'));
	fs.cpSync(path.join(repo, 'test-fixtures'), path.join(root, 'workspace'), { recursive: true });
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	return root;
}

/** Invoke the actual CLI from a consumer directory with a controlled root/config environment. */
function invoke(cwd, args, extraEnv = {}) {
	const result = spawnSync(process.execPath, [cli, ...args], {
		cwd,
		env: { ...env, ...extraEnv },
		encoding: 'utf8',
		timeout: 15_000
	});
	assert.ifError(result.error);
	return result;
}

/** Start the actual CLI on port 0; stop its entire owned process group even on assertion failure. */
async function serve(t, cwd, args = [], extraEnv = {}) {
	const child = spawn(process.execPath, [cli, ...args, '--port', '0', '--no-open'], {
		cwd,
		env: { ...env, ...extraEnv, HOST: '127.0.0.1' },
		stdio: 'pipe',
		detached: process.platform !== 'win32'
	});
	let output = '';
	child.stdout.on('data', (chunk) => (output += chunk));
	child.stderr.on('data', (chunk) => (output += chunk));
	let stopped = false;
	const exited = once(child, 'exit');
	const stop = async () => {
		if (stopped) return;
		stopped = true;
		if (child.exitCode === null && child.signalCode === null) {
			if (process.platform === 'win32')
				spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
			else process.kill(-child.pid, 'SIGTERM');
		}
		await exited;
	};
	t.after(stop);
	const url = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`CLI readiness timeout: ${output}`)), 20_000);
		child.stdout.on('data', () => {
			const match = output.match(/Listening on (http:\/\/[^\s]+)/);
			if (match) {
				clearTimeout(timer);
				resolve(match[1]);
			}
		});
		child.once('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once('exit', (code) => {
			clearTimeout(timer);
			reject(new Error(`CLI exited ${code}: ${output}`));
		});
	});
	assert.notEqual(new URL(url).port, '0', 'Readiness reports the actually bound ephemeral port');
	return { url, stop };
}

/** Keep requests bounded and include server error text in failing status assertions. */
async function request(url, route, status = 200, options = {}) {
	const response = await fetch(url + route, { ...options, signal: AbortSignal.timeout(10_000) });
	const text = await response.text();
	assert.equal(response.status, status, `${options.method || 'GET'} ${route}: ${text}`);
	return text;
}

test('CLI resolves arg > env > config and walks relative config paths from nested directories', (t) => {
	const root = fixture(t);
	for (const dir of ['environment', 'argument', 'nested/deep'])
		fs.mkdirSync(path.join(root, dir), { recursive: true });
	fs.writeFileSync(path.join(root, 'media-manager.config.json'), '{"root":"./workspace"}');
	const cwd = path.join(root, 'nested/deep');
	for (const [args, overrides, expected] of [
		[['doctor'], {}, 'workspace'],
		[['doctor'], { MEDIA_MANAGER_ROOT: path.join(root, 'environment') }, 'environment'],
		[
			['doctor', path.join(root, 'argument')],
			{ MEDIA_MANAGER_ROOT: path.join(root, 'environment') },
			'argument'
		]
	]) {
		const result = invoke(cwd, args, overrides);
		assert.equal(result.status, 0, result.stderr);
		assert.ok(result.stdout.includes(path.join(root, expected)), result.stdout);
	}
	fs.writeFileSync(path.join(root, 'media-manager.config.json'), '{broken');
	const malformed = invoke(cwd, ['doctor']);
	assert.equal(malformed.status, 1);
	assert.match(malformed.stderr, /Invalid JSON/);
	fs.writeFileSync(path.join(root, 'media-manager.config.json'), '{"root":"./absent"}');
	assert.equal(invoke(cwd, ['doctor']).status, 1);
});

test('CLI serves a config-discovered root on an ephemeral port and cleans up its child server', async (t) => {
	const root = fixture(t);
	fs.writeFileSync(path.join(root, 'media-manager.config.json'), '{"root":"./workspace"}');
	const { url, stop } = await serve(t, root);
	await request(url, '/api/files');
	await stop();
	await assert.rejects(fetch(url + '/api/files', { signal: AbortSignal.timeout(1000) }));
});

test('HTTP rejects invalid IDs, traversal, invalid payloads and malformed JSON without modifying records', async (t) => {
	const root = fixture(t);
	const workspace = path.join(root, 'workspace');
	const original = fs.readFileSync(path.join(workspace, 'records/notes/data.json'), 'utf8');
	const { url } = await serve(t, root, [workspace]);
	await request(url, '/api/files/not-an-id/blob', 400);
	await request(url, `/api/files/${absentId}/blob`, 404);
	await request(url, `/api/media-types/notes/records/by-id/${absentId}`, 404);
	const traversal = await fetch(url + `/api/media-types/..%2Foutside/records/by-id/${recordId}`);
	assert.ok(
		[400, 404].includes(traversal.status),
		`Traversal must be rejected: ${traversal.status}`
	);
	for (const body of ['{"ids":[]}', '{broken']) {
		await request(url, '/api/files/delete', 400, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body
		});
	}
	for (const body of ['[]', '{broken']) {
		await request(url, `/api/media-types/notes/records/by-id/${recordId}`, 400, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body
		});
	}
	for (const [route, method] of [
		['/api/media-types/globals/record', 'POST'],
		['/api/classes/images/members', 'POST'],
		['/api/posts/words/posts/tidepooling', 'PUT']
	])
		await request(url, route, 400, {
			method,
			headers: { 'content-type': 'application/json' },
			body: '{broken'
		});
	assert.equal(fs.readFileSync(path.join(workspace, 'records/notes/data.json'), 'utf8'), original);
});

test('CLI export reunites static originals and derivatives, excludes secrets and reopens with references intact', async (t) => {
	const root = fixture(t);
	const source = path.join(root, 'workspace');
	const assets = path.join(root, 'assets');
	const dest = path.join(root, 'exported');
	fs.cpSync(path.join(source, 'media/files'), assets, { recursive: true });
	fs.writeFileSync(path.join(assets, 'foreign.txt'), 'not a manifest blob');
	const manifestPath = path.join(source, 'media/manifest.json');
	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	const [id, entry] = Object.entries(manifest.files)[0];
	entry.derived = { preview: { file_name: 'preview.webp', recipe: 'webp:q80', size: 5 } };
	fs.mkdirSync(path.join(assets, 'derived/preview'), { recursive: true });
	fs.writeFileSync(path.join(assets, 'derived/preview/preview.webp'), 'small');
	fs.writeFileSync(manifestPath, JSON.stringify(manifest));
	fs.writeFileSync(path.join(source, 'media/google.json'), '{"refresh_token":"test-only-secret"}');
	fs.writeFileSync(path.join(source, 'unused.lock'), 'lock');
	fs.writeFileSync(
		path.join(root, 'media-manager.config.json'),
		JSON.stringify({ root: './workspace', assets: { dir: './assets', baseUrl: '/media' } })
	);
	const result = invoke(root, ['export', dest]);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	for (const blob of Object.values(manifest.files)) {
		assert.deepEqual(
			fs.readFileSync(path.join(dest, 'media/files', blob.file_name)),
			fs.readFileSync(path.join(assets, blob.file_name))
		);
	}
	for (const relative of [
		'media/manifest.json',
		'media/classes/images.json',
		'records/notes/data.json',
		'globals/data.json'
	]) {
		assert.deepEqual(
			fs.readFileSync(path.join(source, relative)),
			fs.readFileSync(path.join(dest, relative))
		);
	}
	assert.equal(
		fs.readFileSync(path.join(dest, 'media/derived/preview/preview.webp'), 'utf8'),
		'small'
	);
	for (const relative of ['media/google.json', 'unused.lock', 'media/files/foreign.txt'])
		assert.ok(!fs.existsSync(path.join(dest, relative)));
	const { url } = await serve(t, root, [dest], { MEDIA_MANAGER_CONFIG_PATH: '' });
	const record = JSON.parse(await request(url, `/api/media-types/notes/records/by-id/${recordId}`));
	assert.equal(record.id, recordId);
	const blob = await fetch(`${url}/api/files/${id}/blob`);
	assert.equal(blob.status, 200);
	assert.deepEqual(
		Buffer.from(await blob.arrayBuffer()),
		fs.readFileSync(path.join(assets, entry.file_name))
	);
});

test('malformed on-disk JSON fails visibly and stays byte-for-byte intact', async (t) => {
	const root = fixture(t);
	const source = path.join(root, 'workspace');
	const data = path.join(source, 'records/notes/data.json');
	fs.writeFileSync(data, '{"records":[');
	const { url } = await serve(t, root, [source]);
	await request(url, '/api/media-types/notes/records/list', 500);
	assert.equal(fs.readFileSync(data, 'utf8'), '{"records":[');
});

test('CLI export refuses a truncated manifest instead of reporting a successful JSON-only export', (t) => {
	const root = fixture(t);
	const source = path.join(root, 'workspace');
	const manifest = path.join(source, 'media/manifest.json');
	fs.writeFileSync(manifest, '{"files":');
	const result = invoke(root, ['export', path.join(root, 'exported')], {
		MEDIA_MANAGER_ROOT: source
	});
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.match(result.stderr, /manifest/i);
	assert.equal(fs.readFileSync(manifest, 'utf8'), '{"files":');
});
