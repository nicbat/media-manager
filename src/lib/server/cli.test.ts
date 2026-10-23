import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('CLI build detection and package diagnostics', () => {
	let root: string;
	let cli: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-cli-package-'));
		fs.mkdirSync(path.join(root, 'bin'));
		fs.mkdirSync(path.join(root, 'workspace'));
		fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
		cli = path.join(root, 'bin/media-manager.js');
		fs.copyFileSync('bin/media-manager.js', cli);
	});

	afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

	/** Run only against this fake package and disposable workspace; never launch a real build. */
	function invoke(...args: string[]) {
		const result = spawnSync(process.execPath, [cli, ...args], {
			cwd: root,
			encoding: 'utf8',
			env: { ...process.env, MEDIA_MANAGER_ROOT: path.join(root, 'workspace') },
			timeout: 10_000
		});
		expect(result.error).toBeUndefined();
		return result;
	}

	it.each(['absent', 'empty'])('fails doctor for an %s build with reinstall guidance', (state) => {
		if (state === 'empty') fs.mkdirSync(path.join(root, 'build'));
		const result = invoke('doctor');
		expect(result.status).toBe(1);
		expect(result.stdout).toContain('incomplete installed package');
		expect(result.stderr).toContain('Reinstall media-manager');
	});

	it.each([['serve'], ['build'], ['serve', '--rebuild']])(
		'refuses %s without source before attempting npm/Vite',
		(...args) => {
			const result = invoke(...args);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain('Missing editor build (build/index.js)');
			expect(result.stderr).toContain('prepare lifecycle');
			expect(result.stdout).not.toMatch(/building|vite/i);
		}
	);

	it('keeps build-on-demand working in a full source checkout', () => {
		for (const file of ['src/app.html', 'vite.config.ts', 'svelte.config.js']) {
			fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
			fs.writeFileSync(path.join(root, file), '');
		}
		fs.writeFileSync(
			path.join(root, 'package.json'),
			JSON.stringify({ type: 'module', scripts: { build: 'node build-stub.js' } })
		);
		fs.writeFileSync(
			path.join(root, 'build-stub.js'),
			`import fs from 'node:fs';
fs.mkdirSync('build', { recursive: true });
fs.writeFileSync('build/index.js', 'console.log("source build served");');`
		);
		const result = invoke('serve', '--no-open');
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('building once');
		expect(result.stdout).toContain('source build served');
	});

	it('reports a prepared package as built, but refuses an explicit rebuild without source', () => {
		fs.mkdirSync(path.join(root, 'build'));
		fs.writeFileSync(path.join(root, 'build/index.js'), '');
		const doctor = invoke('doctor');
		expect(doctor.status).toBe(0);
		expect(doctor.stdout).toMatch(/build\s+present/);
		const result = invoke('build');
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('Cannot rebuild this installed package');
	});
});
