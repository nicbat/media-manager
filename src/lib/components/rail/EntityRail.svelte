<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import SettingsButton from '$lib/components/SettingsButton.svelte';
	import SubAppSwitcher from '$lib/components/rail/SubAppSwitcher.svelte';
	import { Home, PanelLeftClose, PanelLeftOpen } from 'lucide-svelte';

	/**
	 * The shared **rail shell** for all three sub-apps: a collapsible left `<aside>` with a header (the
	 * {@link SubAppSwitcher} + collapse toggle), a scrollable body, and a footer (Home + global App
	 * settings). The Records type rail (single-select **navigate** rows), the Files class sidebar
	 * (multi-select **filter** rows), and the Globals page all compose this — the chrome, collapse
	 * behavior, sub-app switcher, and footer are unified; only the body differs, injected per side via
	 * snippets. Collapsing renders the icon-only `collapsedBody` strip; the active entity's settings ⋮
	 * then lives in the content-column header (handled by the host).
	 *
	 * @param current - Which sub-app this rail belongs to (drives the header switcher). Preferred.
	 * @param title - Legacy static brand label (used only when `current` is omitted).
	 * @param collapsed - Icon-only when true (host owns + persists the state).
	 * @param onToggleCollapse - Flip collapsed.
	 * @param body - Expanded body (the rows + per-side extras).
	 * @param collapsedBody - Icon-only body shown when collapsed.
	 * @param belowHeader - Optional content directly under the header in both states (e.g. search).
	 * @param footer - Optional footer override; defaults to Home + App settings.
	 */
	let {
		current,
		title,
		collapsed,
		onToggleCollapse,
		body,
		collapsedBody,
		belowHeader,
		footer
	}: {
		current?: 'files' | 'records' | 'globals' | 'posts';
		title?: string;
		collapsed: boolean;
		onToggleCollapse: () => void;
		body: Snippet;
		collapsedBody?: Snippet;
		belowHeader?: Snippet;
		footer?: Snippet;
	} = $props();
</script>

<aside
	class="flex h-screen shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground transition-[width] duration-200 {collapsed
		? 'w-14'
		: 'w-56'}"
>
	<!-- Header: sub-app switcher + collapse toggle (stacked when collapsed) -->
	<div class="flex items-center gap-1 border-b px-2 {collapsed ? 'flex-col py-2' : 'h-12'}">
		{#if current}
			<SubAppSwitcher {current} {collapsed} />
		{:else if !collapsed}
			<span class="flex-1 truncate px-1 text-sm font-semibold">{title}</span>
		{/if}
		<Button
			variant="ghost"
			size="icon"
			class={collapsed && !current ? 'mx-auto' : ''}
			onclick={onToggleCollapse}
			title={collapsed ? 'Expand rail' : 'Collapse rail'}
		>
			{#if collapsed}
				<PanelLeftOpen class="size-4" />
			{:else}
				<PanelLeftClose class="size-4" />
			{/if}
		</Button>
	</div>

	{#if belowHeader && !collapsed}
		<div class="border-b p-2">
			{@render belowHeader()}
		</div>
	{/if}

	<!-- Body -->
	<div class="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">
		{#if collapsed}
			{#if collapsedBody}{@render collapsedBody()}{/if}
		{:else}
			{@render body()}
		{/if}
	</div>

	<!-- Footer -->
	{#if footer}
		{@render footer()}
	{:else}
		<div class="flex items-center gap-1 border-t p-2 {collapsed ? 'flex-col' : 'justify-between'}">
			<Button variant="ghost" size="icon" href="/" title="Home">
				<Home class="size-4" />
			</Button>
			<SettingsButton />
		</div>
	{/if}
</aside>
