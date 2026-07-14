import type { Node as ProseMirrorNode, Schema } from '@tiptap/pm/model';
import {
	MarkdownParser,
	MarkdownSerializer,
	MarkdownSerializerState,
	defaultMarkdownSerializer
} from 'prosemirror-markdown';
import MarkdownIt from 'markdown-it';

/**
 * The **markdown ↔ ProseMirror-doc bridge** for the Posts block editor (Item 14, Phase 3) — the
 * load-bearing seam. It keeps the editor markdown-first: prose is real Markdown, the four `mm-*` photo
 * blocks are opaque HTML islands (one `htmlIsland` atom each), and code stays native fenced blocks.
 *
 * The design was de-risked by the Phase-3 spike, which proved `md → doc → md` **byte-stable AND
 * idempotent** (`rt(rt(x)) === rt(x)`) for prose+inline image, an `mm-beside` island, and a fenced
 * code block. This module implements that locked recipe against the TipTap schema (camelCase node
 * names — `bulletList`/`codeBlock`/`horizontalRule`/…), reusing {@link defaultMarkdownSerializer}'s
 * node/mark functions where the shapes match and overriding only where they don't.
 *
 * Two directions:
 * - {@link docToMarkdown} — save path (editor doc → the `.md` body stored on disk).
 * - {@link markdownToDoc} — load path (the `.md` body → a doc for the editor); needs the live editor
 *   `Schema` so the produced doc is editor-compatible.
 *
 * ### Concerns / future improvements
 * - Inline HTML (`html_inline`, e.g. a stray `<br/>`) is passed through as literal text — rare in
 *   well-formed posts (islands are block-level); block islands are the supported shape.
 * - Tables are disabled in the parse tokenizer (no table node in the schema); table syntax degrades to
 *   text rather than throwing.
 */

/** The default serializer's node functions, reused under TipTap's camelCase node names. */
const d = defaultMarkdownSerializer.nodes;

/**
 * Node serializers keyed by **TipTap** node name. `htmlIsland` writes its stored markup verbatim
 * (islands are opaque); `codeBlock` emits a fenced block preserving the language; the rest map to the
 * default serializer's implementations.
 */
const nodes: Record<
	string,
	(
		state: MarkdownSerializerState,
		node: ProseMirrorNode,
		parent: ProseMirrorNode,
		index: number
	) => void
> = {
	blockquote: d.blockquote,
	paragraph: d.paragraph,
	heading: d.heading,
	horizontalRule: d.horizontal_rule,
	bulletList: (state, node) => state.renderList(node, '  ', () => '- '),
	orderedList: (state, node) => {
		const start = (node.attrs.start as number) || 1;
		const maxW = String(start + node.childCount - 1).length;
		const space = state.repeat(' ', maxW + 2);
		state.renderList(node, space, (i: number) => {
			const nStr = String(start + i);
			return state.repeat(' ', maxW - nStr.length) + nStr + '. ';
		});
	},
	listItem: (state, node) => state.renderContent(node),
	codeBlock: (state, node) => {
		const language = (node.attrs.language as string) || '';
		state.write('```' + language + '\n');
		state.text(node.textContent, false);
		state.ensureNewLine();
		state.write('```');
		state.closeBlock(node);
	},
	image: d.image,
	hardBreak: d.hard_break,
	text: d.text,
	htmlIsland: (state, node) => {
		state.text(node.attrs.html as string, false);
		state.closeBlock(node);
	}
};

/** Mark serializers keyed by TipTap mark name (`bold`/`italic` vs the default `strong`/`em`). */
const marks: MarkdownSerializer['marks'] = {
	bold: defaultMarkdownSerializer.marks.strong,
	italic: defaultMarkdownSerializer.marks.em,
	code: defaultMarkdownSerializer.marks.code,
	link: defaultMarkdownSerializer.marks.link,
	strike: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true }
};

const serializer = new MarkdownSerializer(nodes, marks);

/**
 * Serialize a ProseMirror doc to the markdown body stored on disk. Byte-stable + idempotent with
 * {@link markdownToDoc} for prose, `mm-*` islands, and fenced code.
 *
 * @param doc - The editor's document node.
 * @returns The `.md` body (frontmatter is handled separately by the host).
 */
export function docToMarkdown(doc: ProseMirrorNode): string {
	return serializer.serialize(doc, { tightLists: true });
}

/**
 * markdown-it tokenizer for the parse direction. Block HTML (`html_block`) stays on — that's how the
 * `mm-*` islands are recognized — while **inline HTML and tables are disabled**: there is no schema
 * node for either, so a stray `<br/>` degrades to literal text (round-trips as text) instead of
 * throwing an "unsupported token" error. Bare-URL autolinking is off so serialization stays idempotent
 * (an autolinked URL would re-serialize as an explicit `[url](url)`, mutating the source).
 */
function buildTokenizer(): MarkdownIt {
	return new MarkdownIt({ html: true, linkify: false }).disable(['table', 'html_inline']);
}

/**
 * markdown-it token → node/mark spec map (keyed by markdown-it token type). `html_block` becomes an
 * `htmlIsland` atom carrying the trimmed markup; fenced code carries its language.
 */
const tokens: ConstructorParameters<typeof MarkdownParser>[2] = {
	blockquote: { block: 'blockquote' },
	paragraph: { block: 'paragraph' },
	list_item: { block: 'listItem' },
	bullet_list: { block: 'bulletList' },
	ordered_list: {
		block: 'orderedList',
		getAttrs: (tok) => ({ start: +(tok.attrGet('start') || 1) })
	},
	heading: { block: 'heading', getAttrs: (tok) => ({ level: +tok.tag.slice(1) }) },
	code_block: { block: 'codeBlock', noCloseToken: true },
	fence: {
		block: 'codeBlock',
		getAttrs: (tok) => ({ language: tok.info.trim() }),
		noCloseToken: true
	},
	hr: { node: 'horizontalRule' },
	image: {
		node: 'image',
		getAttrs: (tok) => ({
			src: tok.attrGet('src'),
			title: tok.attrGet('title') || null,
			alt: (tok.children?.[0] && tok.children[0].content) || null
		})
	},
	hardbreak: { node: 'hardBreak' },
	html_block: {
		node: 'htmlIsland',
		getAttrs: (tok) => ({ html: tok.content.trim() }),
		noCloseToken: true
	},
	em: { mark: 'italic' },
	strong: { mark: 'bold' },
	s: { mark: 'strike' },
	link: {
		mark: 'link',
		getAttrs: (tok) => ({ href: tok.attrGet('href'), title: tok.attrGet('title') || null })
	},
	code_inline: { mark: 'code', noCloseToken: true }
};

/**
 * Build a markdown parser bound to the live editor {@link Schema}.
 *
 * @param schema - The editor's ProseMirror schema (`editor.schema`), so the doc is editor-compatible.
 */
export function createPostMarkdownParser(schema: Schema): MarkdownParser {
	return new MarkdownParser(schema, buildTokenizer(), tokens);
}

/**
 * Parse a markdown body into a ProseMirror doc for the editor.
 *
 * @param markdown - The `.md` body (no frontmatter).
 * @param schema - The editor's schema.
 * @returns The parsed document node (empty doc if the body is blank).
 */
export function markdownToDoc(markdown: string, schema: Schema): ProseMirrorNode {
	return createPostMarkdownParser(schema).parse(markdown ?? '');
}
