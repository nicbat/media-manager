<script lang="ts">
	import { onMount } from 'svelte';
	import { apiListClasses, apiListFiles } from '$lib/api/files.js';
	import { apiListMediaTypes, apiGetGlobalsRecord } from '$lib/api/client.js';
	import { apiListPostCollections } from '$lib/api/posts.js';
	import { apiGetCompressionReport, formatBytes } from '$lib/api/compression.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import SettingsButton from '$lib/components/SettingsButton.svelte';
	import { GLOBALS_META_KEYS } from '$lib/core/fieldKeys.js';
	import { Files, Layers, PenLine, Shrink, SlidersHorizontal } from 'lucide-svelte';

	/**
	 * Home launcher: the workspace's peer sub-apps as large entry cards — **Files** (the blob hub +
	 * classes), **Records** (`json` record types), **Posts** (markdown collections), **Globals** (the
	 * app-wide singleton), and **Compression** (the savings report over the blobs). Per-class /
	 * per-type / per-collection browsing and creation live *inside* each sub-app (their rails), so the
	 * home page deliberately does not re-list every entity — it just routes and shows a count.
	 */
	let totalFiles = $state(0);
	let classCount = $state(0);
	let recordTypeCount = $state(0);
	let postCollectionCount = $state(0);
	let postCount = $state(0);
	let globalsFieldCount = $state(0);
	/** Headline compression savings (`null` while unknown, or when nothing is generated yet). */
	let compressionSaved = $state<number | null>(null);
	let compressionCovered = $state<{ covered: number; total: number } | null>(null);

	/**
	 * The Compression card's count line, built as one string rather than inline markup — Svelte trims
	 * whitespace at a block-tag line boundary, which silently ate the space before the `·` separator.
	 */
	const compressionSummary = $derived.by(() => {
		if (compressionSaved == null || compressionCovered == null) return '';
		if (compressionSaved <= 0) return 'Nothing generated yet';
		const { covered, total } = compressionCovered;
		return `${formatBytes(compressionSaved)} saved · ${covered}/${total} covered`;
	});
	let loading = $state(true);

	/** System keys that aren't user fields, so the Globals count matches what the editor shows. */
	const GLOBALS_SYSTEM_KEYS = new Set([
		'id',
		'last_modified',
		'_missing_files',
		...GLOBALS_META_KEYS
	]);

	async function load() {
		loading = true;
		try {
			const [cls, types, files, postCollections, globals, compression] = await Promise.all([
				apiListClasses().catch(() => []),
				apiListMediaTypes().catch(() => []),
				apiListFiles().catch(() => ({ files: [] })),
				apiListPostCollections().catch(() => []),
				apiGetGlobalsRecord().catch(() => ({}) as Record<string, unknown>),
				apiGetCompressionReport().catch(() => null)
			]);
			classCount = cls.length;
			// Globals is its own peer here, not a record type.
			recordTypeCount = types.filter((t) => t.id !== 'globals').length;
			totalFiles = files.files.length;
			postCollectionCount = postCollections.length;
			postCount = postCollections.reduce((sum, c) => sum + c.count, 0);
			globalsFieldCount = Object.keys(globals).filter((k) => !GLOBALS_SYSTEM_KEYS.has(k)).length;
			compressionSaved = compression?.stats.headline?.savedBytes ?? null;
			compressionCovered = compression
				? { covered: compression.stats.coveredFiles, total: compression.stats.totalFiles }
				: null;
		} finally {
			loading = false;
		}
	}

	onMount(load);

	const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
</script>

<div class="mx-auto max-w-4xl p-6">
	<header class="mb-8 flex items-center gap-3">
		<h1 class="text-2xl font-semibold tracking-tight">media-manager</h1>
		<div class="flex-1"></div>
		<SettingsButton />
	</header>

	<div class="grid gap-4 sm:grid-cols-2">
		<a href="/files" class="block">
			<Card.Root class="group h-full transition-colors hover:border-primary hover:bg-muted/40">
				<Card.Header>
					<Files class="size-8 text-muted-foreground transition-colors group-hover:text-primary" />
					<Card.Title class="text-xl">Files</Card.Title>
					<Card.Description
						>Your blobs, and the classes that tag &amp; describe them.</Card.Description
					>
				</Card.Header>
				<Card.Content class="text-sm text-muted-foreground">
					{#if !loading}
						{plural(totalFiles, 'file')} · {plural(classCount, 'class', 'classes')}
					{/if}
				</Card.Content>
			</Card.Root>
		</a>

		<a href="/media" class="block">
			<Card.Root class="group h-full transition-colors hover:border-primary hover:bg-muted/40">
				<Card.Header>
					<Layers class="size-8 text-muted-foreground transition-colors group-hover:text-primary" />
					<Card.Title class="text-xl">Records</Card.Title>
					<Card.Description
						>Schema-driven record types — pure data, no file attached.</Card.Description
					>
				</Card.Header>
				<Card.Content class="text-sm text-muted-foreground">
					{#if !loading}
						{plural(recordTypeCount, 'type')}
					{/if}
				</Card.Content>
			</Card.Root>
		</a>

		<a href="/posts" class="block">
			<Card.Root class="group h-full transition-colors hover:border-primary hover:bg-muted/40">
				<Card.Header>
					<PenLine
						class="size-8 text-muted-foreground transition-colors group-hover:text-primary"
					/>
					<Card.Title class="text-xl">Posts</Card.Title>
					<Card.Description>Markdown posts that embed photos from your Files.</Card.Description>
				</Card.Header>
				<Card.Content class="text-sm text-muted-foreground">
					{#if !loading}
						{plural(postCollectionCount, 'collection')} · {plural(postCount, 'post')}
					{/if}
				</Card.Content>
			</Card.Root>
		</a>

		<a href="/globals" class="block">
			<Card.Root class="group h-full transition-colors hover:border-primary hover:bg-muted/40">
				<Card.Header>
					<SlidersHorizontal
						class="size-8 text-muted-foreground transition-colors group-hover:text-primary"
					/>
					<Card.Title class="text-xl">Globals</Card.Title>
					<Card.Description>One app-wide settings record, grouped into sections.</Card.Description>
				</Card.Header>
				<Card.Content class="text-sm text-muted-foreground">
					{#if !loading}
						{plural(globalsFieldCount, 'field')}
					{/if}
				</Card.Content>
			</Card.Root>
		</a>

		<a href="/compression" class="block">
			<Card.Root class="group h-full transition-colors hover:border-primary hover:bg-muted/40">
				<Card.Header>
					<Shrink class="size-8 text-muted-foreground transition-colors group-hover:text-primary" />
					<Card.Title class="text-xl">Compression</Card.Title>
					<Card.Description>Smaller images for the web, and what they cost.</Card.Description>
				</Card.Header>
				<Card.Content class="text-sm text-muted-foreground">
					{#if !loading && compressionSummary}
						{compressionSummary}
					{/if}
				</Card.Content>
			</Card.Root>
		</a>
	</div>
</div>
