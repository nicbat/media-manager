/**
 * Validate backlog readiness, file pointers, immutable IDs, and the triage board mirror.
 * Run with --write to regenerate the board's embedded data after editing the backlog.
 * This deliberately checks metadata rather than treating plans as proof of shipped behavior.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backlog = fs.readFileSync(path.join(root, 'docs/FUTURE_CHANGES.md'), 'utf8');
const boardPath = path.join(root, 'docs/FUTURE_CHANGES_TRIAGE.html');
let board = fs.readFileSync(boardPath, 'utf8');
const groups = {
	'npx-package vision': 'npx',
	'Data model & fields': 'fields',
	'Media kinds & preview': 'kinds',
	'Grid & display': 'grid',
	'Asset pipeline & deps': 'assets',
	'Bulk & schema utilities': 'bulk',
	Integrations: 'integrations',
	'Storage & routing — design': 'storage',
	'Misc fixes & polish': 'misc',
	'Reliability & release confidence': 'reliability'
};
const items = [];
const failures = [];
const [active, archive] = backlog.split('## Shipped & folded');
if (!archive) throw new Error('Missing shipped archive');
for (const cluster of active.matchAll(/^## Cluster: (.+)\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)) {
	const group = groups[cluster[1]];
	if (!group) failures.push(`Unknown cluster: ${cluster[1]}`);
	for (const item of cluster[2].matchAll(/^### (\d+) · (.+)\n([\s\S]*?)(?=^### |$(?![\s\S]))/gm)) {
		const n = Number(item[1]);
		const block = /```yaml\n([\s\S]*?)```/.exec(item[3]);
		if (!block) throw new Error(`Item ${n}: missing YAML`);
		const data = YAML.parse(block[1]);
		const required = [
			'status',
			'size',
			'usefulness',
			'priority',
			'files',
			'depends_on',
			'open_questions',
			'acceptance'
		];
		if (
			required.some((key) => !(key in data)) ||
			Object.keys(data).some((key) => !required.includes(key))
		) {
			failures.push(`Item ${n}: metadata must contain exactly ${required.join(', ')}`);
		}
		if (!['ready', 'blocked', 'discussion'].includes(data.status))
			failures.push(`Item ${n}: invalid active status`);
		if ((data.status === 'ready') !== (data.open_questions === 0))
			failures.push(`Item ${n}: readiness/open_questions mismatch`);
		if (!['S', 'M', 'L'].includes(data.size) || !['low', 'medium', 'high'].includes(data.priority))
			failures.push(`Item ${n}: invalid size/priority`);
		if (!Number.isInteger(data.usefulness) || data.usefulness < 1 || data.usefulness > 5)
			failures.push(`Item ${n}: invalid usefulness`);
		if (!Number.isInteger(data.open_questions) || data.open_questions < 0)
			failures.push(`Item ${n}: invalid question count`);
		if (
			!Array.isArray(data.files) ||
			!data.files.length ||
			!Array.isArray(data.acceptance) ||
			!data.acceptance.length ||
			!Array.isArray(data.depends_on)
		)
			throw new Error(`Item ${n}: expected files, acceptance, depends_on arrays`);
		for (const file of data.files)
			if (!fs.existsSync(path.resolve(root, file))) failures.push(`Item ${n}: missing ${file}`);
		items.push({
			n,
			name: item[2],
			status: data.status,
			size: data.size,
			use: data.usefulness,
			group,
			oq: data.open_questions,
			prio: data.priority,
			stale: false,
			deps: data.depends_on,
			note: data.acceptance.join(' · ')
		});
	}
}
for (const row of archive.matchAll(/^\|\s*(\d+)\s*\|\s*([^|]+)\|/gm)) {
	items.push({
		n: Number(row[1]),
		name: row[2].trim(),
		status: 'shipped',
		size: null,
		use: 0,
		group: 'archive',
		oq: 0,
		stale: false,
		note: 'Shipped or folded. See the archive in FUTURE_CHANGES.md and the feature registry for actual behavior and remaining scope.'
	});
}
const ids = new Set(items.map((item) => item.n));
if (ids.size !== items.length) failures.push('Duplicate item IDs');
for (let n = 0; n <= Math.max(...ids); n++)
	if (!ids.has(n)) failures.push(`Missing immutable item ID ${n}`);
for (const item of items)
	for (const id of item.deps ?? [])
		if (!ids.has(id)) failures.push(`Item ${item.n}: missing dependency ${id}`);
if (failures.length) throw new Error(failures.join('\n'));
const pattern = /const ITEMS = \[[\s\S]*?\n\s*\];/;
if (process.argv.includes('--write')) {
	board = board.replace(pattern, `const ITEMS = ${JSON.stringify(items, null, '\t')};`);
	board = board.replace(/\d+ items classified/, `${items.length} items classified`);
	fs.writeFileSync(boardPath, board);
} else {
	const match = board.match(pattern);
	if (
		!match ||
		JSON.stringify(JSON.parse(match[0].slice('const ITEMS = '.length, -1))) !==
			JSON.stringify(items)
	)
		throw new Error('Triage board differs; run node scripts/check-plans.mjs --write');
	if (!board.includes(`${items.length} items classified`))
		throw new Error('Triage board count differs');
}
console.log(
	`Planning metadata valid: ${items.length} IDs (${items.filter((i) => i.status !== 'shipped').length} active); board synchronized.`
);
