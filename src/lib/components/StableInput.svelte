<script lang="ts">
	import { Input } from '$lib/components/ui/input/index.js';
	import { syncStableValue } from '$lib/actions/stableValue.js';
	import type { HTMLInputAttributes, HTMLInputTypeAttribute } from 'svelte/elements';

	/**
	 * The shadcn `Input` with the one-way `value` write made **focus-safe**: the DOM value is synced
	 * from `value` on every change *except* while the user is typing in it. Assigning a different
	 * string to a focused input moves the caret to the end (and, when the string came from a background
	 * refetch, drops the characters typed since) — which is what used to kick people out of a field
	 * mid-sentence when autosave triggered a list refresh.
	 *
	 * Drop-in for `<Input value={x} oninput={...} />` wherever `x` is *editor state that a fetch could
	 * overwrite*. Not needed for `bind:value` on a purely local buffer (a search box, an "add item"
	 * field) — nothing else writes those. The bare `<textarea>` equivalent is the `stableValue` action;
	 * see `$lib/actions/stableValue.ts` for the full rationale.
	 *
	 * @param value - The value to display. Numbers are stringified; `null`/`undefined` render as empty.
	 * @param ref - Bindable handle on the underlying `<input>` (for `focus()` etc.), same as `Input`.
	 * @param oninput - Keep this: the component is one-way, so the typed text is written back here.
	 *
	 * Concerns / future improvements:
	 * - The prop list is explicit rather than a spread of `HTMLInputAttributes`: spreading it into
	 *   `Input`'s `type`-discriminated union blows past TypeScript's union-complexity limit. Add props
	 *   here as callers need them.
	 */
	let {
		value = '',
		ref = $bindable<HTMLInputElement | null>(null),
		type = 'text',
		id,
		class: className,
		placeholder,
		disabled = false,
		autocomplete,
		oninput,
		onblur,
		onkeydown
	}: {
		value?: string | number | null;
		ref?: HTMLInputElement | null;
		type?: Exclude<HTMLInputTypeAttribute, 'file'>;
		id?: string;
		class?: string;
		placeholder?: string;
		disabled?: boolean;
		autocomplete?: HTMLInputAttributes['autocomplete'];
		oninput?: HTMLInputAttributes['oninput'];
		onblur?: HTMLInputAttributes['onblur'];
		onkeydown?: HTMLInputAttributes['onkeydown'];
	} = $props();

	/** Non-reactive mirror of the last desired value, for the blur re-sync. */
	let pending = '';

	$effect(() => {
		pending = value == null ? '' : String(value);
		syncStableValue(ref, pending);
	});

	// Re-sync on blur: an update that arrived while the field was focused was deliberately skipped, so
	// apply it once the caret can no longer be disturbed.
	$effect(() => {
		const node = ref;
		if (!node) return;
		const resync = () => syncStableValue(node, pending);
		node.addEventListener('blur', resync);
		return () => node.removeEventListener('blur', resync);
	});
</script>

<Input
	bind:ref
	{type}
	{id}
	{placeholder}
	{disabled}
	{autocomplete}
	{oninput}
	{onblur}
	{onkeydown}
	class={className}
/>
