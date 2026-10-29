<script lang="ts" generics="T">
	import type { Snippet } from 'svelte';

	/**
	 * A generic, dependency-free balanced masonry layout for Svelte 5.
	 *
	 * Items are distributed left-to-right into the shortest column (order-preserving / row-major
	 * reading order), with column count derived responsively from the container width. The crucial
	 * design choice — and what keeps it robust — is that **per-item heights are only ever estimated
	 * from an aspect ratio to decide which column an item joins; they are never written back as fixed
	 * pixel heights.** Each rendered child sizes itself naturally in normal flow, so a wrong or absent
	 * aspect ratio (or a footer/caption of unknown height) only makes the columns slightly less
	 * balanced — it can never clip, overlap, or mis-align a tile. This is the failure mode that
	 * fixed-frame masonry libraries get wrong.
	 *
	 * The component owns no styling beyond flex columns and a gap, and imports nothing but `svelte`,
	 * so it can be lifted into a standalone publishable package unchanged.
	 *
	 * @param items - The items to lay out, in the order they should read (row-major).
	 * @param getKey - Stable key per item (used for keyed `{#each}`).
	 * @param aspectRatio - Optional `width / height` per item; non-positive/undefined ⇒ treated as 1
	 *   (square) for balancing only. Provide it whenever known for tighter columns.
	 * @param minColumnWidth - Target minimum column width in px; column count = how many fit the
	 *   container at this minimum. Defaults to 160.
	 * @param gap - Gap in px between columns and between items within a column. Defaults to 12.
	 * @param footerEstimate - Estimated px of non-image chrome under each item (caption/chips) added to
	 *   the height estimate so columns balance accounting for fixed footers. Distribution-only; never
	 *   rendered. Defaults to 56.
	 * @param children - Render snippet for one item: `{#snippet children(item)}…{/snippet}`.
	 *
	 * Concerns / future improvements: balancing uses intrinsic aspect ratios rather than measured DOM
	 * heights, so captions of wildly varying height won't balance perfectly — acceptable here, and a
	 * future variant could opt into a post-render measure pass. Column count changes reflow all items
	 * (no FLIP animation); fine for a browse grid, revisit if used for reorderable content.
	 */
	let {
		items,
		getKey,
		aspectRatio,
		minColumnWidth = 160,
		gap = 12,
		footerEstimate = 56,
		children
	}: {
		items: T[];
		getKey: (item: T) => string | number;
		aspectRatio?: (item: T) => number | undefined;
		minColumnWidth?: number;
		gap?: number;
		footerEstimate?: number;
		children: Snippet<[T]>;
	} = $props();

	/** Measured content width (px). `bind:clientWidth` uses a ResizeObserver under the hood. */
	let width = $state(0);

	/** How many `minColumnWidth` columns (plus inter-column gaps) fit the measured width. */
	const columnCount = $derived(Math.max(1, Math.floor((width + gap) / (minColumnWidth + gap))));

	/** Actual rendered column width, used to scale the aspect-ratio height estimate into px. */
	const columnWidth = $derived(
		columnCount > 0 ? (width - gap * (columnCount - 1)) / columnCount : 0
	);

	/**
	 * Pack items into `columnCount` columns, each item joining the currently-shortest column. Heights
	 * are estimates (image height ≈ columnWidth / aspectRatio, plus a flat footer) used solely to pick
	 * a column — see the component note on why estimate error is harmless.
	 */
	const columns = $derived.by<T[][]>(() => {
		const cols: T[][] = Array.from({ length: columnCount }, () => []);
		const heights = new Array<number>(columnCount).fill(0);
		for (const item of items) {
			const ar = aspectRatio?.(item);
			const validAr = ar && ar > 0 ? ar : 1;
			const estimatedHeight = columnWidth / validAr + footerEstimate;
			let shortest = 0;
			for (let i = 1; i < columnCount; i++) {
				if (heights[i] < heights[shortest]) shortest = i;
			}
			cols[shortest].push(item);
			heights[shortest] += estimatedHeight;
		}
		return cols;
	});
</script>

<div class="masonry" bind:clientWidth={width} style="--masonry-gap: {gap}px">
	<!-- Wait for measurement instead of mounting every tile in one provisional column, then
	     destroying/recreating most of them when ResizeObserver reports the real width. -->
	{#if width > 0}
		{#each columns as column, i (i)}
			<div class="masonry-column">
				{#each column as item (getKey(item))}
					{@render children(item)}
				{/each}
			</div>
		{/each}
	{/if}
</div>

<style>
	.masonry {
		display: flex;
		align-items: flex-start;
		gap: var(--masonry-gap);
		width: 100%;
	}
	.masonry-column {
		display: flex;
		flex: 1 1 0;
		flex-direction: column;
		gap: var(--masonry-gap);
		min-width: 0;
	}
</style>
