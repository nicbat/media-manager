import { mergeAttributes } from '@tiptap/core';
import { StarterKit } from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { common, createLowlight } from 'lowlight';
import { HtmlIsland } from './nodes/HtmlIsland.js';
import { rewriteMmRefsToBlobUrls } from '../renderPreview.js';

/**
 * Inline image node that keeps `attrs.src` in the on-disk `mm://<uuid>` form (so the markdown
 * serializer round-trips it verbatim) but **renders** the live blob URL, so `![](mm://…)` images show
 * in the editor instead of a broken `mm://` request. The rewrite is display-only — nothing changes the
 * stored src.
 */
const MmImage = Image.extend({
	renderHTML({ HTMLAttributes }) {
		const attrs = { ...HTMLAttributes };
		if (typeof attrs.src === 'string') attrs.src = rewriteMmRefsToBlobUrls(attrs.src);
		return ['img', mergeAttributes(this.options.HTMLAttributes, attrs)];
	}
});

/**
 * The **single source of truth** for the Posts block editor's schema (Item 14, Phase 3). Both the live
 * editor (`PostBodyEditor.svelte`) and the markdown (de)serializer tests build from this exact list, so
 * the doc the editor produces and the doc {@link markdownToDoc} produces share one schema.
 *
 * Choices tied to the markdown round-trip:
 * - **`underline` disabled** — Markdown has no underline; a non-representable mark would break the
 *   byte-stable round-trip. `strike` is kept (`~~`, GFM).
 * - **StarterKit `codeBlock` disabled**, replaced by {@link CodeBlockLowlight} — native fenced blocks
 *   with edit-time highlighting (the reader re-highlights with Shiki at build time).
 * - **`Image` inline** — `![](mm://…)` parses to an inline image inside a paragraph.
 * - **{@link HtmlIsland}** — the four `mm-*` photo blocks as one opaque atom.
 *
 * Constructed headless by `getSchema(postExtensions())` in tests; node views (which touch the DOM) are
 * never executed there.
 */
export function postExtensions() {
	return [
		StarterKit.configure({
			// Disable non-round-trippable / replaced sub-extensions.
			underline: false,
			codeBlock: false,
			link: { openOnClick: false, autolink: false }
		}),
		MmImage.configure({ inline: true, allowBase64: false }),
		CodeBlockLowlight.configure({ lowlight: createLowlight(common) }),
		HtmlIsland
	];
}
