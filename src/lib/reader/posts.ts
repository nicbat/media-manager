import MarkdownIt from 'markdown-it';
import { createHighlighterCoreSync, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { parseFrontmatter } from './frontmatter.js';

// Bundled languages — a curated common set. A fenced block whose language isn't here falls back to
// unhighlighted plaintext (never throws). Add more by importing them here.
import langJs from '@shikijs/langs/javascript';
import langTs from '@shikijs/langs/typescript';
import langJson from '@shikijs/langs/json';
import langHtml from '@shikijs/langs/html';
import langCss from '@shikijs/langs/css';
import langBash from '@shikijs/langs/bash';
import langPython from '@shikijs/langs/python';
import langMarkdown from '@shikijs/langs/markdown';
import langYaml from '@shikijs/langs/yaml';
import langSvelte from '@shikijs/langs/svelte';
import langRust from '@shikijs/langs/rust';
import langGo from '@shikijs/langs/go';
import langSql from '@shikijs/langs/sql';

// Bundled themes. Hosts pass one of these names via `load(globs, { posts: { theme } })`.
import themeGithubDark from '@shikijs/themes/github-dark';
import themeGithubLight from '@shikijs/themes/github-light';
import themeCatppuccinMocha from '@shikijs/themes/catppuccin-mocha';
import themeCatppuccinLatte from '@shikijs/themes/catppuccin-latte';

/** Theme names the reader bundles for fenced-code highlighting (`posts.theme`). */
export const POSTS_THEMES = [
	'github-dark',
	'github-light',
	'catppuccin-mocha',
	'catppuccin-latte'
] as const;
export type PostsTheme = (typeof POSTS_THEMES)[number];

/** The default fenced-code theme when a host doesn't pass one. */
export const DEFAULT_POSTS_THEME: PostsTheme = 'github-dark';

/** Per-`posts()` options carried on {@link import('./media-manager.js').ReaderOptions}. */
export interface PostsOptions {
	/** Shiki theme for fenced code (must be one of {@link POSTS_THEMES}); defaults to github-dark. */
	theme?: PostsTheme;
}

/**
 * A fully-rendered post (Item 14): frontmatter (with `mm://` file refs resolved to asset URLs) plus
 * finished body HTML (every `mm://` resolved, fenced code Shiki-highlighted).
 *
 * @param collection - The collection id the post lives in.
 * @param slug - The post id (its `.md` filename stem).
 * @param meta - Frontmatter key/values; any `mm://<uuid>` value is resolved to its asset URL.
 * @param html - Rendered body HTML, ready to drop into a page (pair with `media-manager/reader/posts.css`).
 */
export interface PostItem {
	collection: string;
	slug: string;
	meta: Record<string, unknown>;
	html: string;
}

/** How the render pipeline resolves a `mm://<uuid>` reference to a bundler-hashed asset URL. */
export interface PostRenderContext {
	/** Resolve a manifest blob id to its asset URL, or `null` when unknown/missing. */
	resolveFile(id: string): string | null;
}

const MM_REF_RE =
	/mm:\/\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/g;

/**
 * A single shared sync highlighter across all readers (langs + themes are fixed at module load, so
 * one instance is safe and cheap). Created lazily on the first post render so a host that never calls
 * `posts()` pays nothing at runtime. Uses Shiki's **synchronous** core + the pure-JS regex engine, so
 * it composes with the reader's non-async `load()` contract.
 */
let sharedHighlighter: HighlighterCore | null = null;
function getHighlighter(): HighlighterCore {
	if (!sharedHighlighter) {
		sharedHighlighter = createHighlighterCoreSync({
			engine: createJavaScriptRegexEngine(),
			themes: [
				themeGithubDark,
				themeGithubLight,
				themeCatppuccinMocha,
				themeCatppuccinLatte
			] as any,
			langs: [
				langJs,
				langTs,
				langJson,
				langHtml,
				langCss,
				langBash,
				langPython,
				langMarkdown,
				langYaml,
				langSvelte,
				langRust,
				langGo,
				langSql
			] as any
		});
	}
	return sharedHighlighter;
}

/**
 * markdown-it renderer plugin: make **external** links (absolute `http(s)://`) open in a new tab so a
 * link to another site clicks *outside* the site rather than replacing it; internal / relative links
 * stay in-tab. Render-only — the stored markdown is untouched. Mirrors the editor Preview's rule
 * (`components/posts/renderPreview.ts`) so a post ships the same as it previews. Duplicated here (not
 * imported) to keep the reader package self-contained.
 */
function externalLinkTargets(md: MarkdownIt): void {
	const base =
		md.renderer.rules.link_open ??
		((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
	md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
		const href = tokens[idx].attrGet('href') ?? '';
		if (/^https?:\/\//i.test(href)) {
			tokens[idx].attrSet('target', '_blank');
			tokens[idx].attrSet('rel', 'noopener noreferrer');
		}
		return base(tokens, idx, options, env, self);
	};
}

/** HTML-escape for the plaintext fallback path (no highlighter language match). */
function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/**
 * Build a markdown-it renderer whose fenced-code path is Shiki-highlighted with `theme`. `html: true`
 * lets the self-contained `mm-*` islands pass through verbatim. A fenced block whose language isn't
 * bundled degrades to an escaped `<pre><code>` rather than throwing.
 */
function makeRenderer(theme: PostsTheme): MarkdownIt {
	const hl = getHighlighter();
	const loaded = new Set(hl.getLoadedLanguages());
	const md: MarkdownIt = new MarkdownIt({
		html: true,
		linkify: true,
		highlight(code: string, lang: string): string {
			const language = lang && loaded.has(lang) ? lang : null;
			if (!language) {
				return `<pre class="shiki-plain"><code>${escapeHtml(code)}</code></pre>`;
			}
			try {
				return hl.codeToHtml(code, { lang: language, theme });
			} catch {
				return `<pre class="shiki-plain"><code>${escapeHtml(code)}</code></pre>`;
			}
		}
	});
	externalLinkTargets(md);
	return md;
}

/** Replace every resolvable `mm://<uuid>` in a string with its asset URL; leave unresolved refs intact. */
function resolveMmRefs(text: string, ctx: PostRenderContext): string {
	return text.replace(MM_REF_RE, (whole, id: string) => ctx.resolveFile(id) ?? whole);
}

/** Resolve `mm://<uuid>` frontmatter values to asset URLs (non-ref values pass through untouched). */
function resolveMeta(
	frontmatter: Record<string, unknown>,
	ctx: PostRenderContext
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(frontmatter)) {
		if (typeof v === 'string' && v.startsWith('mm://')) {
			out[k] = resolveMmRefs(v, ctx);
		} else {
			out[k] = v;
		}
	}
	return out;
}

/** Render one raw `.md` string into a finished {@link PostItem}. */
function renderPost(
	collection: string,
	slug: string,
	raw: string,
	md: MarkdownIt,
	ctx: PostRenderContext
): PostItem {
	const { frontmatter, body } = parseFrontmatter(raw);
	const html = resolveMmRefs(md.render(body), ctx);
	return { collection, slug, meta: resolveMeta(frontmatter, ctx), html };
}

/**
 * A lazily-rendered, read-only view over one collection's posts (Item 14). Posts are parsed +
 * rendered on first access and memoized. `all()` is sorted by frontmatter `date` desc (undated last).
 */
export class PostCollection {
	private readonly collection: string;
	private readonly rawBySlug: Record<string, string>;
	private readonly ctx: PostRenderContext;
	private readonly md: MarkdownIt;
	private readonly cache = new Map<string, PostItem>();

	constructor(
		collection: string,
		rawBySlug: Record<string, string>,
		ctx: PostRenderContext,
		theme: PostsTheme
	) {
		this.collection = collection;
		this.rawBySlug = rawBySlug;
		this.ctx = ctx;
		this.md = makeRenderer(theme);
	}

	/** Render (memoized) one post by slug, or `undefined` if the slug isn't in the collection. */
	bySlug(slug: string): PostItem | undefined {
		if (this.cache.has(slug)) return this.cache.get(slug);
		const raw = this.rawBySlug[slug];
		if (raw == null) return undefined;
		const item = renderPost(this.collection, slug, raw, this.md, this.ctx);
		this.cache.set(slug, item);
		return item;
	}

	/** Every post in the collection, sorted by frontmatter `date` desc when present, then slug. */
	all(): PostItem[] {
		const items = Object.keys(this.rawBySlug)
			.map((slug) => this.bySlug(slug))
			.filter((p): p is PostItem => p != null);
		items.sort((a, b) => {
			const da = a.meta.date != null ? String(a.meta.date) : '';
			const db = b.meta.date != null ? String(b.meta.date) : '';
			if (da && db) return da < db ? 1 : da > db ? -1 : 0;
			if (da) return -1;
			if (db) return 1;
			return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
		});
		return items;
	}
}
