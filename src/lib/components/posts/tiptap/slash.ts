import { Extension, type Editor, type Range } from '@tiptap/core';
import Suggestion, { type SuggestionProps } from '@tiptap/suggestion';

/**
 * Slash-command support for the Posts block editor (Item 14). Typing `/` on any line opens a menu of
 * block/photo insertions — the **same actions the toolbar already exposes**, keyboard-first. This module
 * is intentionally UI-agnostic: it owns only the ProseMirror `Suggestion` plugin and forwards the popup
 * lifecycle to host-supplied handlers, so `PostBodyEditor.svelte` renders the menu with shadcn styling +
 * its own `$state` (no separate mount/DOM-ownership dance).
 *
 * The menu never mutates the doc itself — each {@link SlashItem} carries a `run({ editor, range })` that
 * the host invokes; text blocks delete the typed `/query` (the `range`) first, photo blocks delete it and
 * then open the shared FilePicker. Because insertion is unchanged, the markdown seam is untouched.
 */

/** One entry in the slash menu. */
export interface SlashItem {
	/** Menu label (also the primary filter target). */
	title: string;
	/** Group header the item is listed under (e.g. 'Basic', 'Photos'). */
	group: string;
	/** Extra filter terms (e.g. 'h2', 'todo') so `/` search matches beyond the visible title. */
	keywords?: string[];
	/** Apply the command. The host is responsible for clearing the typed `/query` via `range`. */
	run: (ctx: { editor: Editor; range: Range }) => void;
}

/** The popup props the host needs to render + drive the menu (a thin slice of {@link SuggestionProps}). */
export type SlashPopupProps = SuggestionProps<SlashItem, SlashItem>;

/** Lifecycle hooks the host wires to its Svelte state; return values match TipTap's `render()` contract. */
export interface SlashHandlers {
	onStart: (props: SlashPopupProps) => void;
	onUpdate: (props: SlashPopupProps) => void;
	/** Return true to consume the key (arrow nav / Enter / Escape), false to let it fall through. */
	onKeyDown: (event: KeyboardEvent) => boolean;
	onExit: () => void;
}

/**
 * Build the slash-command extension.
 *
 * @param opts.items - The full command list (filtered by the typed query, title + keywords).
 * @param opts.handlers - Host popup lifecycle hooks (open / update / keydown / close).
 */
export function createSlashCommands(opts: {
	items: SlashItem[];
	handlers: SlashHandlers;
}): Extension {
	return Extension.create({
		name: 'slashCommands',
		addProseMirrorPlugins() {
			return [
				Suggestion<SlashItem, SlashItem>({
					editor: this.editor,
					char: '/',
					allowSpaces: false,
					startOfLine: false,
					items: ({ query }) => {
						const q = query.toLowerCase();
						if (!q) return opts.items;
						return opts.items.filter(
							(i) =>
								i.title.toLowerCase().includes(q) || (i.keywords ?? []).some((k) => k.includes(q))
						);
					},
					command: ({ editor, range, props }) => props.run({ editor, range }),
					render: () => ({
						onStart: (props) => opts.handlers.onStart(props),
						onUpdate: (props) => opts.handlers.onUpdate(props),
						onKeyDown: ({ event }) => opts.handlers.onKeyDown(event),
						onExit: () => opts.handlers.onExit()
					})
				})
			];
		}
	});
}
