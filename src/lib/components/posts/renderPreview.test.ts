import { describe, it, expect } from 'vitest';
import { renderPostPreview } from './renderPreview.js';

/**
 * External-link targeting (Item 14): absolute `http(s)://` links open in a new tab so a link clicks
 * *outside* the site; internal / relative links stay in-tab. Render-only — the stored markdown is
 * untouched (covered by the serializer round-trip tests), so we only assert the rendered `<a>` attrs.
 */
describe('renderPostPreview — external link targeting', () => {
	it('adds target=_blank + rel to absolute http(s) links', () => {
		const html = renderPostPreview('See [iNaturalist](https://inaturalist.org).');
		expect(html).toContain('href="https://inaturalist.org"');
		expect(html).toContain('target="_blank"');
		expect(html).toContain('rel="noopener noreferrer"');
	});

	it('leaves internal / relative / anchor / mailto links in-tab', () => {
		for (const md of ['[about](/about)', '[jump](#section)', '[mail](mailto:a@b.co)']) {
			const html = renderPostPreview(md);
			expect(html).not.toContain('target="_blank"');
		}
	});
});
