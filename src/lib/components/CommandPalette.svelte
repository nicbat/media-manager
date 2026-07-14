<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import * as Command from '$lib/components/ui/command/index.js';
	import { apiListClasses } from '$lib/api/files.js';
	import { apiListMediaTypes, type MediaTypeSummary } from '$lib/api/client.js';
	import { apiListPostCollections, type PostCollectionSummary } from '$lib/api/posts.js';
	import type { ClassSummary } from '$lib/core/types.js';
	import EntityIcon from '$lib/components/EntityIcon.svelte';
	import { Files, Layers, SlidersHorizontal, PenLine, Home } from 'lucide-svelte';

	/**
	 * The global **⌘K command palette** — a cross-sub-app quick switcher mounted once in the root layout.
	 * Press ⌘K (or Ctrl-K) anywhere to jump to a sub-app (Files / Records / Globals), a specific class
	 * (opens its catalog at `/files?class=`), a record type (`/media?type=`), or Home. Composed from the
	 * shadcn `Command` primitive (no hand-rolled overlay). Navigation-only for now — searching individual
	 * files/records is a deferred follow-up.
	 *
	 * Data (classes + record types) is fetched lazily the first time the palette opens, so it costs
	 * nothing on pages that never invoke it.
	 */
	let open = $state(false);
	let loaded = $state(false);
	let classes = $state<ClassSummary[]>([]);
	let types = $state<MediaTypeSummary[]>([]);
	let postCollections = $state<PostCollectionSummary[]>([]);

	/** Record types excluding the reserved globals singleton (it's a sub-app entry, not a type). */
	const recordTypes = $derived(types.filter((t) => t.id !== 'globals'));

	async function loadData() {
		if (loaded) return;
		loaded = true;
		[classes, types, postCollections] = await Promise.all([
			apiListClasses().catch(() => []),
			apiListMediaTypes().catch(() => []),
			apiListPostCollections().catch(() => [])
		]);
	}

	/** Close the palette, then navigate (closing first avoids a flash of the dialog over the new view). */
	function run(href: string) {
		open = false;
		goto(href);
	}

	onMount(() => {
		function onKeydown(e: KeyboardEvent) {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
				e.preventDefault();
				open = !open;
			}
		}
		window.addEventListener('keydown', onKeydown);
		return () => window.removeEventListener('keydown', onKeydown);
	});

	// Fetch the entity lists the first time the palette is opened.
	$effect(() => {
		if (open) loadData();
	});
</script>

<Command.Dialog bind:open title="Command palette" description="Jump to a sub-app or entity">
	<Command.Input placeholder="Jump to…" />
	<Command.List>
		<Command.Empty>No results found.</Command.Empty>

		<Command.Group heading="Sub-apps">
			<Command.Item value="Files" onSelect={() => run('/files')}>
				<Files class="size-4" />
				<span>Files</span>
			</Command.Item>
			<Command.Item value="Records" onSelect={() => run('/media')}>
				<Layers class="size-4" />
				<span>Records</span>
			</Command.Item>
			<Command.Item value="Posts" onSelect={() => run('/posts')}>
				<PenLine class="size-4" />
				<span>Posts</span>
			</Command.Item>
			<Command.Item value="Globals" onSelect={() => run('/globals')}>
				<SlidersHorizontal class="size-4" />
				<span>Globals</span>
			</Command.Item>
		</Command.Group>

		{#if classes.length}
			<Command.Separator />
			<Command.Group heading="Classes">
				{#each classes as c (c.id)}
					<Command.Item
						value="class {c.displayName}"
						onSelect={() => run(`/files?class=${encodeURIComponent(c.id)}`)}
					>
						<EntityIcon name={c.icon} fallback="tag" />
						<span>{c.displayName}</span>
					</Command.Item>
				{/each}
			</Command.Group>
		{/if}

		{#if recordTypes.length}
			<Command.Separator />
			<Command.Group heading="Record types">
				{#each recordTypes as t (t.id)}
					<Command.Item
						value="record type {t.displayName}"
						onSelect={() => run(`/media?type=${encodeURIComponent(t.id)}`)}
					>
						<EntityIcon name={t.icon} fallback="file-text" />
						<span>{t.displayName}</span>
					</Command.Item>
				{/each}
			</Command.Group>
		{/if}

		{#if postCollections.length}
			<Command.Separator />
			<Command.Group heading="Collections">
				{#each postCollections as c (c.id)}
					<Command.Item
						value="collection {c.displayName}"
						onSelect={() => run(`/posts?collection=${encodeURIComponent(c.id)}`)}
					>
						<PenLine class="size-4" />
						<span>{c.displayName}</span>
					</Command.Item>
				{/each}
			</Command.Group>
		{/if}

		<Command.Separator />
		<Command.Group heading="General">
			<Command.Item value="Home" onSelect={() => run('/')}>
				<Home class="size-4" />
				<span>Home</span>
			</Command.Item>
		</Command.Group>
	</Command.List>
</Command.Dialog>
