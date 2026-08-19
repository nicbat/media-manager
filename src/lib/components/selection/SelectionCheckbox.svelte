<script lang="ts">
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import { Label } from '$lib/components/ui/label/index.js';

	/**
	 * Tri-state "select these" checkbox shared by every multiselect surface: the bulk bar's master
	 * **Select all** (governing every visible row) and the per-group checkbox in a grid/list group
	 * header (governing that group's rows only). Both are the same interaction over a different `ids`
	 * set, so they are one component rather than two hand-rolled checkboxes.
	 *
	 * It owns **no** selection state. The look is derived from the host's `isSelected` predicate over
	 * `ids` — checked when every id is selected, indeterminate when only some are — which is what makes
	 * a group header tick itself off automatically as the last tile in it is selected by hand. The
	 * click reports intent (`select all of these` / `deselect all of these`) via `onSet`; the host
	 * applies it to its own selection set.
	 *
	 * @param ids - The ids this checkbox governs (all visible rows, or one group's rows).
	 * @param isSelected - Host predicate; read inside a `$derived`, so a reactive set (`SvelteSet`)
	 *   makes this checkbox update as individual rows are toggled.
	 * @param onSet - Called with (`ids`, `true` to select them all / `false` to deselect them all).
	 * @param label - Optional visible text beside the box (e.g. "Select all"). Rendered as a real
	 *   `<Label for>` sibling — never a wrapping label, which would swallow the un-toggle click.
	 * @param ariaLabel - Accessible name when there is no visible `label`.
	 *
	 * Concerns / future improvements: `selectedCount` is a linear scan per render, which is fine at the
	 * current unpaginated list sizes (hundreds); if the grid ever virtualizes over tens of thousands of
	 * rows this should read a host-maintained per-group tally instead.
	 */
	let {
		ids,
		isSelected,
		onSet,
		label,
		ariaLabel,
		class: className = ''
	}: {
		ids: string[];
		isSelected: (id: string) => boolean;
		onSet: (ids: string[], selected: boolean) => void;
		label?: string;
		ariaLabel?: string;
		class?: string;
	} = $props();

	const uid = $props.id();
	const selectedCount = $derived(ids.reduce((n, id) => (isSelected(id) ? n + 1 : n), 0));
	const allSelected = $derived(ids.length > 0 && selectedCount === ids.length);
	const someSelected = $derived(selectedCount > 0 && !allSelected);
</script>

<div class="flex items-center gap-1.5 {className}">
	<Checkbox
		id={uid}
		checked={allSelected}
		indeterminate={someSelected}
		disabled={ids.length === 0}
		aria-label={label ? undefined : (ariaLabel ?? 'Select all')}
		onCheckedChange={() => onSet(ids, !allSelected)}
	/>
	{#if label}
		<Label for={uid} class="cursor-pointer text-xs font-normal">{label}</Label>
	{/if}
</div>
