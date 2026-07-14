<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { goto, replaceState } from '$app/navigation';
	import EntityRail from '$lib/components/rail/EntityRail.svelte';
	import PostsEditorPane from '$lib/components/PostsEditorPane.svelte';
	import EntitySettingsDialog from '$lib/components/entity-settings/EntitySettingsDialog.svelte';
	import { postsSettingsAdapter } from '$lib/components/entity-settings/adapters.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import { toast } from 'svelte-sonner';
	import { Plus, FileText, MoreVertical, PenLine, Settings } from 'lucide-svelte';
	import { settingsStore } from '$lib/stores/settings.js';
	import {
		apiListPostCollections,
		apiCreatePostCollection,
		apiGetPostCollection,
		apiDeletePostCollection,
		apiCreatePost,
		type PostCollectionSummary,
		type PostSummary
	} from '$lib/api/posts.js';
	import type { SchemaDefinition } from '$lib/core/types.js';

	/**
	 * The **Posts** sub-app (Item 14) — a peer of Files / Records / Globals. Structurally the Records
	 * hub's cousin, but two-level: the rail selects a **collection** (a folder of `.md` files) and lists
	 * its **posts**, and the content column hosts the {@link PostsEditorPane} for the open post. The
	 * open collection + post are deep-linked via `?collection=&post=` so reload/share/back reproduce the
	 * view.
	 */
	let railCollapsed = $state(false);
	let collections = $state<PostCollectionSummary[]>([]);
	let activeCollection = $state<string | null>(null);
	let posts = $state<PostSummary[]>([]);
	let schema = $state<SchemaDefinition>({});
	let displayField = $state('');
	let activePost = $state<string | null>(null);
	let loadingCollections = $state(true);
	let urlReady = $state(false);

	let newCollectionOpen = $state(false);
	let newCollectionName = $state('');
	let collectionPendingDelete = $state<string | null>(null);
	let collectionSettingsOpen = $state(false);

	function toggleRail() {
		railCollapsed = !railCollapsed;
		settingsStore.updateSetting('railCollapsed', railCollapsed);
	}

	/** Load a collection's post list + frontmatter schema. */
	async function loadCollection(id: string) {
		try {
			const detail = await apiGetPostCollection(id);
			posts = detail.posts;
			schema = detail.schema;
			displayField = detail.displayField;
		} catch (e) {
			console.error(e);
			posts = [];
			schema = {};
			displayField = '';
		}
	}

	async function refreshCollections(): Promise<PostCollectionSummary[]> {
		collections = await apiListPostCollections();
		return collections;
	}

	onMount(() => {
		settingsStore.fetchSettings();
		const unsub = settingsStore.subscribe((s) => (railCollapsed = s.railCollapsed));
		(async () => {
			try {
				await refreshCollections();
			} catch (e) {
				console.error(e);
			}
			const wantedCollection = $page.url.searchParams.get('collection');
			activeCollection =
				wantedCollection && collections.some((c) => c.id === wantedCollection)
					? wantedCollection
					: (collections[0]?.id ?? null);
			if (activeCollection) {
				await loadCollection(activeCollection);
				const wantedPost = $page.url.searchParams.get('post');
				if (wantedPost && posts.some((p) => p.slug === wantedPost)) activePost = wantedPost;
			}
			loadingCollections = false;
			urlReady = true;
		})();
		return unsub;
	});

	// Keep the URL in sync with the open collection + post.
	$effect(() => {
		const c = activeCollection;
		const p = activePost;
		if (!urlReady) return;
		const parts: string[] = [];
		if (c) parts.push(`collection=${encodeURIComponent(c)}`);
		if (p) parts.push(`post=${encodeURIComponent(p)}`);
		replaceState(parts.length ? `/posts?${parts.join('&')}` : '/posts', {});
	});

	async function selectCollection(id: string) {
		if (id === activeCollection) return;
		activeCollection = id;
		activePost = null;
		await loadCollection(id);
	}

	async function createCollection() {
		const name = newCollectionName.trim();
		if (!name) return;
		newCollectionOpen = false;
		newCollectionName = '';
		try {
			const created = await apiCreatePostCollection(name);
			await refreshCollections();
			await selectCollection(created.id);
		} catch (e) {
			console.error(e);
			toast.error('Failed to create collection');
		}
	}

	async function createPost() {
		if (!activeCollection) return;
		try {
			const created = await apiCreatePost(activeCollection, { frontmatter: { title: 'Untitled' } });
			await loadCollection(activeCollection);
			await refreshCollections();
			activePost = created.slug;
		} catch (e) {
			console.error(e);
			toast.error('Failed to create post');
		}
	}

	async function deleteCollection(id: string) {
		collectionPendingDelete = null;
		try {
			await apiDeletePostCollection(id);
			if (activeCollection === id) {
				activeCollection = null;
				activePost = null;
				posts = [];
			}
			await refreshCollections();
			if (!activeCollection && collections[0]) await selectCollection(collections[0].id);
		} catch (e) {
			console.error(e);
			toast.error('Failed to delete collection');
		}
	}

	/** After a rename/delete in the editor: reload the list + re-point (or clear) the open post. */
	async function onStructureChanged(newSlug: string | null) {
		if (activeCollection) {
			await loadCollection(activeCollection);
			await refreshCollections();
		}
		activePost = newSlug;
	}

	/** Patch the sidebar row in place after a field autosave — keeps the rail title synced, no refetch. */
	function onPostSaved(info: { slug: string; title: string; draft: boolean }) {
		posts = posts.map((p) =>
			p.slug === info.slug ? { ...p, title: info.title, draft: info.draft } : p
		);
	}

	/** After the shared settings dialog changes the collection (name / icon / schema): reload it. */
	async function onSettingsChanged() {
		if (activeCollection) await loadCollection(activeCollection);
		await refreshCollections();
	}

	/** After the settings dialog deletes the collection: clear + fall back to the first remaining one. */
	async function onCollectionDeleted() {
		activeCollection = null;
		activePost = null;
		posts = [];
		schema = {};
		await refreshCollections();
		if (collections[0]) await selectCollection(collections[0].id);
	}

	/** The shared entity-settings adapter for the active collection (drives EntitySettingsDialog). */
	const settingsAdapter = $derived(
		activeCollection ? postsSettingsAdapter(activeCollection) : null
	);
	const activeCollectionSummary = $derived(collections.find((c) => c.id === activeCollection));
</script>

<div class="flex h-screen w-full overflow-hidden">
	<EntityRail current="posts" collapsed={railCollapsed} onToggleCollapse={toggleRail}>
		{#snippet body()}
			{#if loadingCollections}
				<p class="px-2 py-1 text-xs text-muted-foreground">Loading…</p>
			{:else if collections.length === 0}
				<div class="px-2 py-3 text-center">
					<p class="mb-2 text-xs text-muted-foreground">No collections yet.</p>
					<Button size="sm" variant="outline" onclick={() => (newCollectionOpen = true)}>
						<Plus class="mr-1 size-4" /> New collection
					</Button>
				</div>
			{:else}
				<!-- Collection selector + menu -->
				<div class="mb-2 flex items-center gap-1">
					<Select.Root
						type="single"
						value={activeCollection ?? undefined}
						onValueChange={(v) => v && selectCollection(v)}
					>
						<Select.Trigger class="h-8 flex-1">
							{activeCollectionSummary?.displayName ?? 'Select collection'}
						</Select.Trigger>
						<Select.Content>
							{#each collections as c (c.id)}
								<Select.Item value={c.id}>{c.displayName} ({c.count})</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
					<DropdownMenu.Root>
						<DropdownMenu.Trigger>
							{#snippet child({ props })}
								<Button
									{...props}
									variant="ghost"
									size="icon"
									class="size-8"
									title="Collection menu"
								>
									<MoreVertical class="size-4" />
								</Button>
							{/snippet}
						</DropdownMenu.Trigger>
						<DropdownMenu.Content align="end">
							{#if activeCollection}
								<DropdownMenu.Item onSelect={() => (collectionSettingsOpen = true)}>
									<Settings class="size-4" /> Collection settings…
								</DropdownMenu.Item>
							{/if}
							<DropdownMenu.Item onSelect={() => (newCollectionOpen = true)}>
								<Plus class="size-4" /> New collection
							</DropdownMenu.Item>
							{#if activeCollection}
								<DropdownMenu.Separator />
								<DropdownMenu.Item
									class="text-destructive"
									onSelect={() => (collectionPendingDelete = activeCollection)}
								>
									Delete collection…
								</DropdownMenu.Item>
							{/if}
						</DropdownMenu.Content>
					</DropdownMenu.Root>
				</div>

				<!-- Posts list -->
				<div class="flex min-h-0 flex-1 flex-col gap-0.5">
					{#each posts as p (p.slug)}
						<button
							type="button"
							class="flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent {activePost ===
							p.slug
								? 'bg-accent font-medium'
								: ''}"
							onclick={() => (activePost = p.slug)}
						>
							<FileText class="size-4 shrink-0 text-muted-foreground" />
							<span class="min-w-0 flex-1 truncate">{p.title}</span>
							{#if p.draft}
								<span class="shrink-0 text-[10px] uppercase text-muted-foreground">draft</span>
							{/if}
						</button>
					{:else}
						<p class="px-2 py-2 text-xs text-muted-foreground">No posts yet.</p>
					{/each}
				</div>

				<Button
					size="sm"
					variant="outline"
					class="mt-2"
					onclick={createPost}
					disabled={!activeCollection}
				>
					<Plus class="mr-1 size-4" /> New post
				</Button>
			{/if}
		{/snippet}
	</EntityRail>

	<div class="min-w-0 flex-1">
		{#if activeCollection && activePost}
			{#key `${activeCollection}/${activePost}`}
				<PostsEditorPane
					collection={activeCollection}
					slug={activePost}
					{schema}
					{displayField}
					{onStructureChanged}
					onSaved={onPostSaved}
				/>
			{/key}
		{:else}
			<div class="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
				<PenLine class="size-10 opacity-40" />
				<p class="text-sm">
					{collections.length === 0
						? 'Create a collection to start writing.'
						: activeCollection
							? 'Select or create a post.'
							: 'Select a collection.'}
				</p>
			</div>
		{/if}
	</div>
</div>

<!-- Collection settings (shared dialog: General rename/title-by · Fields schema+reorder · Danger delete) -->
{#if activeCollection && settingsAdapter}
	<EntitySettingsDialog
		adapter={settingsAdapter}
		name={activeCollectionSummary?.displayName ?? activeCollection}
		bind:open={collectionSettingsOpen}
		onchanged={onSettingsChanged}
		ondeleted={onCollectionDeleted}
	/>
{/if}

<!-- New collection dialog -->
<Dialog.Root bind:open={newCollectionOpen}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>New collection</Dialog.Title>
			<Dialog.Description>A folder of posts (e.g. Words, Now).</Dialog.Description>
		</Dialog.Header>
		<Input
			placeholder="Collection name…"
			bind:value={newCollectionName}
			onkeydown={(e) => e.key === 'Enter' && createCollection()}
		/>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (newCollectionOpen = false)}>Cancel</Button>
			<Button onclick={createCollection} disabled={!newCollectionName.trim()}>Create</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<!-- Delete collection confirm -->
<AlertDialog.Root
	open={collectionPendingDelete !== null}
	onOpenChange={(o) => !o && (collectionPendingDelete = null)}
>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Delete this collection?</AlertDialog.Title>
			<AlertDialog.Description>
				This permanently deletes the collection folder and every post inside it.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				onclick={() => collectionPendingDelete && deleteCollection(collectionPendingDelete)}
			>
				Delete
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
