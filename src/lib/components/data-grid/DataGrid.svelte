<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as Card from '$lib/components/ui/card/index.js';
	import { FileText, TriangleAlert } from 'lucide-svelte';
	import EntityIcon from '$lib/components/EntityIcon.svelte';
	import { Masonry } from '$lib/components/masonry/index.js';
	import SelectionCheckbox from '$lib/components/selection/SelectionCheckbox.svelte';
	import { gridColMin, type GridItem, type GridConfig, type GridCallbacks } from './types.js';

	/**
	 * Shared presentational tile grid for both the files hub and the json record views. It owns no
	 * data-fetching or mutation: the host maps its rows to {@link GridItem}s, optionally pre-groups
	 * them, and injects toolbar/bulk controls via snippets. Grouping is host-side so the grid stays
	 * agnostic of how each side derives a group value.
	 *
	 * The `thumbnail` variant lays tiles out as a balanced {@link Masonry} so images keep their native
	 * aspect ratio (the column-balancing reads `GridItem.aspectRatio`); the name-forward `text` variant
	 * (json records, no blob to preview) stays a uniform square CSS grid.
	 *
	 * @param items - Flat, already-filtered/ordered items (used when `groups` is null).
	 * @param groups - Pre-grouped `[groupKey, items][]`; a null key renders an unlabelled section.
	 * @param config - Size, selectability, active highlight, group label fn, empty text.
	 * @param callbacks - onOpen / onToggleSelect / isSelected / onSetSelected (the last enables the
	 *   per-group select-all checkbox in group headers).
	 * @param toolbar - Optional snippet rendered in a sticky header (e.g. group-by/size selects).
	 * @param bulkBar - Optional snippet rendered in the sticky header (e.g. bulk actions).
	 */
	let {
		items = [],
		groups = null,
		config,
		callbacks,
		toolbar,
		bulkBar
	}: {
		items?: GridItem[];
		groups?: [string | null, GridItem[]][] | null;
		config: GridConfig;
		callbacks: GridCallbacks;
		toolbar?: Snippet;
		bulkBar?: Snippet;
	} = $props();

	/** Sections to render: explicit groups, or a single unlabelled section over `items`. */
	const sections = $derived<[string | null, GridItem[]][]>(groups ?? [[null, items]]);
	const total = $derived(sections.reduce((n, [, list]) => n + list.length, 0));
	const colMin = $derived(gridColMin(config.size));
	/** Masonry for image tiles (native aspect ratio); uniform square CSS grid for name-forward records. */
	const masonry = $derived(config.variant !== 'text');
	const gridStyle = $derived(`grid-template-columns: repeat(auto-fill, minmax(${colMin}px, 1fr))`);
	/** Group headers get a tri-state checkbox only while selecting and only if the host wired it up. */
	const groupSelectable = $derived(
		config.selectable && !!callbacks.onSetSelected && !!callbacks.isSelected
	);
</script>

{#snippet tile(item: GridItem)}
	{@const selected = callbacks.isSelected?.(item.id) ?? false}
	{@const activate = (shiftKey = false) =>
		config.selectable ? callbacks.onToggleSelect?.(item.id, shiftKey) : callbacks.onOpen(item.id)}
	<Card.Root
		class="group relative cursor-pointer gap-0 overflow-hidden p-0 hover:ring-2 hover:ring-primary {selected ||
		config.activeId === item.id
			? 'ring-2 ring-primary'
			: ''} {config.selectable ? 'select-none' : ''}"
		role="button"
		tabindex={0}
		onclick={(e) => activate(e.shiftKey)}
		onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && activate(e.shiftKey)}
	>
		{#if item.warning}
			<div
				class="absolute right-1 top-1 z-10 rounded bg-background/80 p-0.5 text-amber-500 shadow-sm"
				title={item.warning}
			>
				<TriangleAlert class="size-4" />
			</div>
		{/if}
		{#if config.variant === 'text'}
			<!-- Name-forward: records have no blob to preview, so the label fills the square. -->
			<div class="flex aspect-square items-center justify-center bg-muted p-2">
				<span class="line-clamp-4 text-center text-sm font-medium" title={item.primaryLabel}>
					{item.primaryLabel}
				</span>
			</div>
		{:else if item.thumbnailUrl}
			<!--
				Image tile: render at the blob's true aspect ratio (no crop) — that is the point of the
				masonry. When the manifest recorded dims we set `aspect-ratio` up front so the box reserves
				space and there's no load-shift; when it didn't, the image flows to its natural size on load
				(`height:auto`) and the masonry just balanced it as a square — harmless per the Masonry note.
			-->
			<img
				src={item.thumbnailUrl}
				alt={item.primaryLabel}
				class="block w-full bg-muted {item.aspectRatio && item.aspectRatio > 0
					? 'h-full object-cover'
					: 'h-auto'}"
				style={item.aspectRatio && item.aspectRatio > 0 ? `aspect-ratio: ${item.aspectRatio}` : ''}
				loading="lazy"
			/>
		{:else}
			<!-- No blob to preview (non-image / missing): square file-icon fallback. -->
			<div class="flex aspect-square items-center justify-center bg-muted">
				<FileText class="size-8 text-muted-foreground" />
			</div>
		{/if}
		{#if config.variant !== 'text' || item.chips.length > 0 || item.extraChips || item.secondaryLabel || item.fields?.length}
			<div class="p-1.5">
				{#if config.variant !== 'text'}
					<div class="truncate text-xs" title={item.primaryLabel}>{item.primaryLabel}</div>
				{/if}
				{#if item.secondaryLabel}
					<div class="truncate text-[11px] text-muted-foreground" title={item.secondaryLabel}>
						{item.secondaryLabel}
					</div>
				{/if}
				{#if item.fields?.length}
					<!-- Verbose mode (Item 8): key/value rows under the label; empty values render a muted dash. -->
					<dl class="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px] leading-tight">
						{#each item.fields as f (f.label)}
							<dt class="truncate text-muted-foreground" title={f.label}>{f.label}</dt>
							<dd class="truncate {f.value ? '' : 'text-muted-foreground'}" title={f.value}>
								{f.value || '—'}
							</dd>
						{/each}
					</dl>
				{/if}
				{#if item.chips.length > 0 || item.extraChips}
					<div class="mt-0.5 flex flex-wrap gap-0.5">
						{#each item.chips as chip (chip.label)}
							{#if chip.tone === 'muted'}
								<span class="text-[10px] text-muted-foreground">{chip.label}</span>
							{:else}
								<span
									class="inline-flex items-center gap-0.5 rounded bg-secondary px-1 text-[10px] text-secondary-foreground"
								>
									{#if chip.iconFallback}
										<EntityIcon name={chip.icon} fallback={chip.iconFallback} class="size-2.5" />
									{/if}
									{chip.label}
								</span>
							{/if}
						{/each}
						{#if item.extraChips}
							<span class="text-[10px] text-muted-foreground">+{item.extraChips}</span>
						{/if}
					</div>
				{/if}
			</div>
		{/if}
	</Card.Root>
{/snippet}

<div class="flex h-full w-full flex-col">
	{#if toolbar || bulkBar}
		<div
			class="sticky top-0 z-10 flex flex-col gap-2 border-b border-border bg-background p-3 shrink-0"
		>
			{@render toolbar?.()}
			{@render bulkBar?.()}
		</div>
	{/if}

	<div class="flex-1 overflow-y-auto p-4">
		{#if total === 0}
			<p class="text-muted-foreground">{config.emptyText ?? 'No items.'}</p>
		{:else}
			{#each sections as [groupKey, groupItems] (groupKey)}
				<div class="mb-5">
					{#if groupKey !== null}
						<h3 class="mb-2 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
							{#if groupSelectable}
								<!-- Select/deselect the whole group; ticks itself once every tile in it is picked. -->
								<SelectionCheckbox
									ids={groupItems.map((i) => i.id)}
									isSelected={(id) => callbacks.isSelected?.(id) ?? false}
									onSet={(ids, selected) => callbacks.onSetSelected?.(ids, selected)}
									ariaLabel="Select all in group"
								/>
							{/if}
							<span>
								{config.groupLabel ? config.groupLabel(groupKey) : groupKey}
								<span class="ml-1 font-normal">({groupItems.length})</span>
							</span>
						</h3>
					{/if}
					{#if masonry}
						<Masonry
							items={groupItems}
							getKey={(item) => item.id}
							aspectRatio={(item) => item.aspectRatio}
							minColumnWidth={colMin}
							gap={12}
						>
							{#snippet children(item)}
								{@render tile(item)}
							{/snippet}
						</Masonry>
					{:else}
						<div class="grid gap-3" style={gridStyle}>
							{#each groupItems as item (item.id)}
								{@render tile(item)}
							{/each}
						</div>
					{/if}
				</div>
			{/each}
		{/if}
	</div>
</div>
