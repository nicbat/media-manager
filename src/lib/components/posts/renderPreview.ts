import MarkdownIt from 'markdown-it';

/**
 * A `mm://<uuid>` reference. The uuid is a manifest blob id (see `manifest.ts`).
 * Matches the on-disk form used everywhere in post bodies + frontmatter.
 */
const MM_REF_RE =
	/mm:\/\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/g;

/**
 * markdown-it renderer plugin: make **external** links (absolute `http(s)://`) open in a new tab, so a
 * link to another site clicks *outside* the post rather than replacing it. Internal / relative links
 * (`/about`, `#anchor`, `mailto:`) are left in-tab. This is a **render-only** rule — the stored markdown
 * is untouched (`[text](url)` round-trips byte-for-byte), so it costs the editor's markdown seam nothing.
 *
 * The reader's build-time renderer (`reader/posts.ts`) applies the same rule so the shipped site and the
 * editor Preview behave identically.
 */
export function externalLinkTargets(md: MarkdownIt): void {
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

/**
 * The **client-side** markdown renderer for the editor's Preview tab (Item 14).
 *
 * Distinct from the reader's build-time render (`reader/posts.ts`): this one resolves every
 * `mm://<uuid>` to the **live** blob endpoint (`/api/files/<uuid>/blob`) so a Preview shows the real
 * image while editing, whereas the reader resolves to a hashed static asset URL at build time. Both
 * share the same block markup + `posts.css`, so a post previews the same as it will ship.
 *
 * `html: true` lets the self-contained `mm-*` HTML islands pass through verbatim; fenced code is left
 * for the browser to render as a plain `<pre><code>` (Shiki highlighting is a build-time reader
 * concern, not needed for a quick edit preview).
 */
const md = new MarkdownIt({ html: true, linkify: true, breaks: false });
externalLinkTargets(md);

/**
 * Rewrite every `mm://<uuid>` occurrence in a string to its **live** blob endpoint
 * (`/api/files/<uuid>/blob`). Shared by the Preview render and the block editor's node views (which
 * show resolved thumbnails while editing) so both resolve refs identically. Build-time resolution to
 * hashed assets is the reader's separate concern.
 *
 * @param html - Any string that may contain `mm://<uuid>` refs (rendered HTML, an island's raw markup).
 * @returns The same string with each ref pointing at the live blob URL.
 */
export function rewriteMmRefsToBlobUrls(html: string): string {
	return html.replace(MM_REF_RE, (_m, uuid) => `/api/files/${uuid}/blob`);
}

/**
 * Render a post body (markdown + `mm-*` islands + fenced code) to preview HTML with every `mm://`
 * reference rewritten to its live blob URL.
 *
 * @param body - The raw markdown body.
 * @returns Sanitizer-free HTML for `{@html}` in the Preview pane (content is the user's own).
 */
export function renderPostPreview(body: string): string {
	return rewriteMmRefsToBlobUrls(md.render(body ?? ''));
}

/** Rewrite a single `mm://<uuid>` (e.g. a frontmatter `cover`) to its live blob URL, or '' if absent. */
export function resolveMmRefToBlobUrl(ref: unknown): string {
	if (typeof ref !== 'string') return '';
	const m = /^mm:\/\/([0-9a-fA-F-]{36})$/.exec(ref.trim());
	return m ? `/api/files/${m[1]}/blob` : '';
}
