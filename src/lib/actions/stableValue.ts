/**
 * Focus-safe value syncing for text fields.
 *
 * Every editable text control in this app is *controlled*: its DOM value is written from state
 * (`value={...}`), and an `oninput` handler writes the typed text back. That round-trip is fine until
 * something re-renders the field **while the user is typing in it** — assigning a different string to
 * `input.value` moves the caret to the end in every browser, and if the string came from a background
 * refetch it also silently drops the characters typed since that fetch started.
 *
 * The rule these helpers enforce is the one every editor (Docs, Notion, Linear) follows: **never write
 * into the field that currently has focus.** The user's keystrokes are the source of truth for exactly
 * as long as they're in the box; the field re-syncs on blur, when a write can no longer disturb them.
 *
 * This is the last line of defence, not the fix: the hosts (`/files`, `/media`) and the editor panels
 * are also responsible for not feeding stale values down in the first place. It exists so that a future
 * refetch path added without that discipline degrades into a stale render instead of eating a sentence.
 */

/** The text-bearing elements these helpers understand. */
type TextField = HTMLInputElement | HTMLTextAreaElement;

/**
 * Write `next` into `el.value`, unless doing so would disturb the user.
 *
 * Skipped when the element is missing, already holds `next` (a no-op write still costs a caret move in
 * some engines), or currently has focus. Safe to call on every render.
 *
 * @param el - The input/textarea to sync, or `null`/`undefined` before it mounts.
 * @param next - The value the field should show.
 */
export function syncStableValue(el: TextField | null | undefined, next: string): void {
	if (!el) return;
	if (el.value === next) return;
	if (typeof document !== 'undefined' && document.activeElement === el) return;
	el.value = next;
}

/**
 * Svelte action binding a bare `<input>`/`<textarea>` to a value **without** the controlled-render
 * caret reset. Use it in place of a `value={...}` attribute; keep the `oninput` handler that writes
 * the typed text back to state.
 *
 * ```svelte
 * <textarea use:stableValue={text} oninput={(e) => (text = e.currentTarget.value)}></textarea>
 * ```
 *
 * An update that arrives while the field has focus is remembered and applied on blur, so the DOM never
 * ends up permanently disagreeing with the state behind it.
 *
 * @param node - The element the action is attached to.
 * @param next - The value to display; re-runs the sync whenever it changes.
 *
 * Concerns / future improvements:
 * - The blur re-sync shows the user whatever state actually holds, which is right when state won a
 *   conflict but does mean a genuinely stale external write becomes visible at blur rather than being
 *   rejected. Preventing that conflict is the host's job (don't refetch into an open editor).
 * - No `compositionstart`/`compositionend` handling: the focus guard already covers IME users, since a
 *   composing field is by definition focused.
 */
export function stableValue(node: TextField, next: string) {
	let pending = next;
	const onblur = () => syncStableValue(node, pending);

	syncStableValue(node, pending);
	node.addEventListener('blur', onblur);

	return {
		update(v: string) {
			pending = v;
			syncStableValue(node, pending);
		},
		destroy() {
			node.removeEventListener('blur', onblur);
		}
	};
}
