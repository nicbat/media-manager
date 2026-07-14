import { describe, expect, it } from 'vitest';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter.js';

describe('frontmatter — parse/serialize', () => {
	it('parses a standard frontmatter block + body', () => {
		const raw = `---\ntitle: Hello\ndate: 2026-07-07\ndraft: false\n---\n\n## Body\n\nProse.\n`;
		const { frontmatter, body } = parseFrontmatter(raw);
		expect(frontmatter.title).toBe('Hello');
		expect(frontmatter.draft).toBe(false);
		expect(body).toBe('## Body\n\nProse.\n');
	});

	it('returns empty frontmatter when there is no fence', () => {
		const raw = '# Just a body\n\nNo frontmatter here.';
		const { frontmatter, body } = parseFrontmatter(raw);
		expect(frontmatter).toEqual({});
		expect(body).toBe(raw);
	});

	it('keeps mm:// file refs verbatim through a round-trip', () => {
		const uuid = '82b2c224-e1e8-4960-b084-33c675e8217f';
		const fm = { title: 'Cover test', cover: `mm://${uuid}` };
		const body = 'Body text.\n';
		const serialized = serializeFrontmatter(fm, body);
		expect(serialized).toContain(`cover: mm://${uuid}`);
		const parsed = parseFrontmatter(serialized);
		expect(parsed.frontmatter.cover).toBe(`mm://${uuid}`);
		expect(parsed.body).toBe(body);
	});

	it('is idempotent: parse → serialize → parse yields the same frontmatter + body', () => {
		const fm = { title: 'Round trip', date: '2026-07-07', description: 'A: colon, and more' };
		const body = 'Line one\n\nLine two\n';
		const once = serializeFrontmatter(fm, body);
		const parsed = parseFrontmatter(once);
		expect(parsed.frontmatter).toEqual(fm);
		expect(parsed.body).toBe(body);
		const twice = serializeFrontmatter(parsed.frontmatter, parsed.body);
		expect(twice).toBe(once);
	});

	it('emits no fence for empty frontmatter', () => {
		expect(serializeFrontmatter({}, 'just a body')).toBe('just a body');
	});
});
