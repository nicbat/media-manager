import { Node } from '@tiptap/core';
import { rewriteMmRefsToBlobUrls } from '../../renderPreview.js';

/**
 * The **`htmlIsland`** block node — the single ProseMirror node backing all four `mm-*` photo blocks
 * (`mm-inline`, `mm-beside`, `mm-pair`, `mm-bleed`) in the Posts block editor (Item 14, Phase 3).
 *
 * It is an **atom**: an opaque block whose entire content is a verbatim HTML string held in
 * `attrs.html`. The editor never re-flows an island's internals — matching the markdown round-trip
 * contract locked by the Phase-3 spike (a `<div class="mm-*">…</div>` parses to exactly one
 * `html_block` token ⇒ one `htmlIsland` node; serialization writes `attrs.html` back verbatim). This
 * is why there is **one** node type, not four: the variant is encoded in the markup (`class="mm-*"`,
 * `data-side`), and {@link src/lib/components/posts/tiptap/islands.ts} builds/edits that markup.
 *
 * On disk each `src` stays `mm://<uuid>`; the node view rewrites those to the live blob endpoint
 * ({@link rewriteMmRefsToBlobUrls}) purely for the editing preview — the stored `attrs.html` keeps the
 * `mm://` form so the serializer round-trips it unchanged.
 *
 * Editing an island (change photo, caption, side) is driven from the Svelte host
 * (`PostBodyEditor.svelte`) off the current selection via `updateAttributes`, not from inside the node
 * view — keeping this node free of framework glue and safe to construct headless (`getSchema`) for the
 * serializer tests.
 *
 * ### Concerns / future improvements
 * - Inline caption editing currently happens through the host toolbar; a richer in-place editor could
 *   mount here later, but must preserve the "no blank lines between island children" invariant so the
 *   markdown round-trip stays byte-stable.
 */
export const HtmlIsland = Node.create({
	name: 'htmlIsland',
	group: 'block',
	atom: true,
	selectable: true,
	draggable: true,
	isolating: true,

	addAttributes() {
		return {
			/** The verbatim island markup, `mm://<uuid>` refs intact (the on-disk form). */
			html: { default: '' }
		};
	},

	// Only used for clipboard / DOM export — never the save path (that goes through the markdown
	// serializer). Paste detection maps the four block wrappers back to an island atom.
	parseHTML() {
		return [
			{ tag: 'div.mm-beside' },
			{ tag: 'div.mm-pair' },
			{ tag: 'figure.mm-inline' },
			{ tag: 'figure.mm-bleed' }
		];
	},

	renderHTML({ node }) {
		// A minimal DOM stand-in for schema.toDOM (clipboard). The live editing view is the node view.
		return ['div', { class: 'mm-island', 'data-html': node.attrs.html }];
	},

	addNodeView() {
		return ({ node }) => {
			const dom = document.createElement('div');
			dom.className = 'mm-island-node';
			dom.setAttribute('data-drag-handle', '');
			dom.contentEditable = 'false';
			dom.innerHTML = rewriteMmRefsToBlobUrls(node.attrs.html as string);
			return {
				dom,
				// Atom: no content hole; re-render on any attr change.
				update: (updated) => {
					if (updated.type.name !== 'htmlIsland') return false;
					dom.innerHTML = rewriteMmRefsToBlobUrls(updated.attrs.html as string);
					return true;
				}
			};
		};
	}
});
