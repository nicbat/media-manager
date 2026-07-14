<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Search, File, X, ExternalLink, Plus } from 'lucide-svelte';
	import { apiListFiles, apiListClassMembers, apiBlobUrl } from '$lib/api/files.js';
	import { hasAllowedImageExtension } from '$lib/core/images.js';
	import { refreshTrigger } from '$lib/stores/refreshTrigger.js';
	import type { FileItem } from '$lib/core/types.js';

	let {
		value = $bindable(),
		multiselect = false,
		classId,
		onSelect,
		open = $bindable(false),
		trigger = true
	}: {
		/** The selected blob `file_id` (single) or an array of ids (multiselect), or empty. */
		value?: string | string[];
		/** When true, `value` is an id array and several blobs may be chosen. */
		multiselect?: boolean;
		/** When set, the picker offers only members of this class (a hard class filter). */
		classId?: string;
		onSelect?: (value: string | string[]) => void;
		/** Controlled open state — `bind:open` to drive the dialog programmatically. */
		open?: boolean;
		/** When false, render only the dialog (no trigger/chips) so a caller can open it via `bind:open`. */
		trigger?: boolean;
	} = $props();
	let files = $state<FileItem[]>([]);
	let loading = $state(false);
	let query = $state('');
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	/** Currently-selected ids, normalized to an array regardless of cardinality. */
	const selectedIds = $derived<string[]>(
		multiselect ? (Array.isArray(value) ? (value as string[]) : []) : value ? [value as string] : []
	);

	/** Resolve a file_id to its filename (used for thumbnails + image-extension detection). */
	function nameFor(id: string): string {
		return files.find((f) => f.id === id)?.file_name ?? '';
	}

	/**
	 * The visible label for a blob: the class's resolved title (`title_value`, from the class's
	 * title-by field) when scoped to a class, else the filename. So a class-scoped picker reads as
	 * "Warm sunset" rather than "sunset.png".
	 */
	function labelFor(id: string): string {
		const f = files.find((x) => x.id === id);
		return (f?.title_value && f.title_value.trim()) || f?.file_name || '';
	}

	/**
	 * Load blobs honouring the search query. When scoped to a class, fetch the class's **catalog**
	 * (`/api/classes/[id]/members`) so each member carries its resolved title-by value (`title_value`);
	 * otherwise the global hub.
	 */
	async function fetchFiles() {
		loading = true;
		try {
			const res = classId
				? await apiListClassMembers(classId, { query: query || undefined })
				: await apiListFiles({ query: query || undefined });
			files = res.files;
		} catch (e) {
			console.error('FilePicker: failed to fetch files', e);
		} finally {
			loading = false;
		}
	}

	function handleSearchInput(e: Event) {
		query = (e.target as HTMLInputElement).value;
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => fetchFiles(), 300);
	}

	$effect(() => {
		if (open) fetchFiles();
	});

	// When a value is set but we haven't loaded the blob list yet, load it once so the trigger button
	// can show the resolved filename instead of the raw file_id.
	$effect(() => {
		if (selectedIds.length > 0 && files.length === 0 && !loading) fetchFiles();
	});

	// The cached `files` list backs the collapsed trigger's label/thumbnail. When a blob is renamed or
	// its class title-by value changes elsewhere (which bumps `refreshTrigger`), refresh the cache so a
	// closed picker doesn't keep a stale label until reopened. Skips the initial value (no-op on mount).
	let lastRefresh = $state(0);
	$effect(() => {
		const n = $refreshTrigger;
		if (n !== lastRefresh) {
			lastRefresh = n;
			if (selectedIds.length > 0) fetchFiles();
		}
	});

	function commit(next: string | string[]) {
		value = next;
		onSelect?.(next);
	}

	function handleSelect(file: FileItem) {
		if (multiselect) {
			if (!selectedIds.includes(file.id)) commit([...selectedIds, file.id]);
		} else {
			commit(file.id);
			open = false;
		}
	}

	function removeId(id: string) {
		if (multiselect) commit(selectedIds.filter((x) => x !== id));
		else commit('');
	}
</script>

{#snippet fileChip(id: string)}
	{@const name = nameFor(id)}
	{@const label = labelFor(id)}
	<span
		class="inline-flex max-w-full items-center gap-1 rounded bg-muted px-2 py-1 text-sm"
		title={label}
	>
		<span
			class="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded bg-background"
		>
			{#if name && hasAllowedImageExtension(name)}
				<img src={apiBlobUrl(id)} alt={label} class="h-full w-full object-cover" loading="lazy" />
			{:else}
				<File class="size-3.5 text-muted-foreground" />
			{/if}
		</span>
		<span class="truncate">{label || 'Selected file'}</span>
		<a
			href={apiBlobUrl(id)}
			target="_blank"
			rel="noopener noreferrer"
			class="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
			aria-label="Open file in new tab"
			title="Open in new tab"
		>
			<ExternalLink class="size-3.5" />
		</a>
		<button
			type="button"
			class="shrink-0 text-muted-foreground transition-colors hover:text-destructive"
			onclick={() => removeId(id)}
			aria-label="Remove file"
		>
			<X class="size-3.5" />
		</button>
	</span>
{/snippet}

{#if !trigger}
	<!-- Triggerless / controlled mode: caller opens the dialog via `bind:open`. -->
	<Dialog.Root bind:open>
		{@render pickerContent()}
	</Dialog.Root>
{:else if multiselect}
	<div class="flex w-full flex-col gap-2">
		{#if selectedIds.length > 0}
			<div class="flex flex-wrap gap-1.5">
				{#each selectedIds as id (id)}
					{@render fileChip(id)}
				{/each}
			</div>
		{/if}
		<Dialog.Root bind:open>
			<Dialog.Trigger>
				{#snippet child({ props })}
					<Button {...props} variant="outline" size="sm" class="w-fit gap-1.5">
						<Plus class="size-4" /> Add file…
					</Button>
				{/snippet}
			</Dialog.Trigger>
			{@render pickerContent()}
		</Dialog.Root>
	</div>
{:else}
	{@const selectedId = selectedIds[0] ?? ''}
	{@const selectedName = nameFor(selectedId)}
	{@const selectedUrl = selectedId ? apiBlobUrl(selectedId) : ''}
	<div class="flex items-center gap-2">
		<Dialog.Root bind:open>
			<Dialog.Trigger class="min-w-0 flex-1">
				{#snippet child({ props })}
					<Button
						{...props}
						variant="outline"
						class="h-auto w-full min-w-0 flex-1 justify-start gap-2 py-1.5 text-left font-normal"
					>
						{#if selectedId}
							<span
								class="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded bg-muted"
							>
								{#if selectedName && hasAllowedImageExtension(selectedName) && selectedUrl}
									<img
										src={selectedUrl}
										alt={selectedName}
										class="h-full w-full object-cover"
										loading="lazy"
									/>
								{:else}
									<File class="size-5 text-muted-foreground" />
								{/if}
							</span>
							<span class="flex-1 truncate">{labelFor(selectedId) || 'Selected file'}</span>
						{:else}
							<span class="text-muted-foreground">Select file…</span>
						{/if}
					</Button>
				{/snippet}
			</Dialog.Trigger>
			{@render pickerContent()}
		</Dialog.Root>
		{#if selectedId}
			{#if selectedUrl}
				<a
					href={selectedUrl}
					target="_blank"
					rel="noopener noreferrer"
					class="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
					aria-label="Open file in new tab"
					title="Open in new tab"
				>
					<ExternalLink class="size-4" />
				</a>
			{/if}
			<button
				type="button"
				class="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
				onclick={() => removeId(selectedId)}
				aria-label="Clear file selection"
			>
				<X class="size-4" />
			</button>
		{/if}
	</div>
{/if}

{#snippet pickerContent()}
	<Dialog.Content class="flex max-h-[80vh] max-w-2xl flex-col">
		<Dialog.Title>Select File</Dialog.Title>
		<Dialog.Description
			>Search and select a file from the global files directory.</Dialog.Description
		>
		<div class="mt-4 flex items-center gap-2">
			<Search class="size-4 shrink-0 text-muted-foreground" />
			<Input type="search" placeholder="Search files…" value={query} oninput={handleSearchInput} />
		</div>
		<div
			class="mt-4 grid min-h-[16rem] flex-1 grid-cols-2 gap-2 overflow-y-auto rounded-md border p-2 sm:grid-cols-3 md:grid-cols-4"
		>
			{#if loading}
				<div class="col-span-full flex justify-center py-8 text-muted-foreground">Loading…</div>
			{:else if files.length === 0}
				<div class="col-span-full flex justify-center py-8 text-muted-foreground">
					{query ? 'No files match your search.' : 'No files found.'}
				</div>
			{:else}
				{#each files as file (file.id)}
					{@const isSelected = selectedIds.includes(file.id)}
					{@const fileLabel = (file.title_value && file.title_value.trim()) || file.file_name}
					<button
						class="flex flex-col items-center gap-2 rounded-md border p-2 text-left transition-colors hover:bg-accent hover:text-accent-foreground focus:outline-none focus:ring-2 focus:ring-ring {isSelected
							? 'bg-accent/50 ring-2 ring-primary'
							: ''}"
						onclick={() => handleSelect(file)}
					>
						<div
							class="flex aspect-square w-full items-center justify-center overflow-hidden rounded bg-muted"
						>
							{#if hasAllowedImageExtension(file.file_name)}
								<img
									src={apiBlobUrl(file.id)}
									alt={fileLabel}
									class="h-full w-full object-cover"
									loading="lazy"
								/>
							{:else}
								<File class="size-8 text-muted-foreground" />
							{/if}
						</div>
						<span class="w-full truncate text-center text-xs" title={fileLabel}>
							{fileLabel}
						</span>
					</button>
				{/each}
			{/if}
		</div>
	</Dialog.Content>
{/snippet}
