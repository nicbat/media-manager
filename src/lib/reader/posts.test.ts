import { describe, it, expect } from 'vitest';
import { MediaManager, type ParsedWorkspace } from './media-manager.js';

/**
 * Reader posts() tests (Item 14) — driven through `fromParsed` against inline parsed fixtures (no
 * `fs`/network), asserting `mm://` resolution in frontmatter + inline images + HTML islands, Shiki
 * highlighting of fenced code, island passthrough, and date-desc ordering.
 */

const COVER = 'aaaaaaaa-0000-4000-8000-000000000001';
const INLINE = 'bbbbbbbb-0000-4000-8000-000000000002';
const ISLAND = 'cccccccc-0000-4000-8000-000000000003';

const tidepooling = `---
title: Tidepooling
date: 2026-07-07
cover: mm://${COVER}
---

## Seeing the Unseen

Life looks **barren** until it reveals itself.

![A shrimp](mm://${INLINE})

<div class="mm-beside" data-side="right">
  <div class="mm-text"><p>Every cliffside hides its own world.</p></div>
  <figure><img src="mm://${ISLAND}" alt="A tidepool"></figure>
</div>

\`\`\`bash
echo hi
\`\`\`
`;

const older = `---
title: Older
date: 2020-01-01
---

Old post.
`;

function fixture(): ParsedWorkspace {
	return {
		manifest: {
			version: 2,
			files: {
				[COVER]: { file_name: 'cover.jpg', classes: [], missing: false },
				[INLINE]: { file_name: 'shrimp.jpg', classes: [], missing: false },
				[ISLAND]: { file_name: 'pool.jpg', classes: [], missing: false }
			}
		},
		posts: {
			words: { tidepooling, older }
		},
		assets: {
			'cover.jpg': '/assets/cover.hash.jpg',
			'shrimp.jpg': '/assets/shrimp.hash.jpg',
			'pool.jpg': '/assets/pool.hash.jpg'
		}
	};
}

describe('reader posts()', () => {
	it('resolves mm:// in frontmatter, inline images, and islands', () => {
		const mm = MediaManager.fromParsed(fixture());
		const post = mm.posts('words').bySlug('tidepooling');
		expect(post).toBeDefined();
		// Frontmatter cover ref resolved to the hashed asset URL.
		expect(post!.meta.cover).toBe('/assets/cover.hash.jpg');
		expect(post!.meta.title).toBe('Tidepooling');
		// Inline image + island src both rewritten; no mm:// survives.
		expect(post!.html).toContain('/assets/shrimp.hash.jpg');
		expect(post!.html).toContain('/assets/pool.hash.jpg');
		expect(post!.html).not.toContain('mm://');
		// Island passed through verbatim (class + data-side preserved).
		expect(post!.html).toContain('class="mm-beside"');
		expect(post!.html).toContain('data-side="right"');
		// Prose marks rendered.
		expect(post!.html).toContain('<strong>barren</strong>');
	});

	it('highlights fenced code with Shiki', () => {
		const mm = MediaManager.fromParsed(fixture());
		const post = mm.posts('words').bySlug('tidepooling')!;
		expect(post.html).toContain('class="shiki');
		expect(post.html).toContain('<span'); // token spans from highlighting
	});

	it('sorts all() by date desc', () => {
		const mm = MediaManager.fromParsed(fixture());
		const slugs = mm
			.posts('words')
			.all()
			.map((p) => p.slug);
		expect(slugs).toEqual(['tidepooling', 'older']);
	});

	it('leaves an unresolved mm:// ref intact', () => {
		const fx = fixture();
		// Point cover at a blob that isn't in the manifest.
		fx.posts!.words.tidepooling = tidepooling.replace(
			COVER,
			'dddddddd-0000-4000-8000-000000000009'
		);
		const mm = MediaManager.fromParsed(fx);
		const post = mm.posts('words').bySlug('tidepooling')!;
		expect(post.meta.cover).toBe('mm://dddddddd-0000-4000-8000-000000000009');
	});

	it('applies a bundled theme option', () => {
		const mm = MediaManager.fromParsed(fixture(), { posts: { theme: 'catppuccin-mocha' } });
		const post = mm.posts('words').bySlug('tidepooling')!;
		expect(post.html).toContain('class="shiki');
	});

	it('unknown collection yields an empty view', () => {
		const mm = MediaManager.fromParsed(fixture());
		expect(mm.posts('nope').all()).toEqual([]);
		expect(mm.posts('nope').bySlug('x')).toBeUndefined();
	});

	it('load() classifies a posts ?raw glob by path', () => {
		const mm = MediaManager.load({
			data: { '/ws/media/manifest.json': { version: 2, files: {} } },
			files: {},
			posts: { '/ws/posts/words/hello.md': '---\ntitle: Hello\n---\n\nHi.\n' }
		});
		expect(mm.postCollections()).toEqual(['words']);
		expect(mm.posts('words').bySlug('hello')!.meta.title).toBe('Hello');
	});
});
