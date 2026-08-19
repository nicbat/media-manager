<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import { toast } from 'svelte-sonner';
	import { Loader2, Check, Trash2, Eye, Pencil } from 'lucide-svelte';
	import { createAutosave } from '$lib/actions/autosave.svelte.js';
	import { apiGetPost, apiWritePost, apiRenamePost, apiDeletePost } from '$lib/api/posts.js';
	import { renderPostPreview } from '$lib/components/posts/renderPreview.js';
	import PostsFrontmatterPanel from '$lib/components/posts/PostsFrontmatterPanel.svelte';
	import PostBodyEditor from '$lib/components/posts/PostBodyEditor.svelte';
	import IslandEditor from '$lib/components/posts/IslandEditor.svelte';
	import type { IslandData } from '$lib/components/posts/tiptap/islands.js';
	import type { SchemaDefinition } from '$lib/core/types.js';

	/**
	 * The **post editor host** for the Posts sub-app (Item 14, converged): a title + editable filename
	 * header, the schema-driven {@link PostsFrontmatterPanel} (fields defined by the collection's shared
	 * schema — managed in Collection settings, exactly like Records), an Edit/Preview body toggle, and a
	 * Delete action. Save policy is the shared {@link createAutosave} (blur / discrete change / 3s idle
	 * safety net; Saving…/Saved; no Save button; never reloads after a field save).
	 *
	 * The body editor is the {@link PostBodyEditor} TipTap block editor (Phase 3), mounted behind the
	 * same `body`-in/`body`-out seam (markdown in on mount, serialized markdown out on change).
	 * `file`-type schema fields round-trip as `mm://<uuid>` on disk
	 * but edit as bare manifest ids — this host converts at the load/save boundary and seeds any schema
	 * field missing from the post's frontmatter so every field has a value to bind.
	 *
	 * @param collection - Collection id the post lives in.
	 * @param slug - The post slug (its `.md` filename stem).
	 * @param schema - The collection's frontmatter schema (drives the fields + their input types).
	 * @param displayField - Which schema field titles the post ('' ⇒ frontmatter `title` → slug).
	 * @param onStructureChanged - Fired after a rename/delete (host reloads its list + fixes the URL).
	 *   Rename passes the new slug; delete passes null.
	 * @param onSaved - Fired after a field autosave with the post's current title/draft, so the host can
	 *   patch the sidebar row in place (keeps the rail title synced without a refetch).
	 */
	let {
		collection,
		slug,
		schema = {},
		displayField = '',
		onStructureChanged,
		onSaved
	}: {
		collection: string;
		slug: string;
		schema?: SchemaDefinition;
		displayField?: string;
		onStructureChanged?: (newSlug: string | null) => void;
		onSaved?: (info: { slug: string; title: string; draft: boolean }) => void;
	} = $props();

	let loading = $state(true);
	let frontmatter = $state<Record<string, unknown>>({});
	let body = $state('');
	let mode = $state<'edit' | 'preview'>('edit');
	let savedSnapshot = $state('');
	let renaming = $state(false);
	let renameValue = $state('');
	let pendingDelete = $state(false);

	/** Handle to the block editor — the host drives island edits (right panel) through its exported API. */
	let bodyEditor = $state<PostBodyEditor>();
	/** The photo block currently selected in the editor, mirrored here so the right panel can edit it. */
	let activeIsland = $state<{ data: IslandData; pos: number } | null>(null);

	/** Schema keys typed as `file` — these round-trip as `mm://<uuid>` on disk. */
	const fileKeys = $derived(
		Object.entries(schema)
			.filter(([, def]) => def.type === 'file')
			.map(([k]) => k)
	);

	/** Type-appropriate empty value, used to seed a schema field missing from a post's frontmatter. */
	function emptyForDef(def: SchemaDefinition[string]): unknown {
		if (def.defaultValue !== undefined) return def.defaultValue;
		const multiselect = (def as { multiselect?: boolean }).multiselect === true;
		if (def.type === 'boolean') return false;
		if (def.type === 'number') return 0;
		if (def.type === 'list') return [];
		if (def.type === 'url') return { display_name: '', url: '' };
		if ((def.type === 'file' || def.type === 'record' || def.type === 'dropdown') && multiselect)
			return [];
		return '';
	}

	/** Strip `mm://` from file-type values so FieldInput/FilePicker sees bare ids, and seed missing schema keys. */
	function toEditForm(fm: Record<string, unknown>): Record<string, unknown> {
		const out = { ...fm };
		for (const [key, def] of Object.entries(schema)) {
			if (out[key] === undefined) out[key] = emptyForDef(def);
		}
		for (const k of fileKeys) {
			const v = out[k];
			if (typeof v === 'string' && v.startsWith('mm://')) out[k] = v.slice('mm://'.length);
		}
		return out;
	}

	/** Re-add `mm://` to non-empty file-type values for disk. */
	function toDiskForm(fm: Record<string, unknown>): Record<string, unknown> {
		const out = { ...fm };
		for (const k of fileKeys) {
			const v = out[k];
			if (typeof v === 'string' && v && !v.startsWith('mm://')) out[k] = `mm://${v}`;
		}
		return out;
	}

	function snapshot(): string {
		return JSON.stringify({ frontmatter, body });
	}

	const dirty = $derived(!loading && savedSnapshot !== '' && snapshot() !== savedSnapshot);

	async function load() {
		loading = true;
		try {
			const post = await apiGetPost(collection, slug);
			frontmatter = toEditForm(post.frontmatter);
			body = post.body;
			savedSnapshot = snapshot();
		} catch (e) {
			console.error(e);
			toast.error('Failed to load post');
		} finally {
			loading = false;
		}
	}

	// Reload only when the host points us at a different post. NOT on schema changes: the panel reads
	// `schema` reactively, and reloading on a schema change (e.g. right after a rename, when the host
	// refreshes the collection) would re-read this post from a now-stale slug and 404.
	$effect(() => {
		void collection;
		void slug;
		void load();
	});

	/** The post's display title: the `displayField` value, else frontmatter `title`, else the slug. */
	function currentTitle(): string {
		const byField = displayField ? frontmatter[displayField] : undefined;
		if (typeof byField === 'string' && byField.trim()) return byField;
		if (typeof frontmatter.title === 'string' && frontmatter.title.trim()) return frontmatter.title;
		return slug;
	}

	async function save() {
		if (!dirty) return;
		const persisted = snapshot();
		await apiWritePost(collection, slug, { frontmatter: toDiskForm(frontmatter), body });
		savedSnapshot = persisted;
		onSaved?.({ slug, title: currentTitle(), draft: frontmatter.draft === true });
	}

	const autosave = createAutosave({
		isDirty: () => dirty,
		save,
		errorMessage: 'Failed to save post'
	});

	async function doRename() {
		const next = renameValue.trim();
		renaming = false;
		if (!next || next === slug) return;
		await autosave.commit();
		try {
			const newSlug = await apiRenamePost(collection, slug, next);
			onStructureChanged?.(newSlug);
		} catch (e) {
			console.error(e);
			toast.error((e as Error).message ?? 'Failed to rename post');
		}
	}

	async function doDelete() {
		pendingDelete = false;
		autosave.cancel();
		try {
			await apiDeletePost(collection, slug);
			onStructureChanged?.(null);
		} catch (e) {
			console.error(e);
			toast.error('Failed to delete post');
		}
	}

	$effect(() => {
		const handler = () => {
			if (dirty) void save().catch((err) => console.error(err));
		};
		window.addEventListener('beforeunload', handler);
		return () => window.removeEventListener('beforeunload', handler);
	});

	const title = $derived(
		(() => {
			void frontmatter;
			return currentTitle();
		})()
	);
	const previewHtml = $derived(mode === 'preview' ? renderPostPreview(body) : '');
</script>

<div class="flex h-dvh w-full overflow-hidden bg-muted/20">
	<!-- Writing column (middle) -->
	<div class="flex min-w-0 flex-1 flex-col overflow-hidden">
		<!-- Header: title + filename + Edit/Preview -->
		<div class="sticky top-0 z-10 border-b bg-background/95 px-5 py-3 backdrop-blur">
			<div class="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-3">
				<div class="flex min-w-0 flex-col">
					<span class="truncate text-lg font-semibold leading-tight">{title}</span>
					<!-- Explicit filename (slug) editing -->
					{#if renaming}
						<Input
							class="mt-1 h-6 w-56 text-xs"
							bind:value={renameValue}
							placeholder="filename"
							onkeydown={(e) => {
								// Commit via a single path (blur) so Enter can't also fire a second (stale) rename.
								if (e.key === 'Enter') e.currentTarget.blur();
								if (e.key === 'Escape') {
									renameValue = slug; // revert → doRename no-ops (next === slug)
									e.currentTarget.blur();
								}
							}}
							onblur={doRename}
						/>
					{:else}
						<button
							type="button"
							class="w-fit truncate text-xs text-muted-foreground hover:text-foreground hover:underline"
							title="Rename file"
							onclick={() => {
								renameValue = slug;
								renaming = true;
							}}
						>
							{slug}.md
						</button>
					{/if}
				</div>

				<!-- Edit / Preview toggle -->
				<div class="ml-auto inline-flex overflow-hidden rounded-md border">
					<Button
						variant={mode === 'edit' ? 'secondary' : 'ghost'}
						size="sm"
						class="rounded-none"
						onclick={() => (mode = 'edit')}
					>
						<Pencil class="mr-1 size-4" /> Edit
					</Button>
					<Button
						variant={mode === 'preview' ? 'secondary' : 'ghost'}
						size="sm"
						class="rounded-none"
						onclick={() => {
							void autosave.commit();
							activeIsland = null;
							mode = 'preview';
						}}
					>
						<Eye class="mr-1 size-4" /> Preview
					</Button>
				</div>
			</div>
		</div>

		<!-- Body -->
		{#if loading}
			<p class="p-6 text-muted-foreground">Loading…</p>
		{:else}
			<div class="mx-auto flex w-full max-w-3xl flex-1 flex-col overflow-y-auto px-5 py-5">
				{#if mode === 'edit'}
					<!-- Block editor behind the same body-in/out seam: content in on mount, serialized markdown
					     out on change; commit intents drive the shared autosave. Island selection is mirrored
					     to the right panel, which edits it through the editor's exported API. -->
					{#key `${collection}/${slug}`}
						<PostBodyEditor
							bind:this={bodyEditor}
							content={body}
							onChange={(md) => (body = md)}
							oncommit={() => autosave.commit()}
							onIslandSelect={(i) => (activeIsland = i)}
						/>
					{/key}
				{:else}
					<div
						class="prose prose-sm mm-post-preview max-w-none rounded-lg border bg-background p-6"
					>
						<!-- Local-first single-user app: the previewed HTML is the user's own post markdown,
						     rendered client-side for their own eyes. No untrusted input crosses this boundary. -->
						<!-- eslint-disable-next-line svelte/no-at-html-tags -->
						{@html previewHtml}
					</div>
				{/if}
			</div>
		{/if}
	</div>

	<!-- Metadata panel (right) -->
	<aside class="flex w-80 shrink-0 flex-col overflow-hidden border-l bg-background">
		<div class="flex items-center justify-between border-b px-4 py-3">
			<h2 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
				Post details
			</h2>
			<div class="text-xs text-muted-foreground">
				{#if autosave.status === 'saving'}
					<Loader2 class="mr-1 inline size-3 animate-spin" /> Saving…
				{:else if autosave.status === 'saved' && !dirty}
					<Check class="mr-1 inline size-3 text-green-600" /> Saved
				{:else if autosave.status === 'error'}
					<span class="text-destructive">Failed to save</span>
				{/if}
			</div>
		</div>

		<div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
			<!-- Selected photo block (edited in place, without leaving the panel) -->
			{#if mode === 'edit' && activeIsland}
				<IslandEditor
					data={activeIsland.data}
					pos={activeIsland.pos}
					onField={(patch) => bodyEditor?.islandSetField(patch)}
					onConvert={(kind) => bodyEditor?.islandConvert(kind)}
					onChangePhoto={(field) => bodyEditor?.islandChangePhoto(field)}
					onDelete={() => bodyEditor?.islandDelete()}
				/>
			{/if}

			<!-- Frontmatter -->
			<section>
				<h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					Frontmatter
				</h3>
				{#if loading}
					<p class="text-sm text-muted-foreground">Loading…</p>
				{:else}
					<PostsFrontmatterPanel bind:frontmatter {schema} oncommit={() => autosave.commit()} />
				{/if}
			</section>
		</div>

		<!-- Danger -->
		<div class="border-t p-3">
			<Button
				variant="ghost"
				size="sm"
				class="w-full justify-start text-muted-foreground hover:text-destructive"
				onclick={() => (pendingDelete = true)}
			>
				<Trash2 class="mr-2 size-4" /> Delete post
			</Button>
		</div>
	</aside>
</div>

<AlertDialog.Root open={pendingDelete} onOpenChange={(o) => (pendingDelete = o)}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Delete “{title}”?</AlertDialog.Title>
			<AlertDialog.Description>
				This permanently deletes the <code>{slug}.md</code> file. This can't be undone.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action onclick={doDelete}>Delete</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<style>
	/*
	 * Preview typography. The app doesn't load the Tailwind `typography` plugin, so the `prose` class is
	 * inert and preflight strips list markers — style the rendered markdown explicitly. `:global` is
	 * required because the HTML is injected via `{@html}` (Svelte's scoping can't reach it); we keep it
	 * tightly scoped under `.mm-post-preview`.
	 */
	.mm-post-preview :global(h1),
	.mm-post-preview :global(h2),
	.mm-post-preview :global(h3) {
		font-weight: 600;
		line-height: 1.25;
		margin: 1.25rem 0 0.5rem;
	}
	.mm-post-preview :global(h1) {
		font-size: 1.6rem;
	}
	.mm-post-preview :global(h2) {
		font-size: 1.3rem;
	}
	.mm-post-preview :global(h3) {
		font-size: 1.1rem;
	}
	.mm-post-preview :global(p) {
		margin: 0.75rem 0;
		line-height: 1.7;
	}
	.mm-post-preview :global(ul) {
		list-style: disc;
		padding-left: 1.5rem;
		margin: 0.75rem 0;
	}
	.mm-post-preview :global(ol) {
		list-style: decimal;
		padding-left: 1.5rem;
		margin: 0.75rem 0;
	}
	.mm-post-preview :global(li) {
		margin: 0.25rem 0;
	}
	.mm-post-preview :global(li > ul),
	.mm-post-preview :global(li > ol) {
		margin: 0.25rem 0;
	}
	.mm-post-preview :global(a) {
		color: var(--primary);
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.mm-post-preview :global(a:hover) {
		opacity: 0.8;
	}
	.mm-post-preview :global(blockquote) {
		border-left: 3px solid var(--border);
		padding-left: 1rem;
		margin: 1rem 0;
		color: var(--muted-foreground);
	}
	.mm-post-preview :global(:not(pre) > code) {
		background: var(--muted);
		padding: 0.1em 0.35em;
		border-radius: 4px;
		font-size: 0.9em;
	}
	.mm-post-preview :global(pre) {
		overflow-x: auto;
		border-radius: 8px;
		padding: 1rem;
		margin: 1rem 0;
		background: var(--muted);
		font-size: 0.9em;
	}
	.mm-post-preview :global(img) {
		max-width: 100%;
		height: auto;
		border-radius: 6px;
	}
	.mm-post-preview :global(hr) {
		border: none;
		border-top: 1px solid var(--border);
		margin: 1.5rem 0;
	}
</style>
