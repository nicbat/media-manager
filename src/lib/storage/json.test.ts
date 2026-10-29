import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readJsonFile, writeJsonFileAtomic } from './json.js';
import { withFileLock } from './lock.js';

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>();
	return { ...actual, rename: vi.fn(actual.rename) };
});

describe('JSON and lock recovery boundaries', () => {
	let root: string;
	let file: string;
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'mm-json-recovery-'));
		file = path.join(root, 'data.json');
	});
	afterEach(async () => {
		vi.clearAllMocks();
		await fs.rm(root, { recursive: true, force: true });
	});

	it('reports truncated JSON without replacing or healing the source', async () => {
		await fs.writeFile(file, '{"records":[');
		await expect(readJsonFile(file)).rejects.toThrow(SyntaxError);
		expect(await fs.readFile(file, 'utf8')).toBe('{"records":[');
	});

	it('preserves confirmed data and removes staging files after an interrupted replacement', async () => {
		await writeJsonFileAtomic(file, { confirmed: true });
		vi.mocked(fs.rename).mockRejectedValueOnce(new Error('simulated interrupted rename'));
		await expect(writeJsonFileAtomic(file, { confirmed: false })).rejects.toThrow('interrupted');
		expect(await readJsonFile(file)).toEqual({ confirmed: true });
		expect(await fs.readdir(root)).toEqual(['data.json']);
		await writeJsonFileAtomic(file, { recovered: true });
		expect(await readJsonFile(file)).toEqual({ recovered: true });
	});

	it('serializes contending read/modify/write operations without losing updates', async () => {
		await writeJsonFileAtomic(file, { count: 0 });
		await Promise.all(
			Array.from({ length: 12 }, () =>
				withFileLock(file + '.lock', async () => {
					const state = (await readJsonFile(file)) as { count: number };
					await writeJsonFileAtomic(file, { count: state.count + 1 });
				})
			)
		);
		expect(await readJsonFile(file)).toEqual({ count: 12 });
		expect(await fs.readdir(root)).toEqual(['data.json']);
	});

	it('releases a failed operation lock and recovers a stale lock', async () => {
		await expect(
			withFileLock(file + '.lock', async () => {
				throw new Error('operation failed');
			})
		).rejects.toThrow('operation failed');
		await fs.writeFile(file + '.lock', 'stale');
		const old = new Date(Date.now() - 20_000);
		await fs.utimes(file + '.lock', old, old);
		await withFileLock(file + '.lock', () => writeJsonFileAtomic(file, { recovered: true }));
		expect(await readJsonFile(file)).toEqual({ recovered: true });
		expect(await fs.readdir(root)).toEqual(['data.json']);
	});
});
