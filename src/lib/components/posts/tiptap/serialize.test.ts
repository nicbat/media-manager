import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getSchema } from '@tiptap/core';
import { parseFrontmatter } from '../../../storage/frontmatter.js';
import { postExtensions } from './extensions.js';
import { docToMarkdown, markdownToDoc } from './serialize.js';

/**
 * Round-trip fidelity of the markdown ↔ ProseMirror-doc bridge — the load-bearing Phase-3 seam. These
 * assert the two guarantees the spike locked: `md → doc → md` is **byte-stable** and **idempotent**
 * for prose, `mm-*` islands, and fenced code, so opening + saving a post never silently rewrites it.
 */

const schema = getSchema(postExtensions());
const rt = (md: string) => docToMarkdown(markdownToDoc(md, schema));

describe('posts markdown round-trip', () => {
	it('is byte-stable + idempotent on the golden sample body', () => {
		const raw = readFileSync(
			resolve(process.cwd(), 'test-fixtures/posts/words/tidepooling.md'),
			'utf8'
		);
		const { body } = parseFrontmatter(raw);
		const once = rt(body);
		expect(once).toBe(body.trimEnd());
		expect(rt(once)).toBe(once); // idempotent
	});

	it('preserves inline marks (bold/italic/code/link/strike)', () => {
		const md =
			'A **bold**, *italic*, `code`, ~~struck~~ and a [link](https://example.com) in one line.';
		expect(rt(md)).toBe(md);
	});

	it('preserves an inline mm:// image', () => {
		const md = '![alt text](mm://e3c2cf9d-d01d-480c-b0e4-d1843a7d9dc3)';
		expect(rt(md)).toBe(md);
	});

	it('preserves a fenced code block with language', () => {
		const md = ['```ts', 'const x: number = 1;', 'console.log(x);', '```'].join('\n');
		expect(rt(md)).toBe(md);
	});

	it('keeps each mm-* island as one opaque atom (verbatim)', () => {
		const islands = [
			'<figure class="mm-inline">\n  <img src="mm://11111111-1111-1111-1111-111111111111" alt="A">\n  <figcaption>Cap</figcaption>\n</figure>',
			'<figure class="mm-bleed">\n  <img src="mm://22222222-2222-2222-2222-222222222222" alt="">\n</figure>',
			'<div class="mm-beside" data-side="left">\n  <div class="mm-text"><p>Beside prose</p></div>\n  <figure><img src="mm://33333333-3333-3333-3333-333333333333" alt=""></figure>\n</div>',
			'<div class="mm-pair">\n  <figure><img src="mm://44444444-4444-4444-4444-444444444444" alt=""><figcaption>A</figcaption></figure>\n  <figure><img src="mm://55555555-5555-5555-5555-555555555555" alt=""><figcaption>B</figcaption></figure>\n</div>'
		];
		for (const island of islands) {
			expect(rt(island)).toBe(island);
			expect(rt(rt(island))).toBe(rt(island));
		}
	});

	it('round-trips lists + headings + blockquote', () => {
		const md = [
			'## Heading',
			'',
			'> A quote',
			'',
			'- one',
			'- two',
			'',
			'1. first',
			'2. second'
		].join('\n');
		expect(rt(md)).toBe(md);
	});
});
