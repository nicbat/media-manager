<script lang="ts">
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { goto } from '$app/navigation';
	import {
		Files,
		Layers,
		SlidersHorizontal,
		PenLine,
		Home,
		Check,
		ChevronsUpDown
	} from 'lucide-svelte';

	/**
	 * The **sub-app switcher** that lives in the rail header of all three sub-apps (Files, Records,
	 * Globals). Replaces the old static rail title: clicking it opens a {@link DropdownMenu} to hop
	 * between the three peer routes (the current one is checkmarked), plus a Home link to the dashboard.
	 * Composed from the shadcn `DropdownMenu` primitive (no hand-rolled nav). When the rail is collapsed
	 * the trigger is icon-only (the current sub-app's icon); expanded it shows the label + chevron.
	 *
	 * @param current - Which sub-app is active (drives the label, icon, and checkmark).
	 * @param collapsed - Icon-only trigger when true (mirrors the rail's collapsed chrome).
	 */
	let {
		current,
		collapsed = false
	}: {
		current: 'files' | 'records' | 'globals' | 'posts';
		collapsed?: boolean;
	} = $props();

	const subApps = [
		{ id: 'files', label: 'Files', href: '/files', icon: Files },
		{ id: 'records', label: 'Records', href: '/media', icon: Layers },
		{ id: 'posts', label: 'Posts', href: '/posts', icon: PenLine },
		{ id: 'globals', label: 'Globals', href: '/globals', icon: SlidersHorizontal }
	] as const;

	const active = $derived(subApps.find((s) => s.id === current) ?? subApps[0]);
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			{#if collapsed}
				<Button
					{...props}
					variant="ghost"
					size="icon"
					class="mx-auto"
					title="Switch sub-app ({active.label})"
				>
					<active.icon class="size-4" />
				</Button>
			{:else}
				<Button
					{...props}
					variant="ghost"
					class="h-8 min-w-0 flex-1 justify-start gap-2 px-2 font-semibold"
					title="Switch sub-app"
				>
					<active.icon class="size-4 shrink-0" />
					<span class="flex-1 truncate text-left">{active.label}</span>
					<ChevronsUpDown class="size-3.5 shrink-0 text-muted-foreground" />
				</Button>
			{/if}
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="start" class="w-44">
		{#each subApps as s (s.id)}
			<DropdownMenu.Item onSelect={() => s.id !== current && goto(s.href)}>
				<s.icon class="size-4" />
				<span class="flex-1">{s.label}</span>
				{#if s.id === current}
					<Check class="size-4" />
				{/if}
			</DropdownMenu.Item>
		{/each}
		<DropdownMenu.Separator />
		<DropdownMenu.Item onSelect={() => goto('/')}>
			<Home class="size-4" />
			<span class="flex-1">Home</span>
		</DropdownMenu.Item>
	</DropdownMenu.Content>
</DropdownMenu.Root>
