<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { Editor, getSchema, type Range } from '@tiptap/core';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import * as Popover from '$lib/components/ui/popover/index.js';
	import { Bold, Italic, Code, Link, Image as ImageIcon, ChevronDown } from 'lucide-svelte';
	import FilePicker from '$lib/components/FilePicker.svelte';
	import { postExtensions } from './tiptap/extensions.js';
	import { docToMarkdown, markdownToDoc } from './tiptap/serialize.js';
	import { buildIsland, parseIsland, type IslandData, type IslandKind } from './tiptap/islands.js';
	import {
		createSlashCommands,
		type SlashHandlers,
		type SlashItem,
		type SlashPopupProps
	} from './tiptap/slash.js';
	import '$lib/reader/posts.css';

	/**
	 * The **Posts block editor** (Item 14): a Notion-style TipTap/ProseMirror editor behind the unchanged
	 * `body`-in / `body`-out seam. Prose is real WYSIWYG Markdown, the four `mm-*` photo blocks are opaque
	 * HTML islands inserted from the shared {@link FilePicker}, and code stays a native fenced block. Save
	 * is intent-driven exactly as before — this component never persists; it emits body changes
	 * ({@link onChange}) and commit intents ({@link oncommit}).
	 *
	 * Two surfaces live here: a shadcn **toolbar** and a **slash menu** (`/` on any line → the same block
	 * / photo commands, keyboard-first). Editing a *selected* island happens in the host's right-hand
	 * metadata panel, not here: this component owns the editor + selection and exposes imperative island
	 * mutators ({@link islandSetField} / {@link islandConvert} / {@link islandChangePhoto} /
	 * {@link islandDelete}) plus an {@link onIslandSelect} notification, so the host renders the island's
	 * editor ({@link IslandEditor}) and drives it through this component's `bind:this` handle.
	 *
	 * The markdown ↔ doc conversion is the spike-verified {@link docToMarkdown}/{@link markdownToDoc}
	 * bridge (byte-stable + idempotent). `content` is read once on mount; the host remounts (`{#key slug}`)
	 * to load a different post.
	 *
	 * @param content - Initial markdown body (read on mount only).
	 * @param onChange - Fired on every doc update with the serialized markdown (host updates `body`; no save).
	 * @param oncommit - Fired on blur / discrete structural edit (host commits via autosave).
	 * @param onIslandSelect - Fired when the node selection enters/leaves an island (host shows its editor).
	 */
	let {
		content,
		onChange,
		oncommit,
		onIslandSelect
	}: {
		content: string;
		onChange: (markdown: string) => void;
		oncommit: () => void;
		onIslandSelect?: (island: { data: IslandData; pos: number } | null) => void;
	} = $props();

	let element: HTMLDivElement;
	let editor = $state<Editor | undefined>();
	/** Bumped on every transaction so `$derived` toolbar/selection state recomputes (TipTap isn't reactive). */
	let tick = $state(0);

	// --- Photo picker (shared FilePicker in controlled/triggerless mode) ---
	let pickerOpen = $state(false);
	/** Set while inserting a new island (which kind); null when the picker targets an existing island. */
	let pendingKind = $state<IslandKind | null>(null);
	/** Which image slot of the selected island the picker will fill on select. */
	let pendingField = $state<'primary' | 'B' | null>(null);

	// --- Link popover ---
	let linkOpen = $state(false);
	let linkUrl = $state('');

	// --- Slash menu state (driven by the Suggestion plugin's render lifecycle) ---
	let slashOpen = $state(false);
	let slashProps = $state<SlashPopupProps | null>(null);
	let slashIndex = $state(0);

	/** The currently node-selected `htmlIsland` (its doc position + parsed fields), else null. */
	const selectedIsland = $derived.by(() => {
		void tick;
		if (!editor) return null;
		const sel = editor.state.selection as unknown as {
			node?: { type: { name: string }; attrs: { html: string } };
			from: number;
		};
		if (sel.node && sel.node.type.name === 'htmlIsland') {
			return { pos: sel.from, data: parseIsland(sel.node.attrs.html) };
		}
		return null;
	});

	// Notify the host so it can show/hide the island editor in the right panel.
	$effect(() => {
		const isl = selectedIsland;
		onIslandSelect?.(isl?.data ? { data: isl.data, pos: isl.pos } : null);
	});

	// --- Slash command list (same actions as the toolbar) ---
	const del = (editor: Editor, range: Range) => editor.chain().focus().deleteRange(range);
	const slashItems: SlashItem[] = [
		{
			title: 'Heading 2',
			group: 'Basic',
			keywords: ['h2', 'title'],
			run: ({ editor, range }) => del(editor, range).toggleHeading({ level: 2 }).run()
		},
		{
			title: 'Heading 3',
			group: 'Basic',
			keywords: ['h3', 'subtitle'],
			run: ({ editor, range }) => del(editor, range).toggleHeading({ level: 3 }).run()
		},
		{
			title: 'Bullet list',
			group: 'Basic',
			keywords: ['ul', 'unordered', 'list'],
			run: ({ editor, range }) => del(editor, range).toggleBulletList().run()
		},
		{
			title: 'Numbered list',
			group: 'Basic',
			keywords: ['ol', 'ordered', 'list'],
			run: ({ editor, range }) => del(editor, range).toggleOrderedList().run()
		},
		{
			title: 'Quote',
			group: 'Basic',
			keywords: ['blockquote'],
			run: ({ editor, range }) => del(editor, range).toggleBlockquote().run()
		},
		{
			title: 'Code block',
			group: 'Basic',
			keywords: ['pre', 'fence', 'code'],
			run: ({ editor, range }) => del(editor, range).toggleCodeBlock().run()
		},
		{
			title: 'Divider',
			group: 'Basic',
			keywords: ['hr', 'rule', 'separator'],
			run: ({ editor, range }) => del(editor, range).setHorizontalRule().run()
		},
		{
			title: 'Inline photo',
			group: 'Photos',
			keywords: ['image', 'img'],
			run: ({ editor, range }) => {
				del(editor, range).run();
				startInsertIsland('mm-inline');
			}
		},
		{
			title: 'Text beside photo',
			group: 'Photos',
			keywords: ['beside', 'text'],
			run: ({ editor, range }) => {
				del(editor, range).run();
				startInsertIsland('mm-beside');
			}
		},
		{
			title: 'Side-by-side pair',
			group: 'Photos',
			keywords: ['pair', 'two', 'gallery'],
			run: ({ editor, range }) => {
				del(editor, range).run();
				startInsertIsland('mm-pair');
			}
		},
		{
			title: 'Full-bleed banner',
			group: 'Photos',
			keywords: ['bleed', 'banner', 'wide', 'cover'],
			run: ({ editor, range }) => {
				del(editor, range).run();
				startInsertIsland('mm-bleed');
			}
		}
	];

	const slashHandlers: SlashHandlers = {
		onStart: (p) => {
			slashProps = p;
			slashOpen = true;
			slashIndex = 0;
		},
		onUpdate: (p) => {
			slashProps = p;
			slashIndex = Math.min(slashIndex, Math.max(0, p.items.length - 1));
		},
		onKeyDown: (event) => {
			if (!slashOpen || !slashProps) return false;
			const n = slashProps.items.length;
			if (n === 0) return false;
			if (event.key === 'ArrowDown') {
				slashIndex = (slashIndex + 1) % n;
				return true;
			}
			if (event.key === 'ArrowUp') {
				slashIndex = (slashIndex - 1 + n) % n;
				return true;
			}
			if (event.key === 'Enter') {
				const it = slashProps.items[slashIndex];
				if (it) slashProps.command(it);
				return true;
			}
			if (event.key === 'Escape') {
				slashOpen = false;
				return true;
			}
			return false;
		},
		onExit: () => {
			slashOpen = false;
			slashProps = null;
		}
	};

	/** Group the (already group-ordered) slash items for the menu's section headers. */
	function groupedSlash(items: SlashItem[]): { group: string; items: SlashItem[] }[] {
		const out: { group: string; items: SlashItem[] }[] = [];
		for (const it of items) {
			let g = out.find((x) => x.group === it.group);
			if (!g) {
				g = { group: it.group, items: [] };
				out.push(g);
			}
			g.items.push(it);
		}
		return out;
	}

	onMount(() => {
		const base = postExtensions();
		// Schema is built from `base` only; the slash extension adds no nodes/marks, so the editor's own
		// schema is identical and the JSON doc parses cleanly.
		const schema = getSchema(base);
		const initial = markdownToDoc(content, schema).toJSON();
		const slash = createSlashCommands({ items: slashItems, handlers: slashHandlers });
		editor = new Editor({
			element,
			extensions: [...base, slash],
			content: initial,
			editorProps: { attributes: { class: 'mm-post-body focus:outline-none' } },
			onUpdate: ({ editor }) => onChange(docToMarkdown(editor.state.doc)),
			onBlur: () => oncommit(),
			onTransaction: () => (tick += 1)
		});
	});

	onDestroy(() => editor?.destroy());

	const isActive = (name: string, attrs?: Record<string, unknown>): boolean => {
		void tick;
		return editor?.isActive(name, attrs) ?? false;
	};

	// --- Insert / mutate islands ---
	function startInsertIsland(kind: IslandKind) {
		pendingKind = kind;
		pendingField = null;
		pickerOpen = true;
	}

	function insertIsland(html: string) {
		editor?.chain().focus().insertContent({ type: 'htmlIsland', attrs: { html } }).run();
		oncommit();
	}

	function updateSelectedIsland(mutate: (d: IslandData) => IslandData) {
		const isl = selectedIsland;
		if (!editor || !isl?.data) return;
		const next = buildIsland(mutate(isl.data));
		editor
			.chain()
			.focus()
			.command(({ tr }) => {
				tr.setNodeAttribute(isl.pos, 'html', next);
				return true;
			})
			.run();
		oncommit();
	}

	function onPicked(v: string | string[]) {
		const id = Array.isArray(v) ? v[0] : v;
		pickerOpen = false;
		if (!id) return;
		if (pendingKind) {
			const data: IslandData = { kind: pendingKind, uuid: id };
			if (pendingKind === 'mm-pair') data.uuidB = id;
			if (pendingKind === 'mm-beside') {
				data.side = 'right';
				data.text = 'Add your prose here.';
			}
			insertIsland(buildIsland(data));
			pendingKind = null;
		} else if (pendingField) {
			const field = pendingField;
			updateSelectedIsland((d) => (field === 'B' ? { ...d, uuidB: id } : { ...d, uuid: id }));
			pendingField = null;
		}
	}

	// --- Public island API (driven by the host's IslandEditor in the right panel) ---
	/** Merge a field patch into the selected island and rebuild its markup. */
	export function islandSetField(patch: Partial<IslandData>): void {
		updateSelectedIsland((d) => ({ ...d, ...patch }));
	}

	/** Convert the selected island to another kind in place, seeding fields the new kind needs. */
	export function islandConvert(kind: IslandKind): void {
		updateSelectedIsland((d) => {
			const next: IslandData = { ...d, kind };
			if (kind === 'mm-pair' && !next.uuidB) next.uuidB = next.uuid;
			if (kind === 'mm-beside') {
				next.side = next.side ?? 'right';
				if (next.text === undefined) next.text = '';
			}
			return next;
		});
	}

	/** Open the picker to replace the selected island's primary image (or the pair's second image). */
	export function islandChangePhoto(field: 'primary' | 'B'): void {
		pendingKind = null;
		pendingField = field;
		pickerOpen = true;
	}

	/** Delete the selected island from the document. */
	export function islandDelete(): void {
		editor?.chain().focus().deleteSelection().run();
		oncommit();
	}

	// --- Prose block / mark commands ---
	const c = () => editor?.chain().focus();
	function applyLink() {
		const url = linkUrl.trim();
		linkOpen = false;
		if (!url) {
			c()?.unsetLink().run();
		} else {
			c()?.extendMarkRange('link').setLink({ href: url }).run();
		}
		linkUrl = '';
	}
</script>

<div class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border bg-background">
	<!-- Toolbar -->
	<div class="flex flex-wrap items-center gap-1 border-b px-2 py-1.5">
		<Button
			variant={isActive('bold') ? 'secondary' : 'ghost'}
			size="icon"
			class="size-8"
			title="Bold"
			onclick={() => c()?.toggleBold().run()}
		>
			<Bold class="size-4" />
		</Button>
		<Button
			variant={isActive('italic') ? 'secondary' : 'ghost'}
			size="icon"
			class="size-8"
			title="Italic"
			onclick={() => c()?.toggleItalic().run()}
		>
			<Italic class="size-4" />
		</Button>
		<Button
			variant={isActive('code') ? 'secondary' : 'ghost'}
			size="icon"
			class="size-8"
			title="Inline code"
			onclick={() => c()?.toggleCode().run()}
		>
			<Code class="size-4" />
		</Button>

		<Popover.Root bind:open={linkOpen}>
			<Popover.Trigger>
				{#snippet child({ props })}
					<Button
						{...props}
						variant={isActive('link') ? 'secondary' : 'ghost'}
						size="icon"
						class="size-8"
						title="Link"
						onclick={() => {
							linkUrl = (editor?.getAttributes('link').href as string) ?? '';
							linkOpen = true;
						}}
					>
						<Link class="size-4" />
					</Button>
				{/snippet}
			</Popover.Trigger>
			<Popover.Content class="w-72 space-y-2">
				<Input
					placeholder="https://…"
					bind:value={linkUrl}
					onkeydown={(e) => {
						if (e.key === 'Enter') {
							// Without preventDefault the same Enter re-activates the trigger button (which
							// regains focus as the popover closes), immediately reopening the popover.
							e.preventDefault();
							applyLink();
						}
					}}
				/>
				<p class="text-xs text-muted-foreground">
					Links to other sites open in a new tab automatically.
				</p>
				<div class="flex justify-end gap-2">
					<Button variant="ghost" size="sm" onclick={() => c()?.unsetLink().run()}>Remove</Button>
					<Button size="sm" onclick={applyLink}>Apply</Button>
				</div>
			</Popover.Content>
		</Popover.Root>

		<div class="mx-1 h-5 w-px bg-border"></div>

		<!-- Block types -->
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button {...props} variant="ghost" size="sm" class="h-8 gap-1">
						Block <ChevronDown class="size-3.5" />
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="start">
				<DropdownMenu.Item onSelect={() => c()?.toggleHeading({ level: 2 }).run()}>
					Heading 2
				</DropdownMenu.Item>
				<DropdownMenu.Item onSelect={() => c()?.toggleHeading({ level: 3 }).run()}>
					Heading 3
				</DropdownMenu.Item>
				<DropdownMenu.Item onSelect={() => c()?.setParagraph().run()}>Paragraph</DropdownMenu.Item>
				<DropdownMenu.Separator />
				<DropdownMenu.Item onSelect={() => c()?.toggleBlockquote().run()}>Quote</DropdownMenu.Item>
				<DropdownMenu.Item onSelect={() => c()?.toggleBulletList().run()}>
					Bullet list
				</DropdownMenu.Item>
				<DropdownMenu.Item onSelect={() => c()?.toggleOrderedList().run()}>
					Numbered list
				</DropdownMenu.Item>
				<DropdownMenu.Item onSelect={() => c()?.toggleCodeBlock().run()}
					>Code block</DropdownMenu.Item
				>
				<DropdownMenu.Item onSelect={() => c()?.setHorizontalRule().run()}
					>Divider</DropdownMenu.Item
				>
			</DropdownMenu.Content>
		</DropdownMenu.Root>

		<!-- Photo blocks -->
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button {...props} variant="ghost" size="sm" class="h-8 gap-1">
						<ImageIcon class="size-4" /> Photo <ChevronDown class="size-3.5" />
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="start">
				<DropdownMenu.Item onSelect={() => startInsertIsland('mm-inline')}>
					Inline photo
				</DropdownMenu.Item>
				<DropdownMenu.Item onSelect={() => startInsertIsland('mm-beside')}>
					Text beside photo
				</DropdownMenu.Item>
				<DropdownMenu.Item onSelect={() => startInsertIsland('mm-pair')}>
					Side-by-side pair
				</DropdownMenu.Item>
				<DropdownMenu.Item onSelect={() => startInsertIsland('mm-bleed')}>
					Full-bleed banner
				</DropdownMenu.Item>
			</DropdownMenu.Content>
		</DropdownMenu.Root>

		<span class="ml-auto pr-1 text-xs text-muted-foreground">
			Type <kbd class="rounded border bg-muted px-1 font-mono text-[10px]">/</kbd> for commands
		</span>
	</div>

	<!-- Editor surface -->
	<div bind:this={element} class="min-h-[24rem] flex-1 overflow-y-auto px-4 py-4"></div>
</div>

<!-- Shared photo picker (global hub), driven programmatically -->
<FilePicker trigger={false} bind:open={pickerOpen} onSelect={onPicked} />

<!-- Slash command menu (fixed at the caret; escapes the editor's overflow) -->
{#if slashOpen && slashProps && slashProps.items.length > 0}
	{@const rect = slashProps.clientRect?.()}
	{@const props = slashProps}
	<div
		class="fixed z-50 max-h-72 w-56 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
		style="left: {rect?.left ?? 0}px; top: {(rect?.bottom ?? 0) + 6}px"
	>
		{#each groupedSlash(props.items) as g (g.group)}
			<div
				class="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
			>
				{g.group}
			</div>
			{#each g.items as it (it.title)}
				{@const gi = props.items.indexOf(it)}
				<button
					type="button"
					class="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm {gi ===
					slashIndex
						? 'bg-accent text-accent-foreground'
						: ''}"
					onmouseenter={() => (slashIndex = gi)}
					onmousedown={(e) => {
						e.preventDefault();
						props.command(it);
					}}
				>
					{it.title}
				</button>
			{/each}
		{/each}
	</div>
{/if}

<style>
	/* Editor typography + island framing. Global because ProseMirror renders its own DOM subtree. */
	:global(.mm-post-body) {
		min-height: 20rem;
		line-height: 1.7;
	}
	:global(.mm-post-body:focus) {
		outline: none;
	}
	:global(.mm-post-body h2) {
		font-size: 1.35rem;
		font-weight: 600;
		margin: 1.25rem 0 0.5rem;
	}
	:global(.mm-post-body h3) {
		font-size: 1.1rem;
		font-weight: 600;
		margin: 1rem 0 0.4rem;
	}
	:global(.mm-post-body p) {
		margin: 0.6rem 0;
	}
	:global(.mm-post-body ul) {
		list-style: disc;
		padding-left: 1.5rem;
		margin: 0.6rem 0;
	}
	:global(.mm-post-body ol) {
		list-style: decimal;
		padding-left: 1.5rem;
		margin: 0.6rem 0;
	}
	:global(.mm-post-body blockquote) {
		border-left: 3px solid var(--border);
		padding-left: 1rem;
		margin: 0.8rem 0;
		color: var(--muted-foreground);
	}
	:global(.mm-post-body a) {
		color: var(--primary);
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	:global(.mm-post-body pre) {
		background: var(--muted);
		border-radius: 8px;
		padding: 0.9rem 1rem;
		overflow-x: auto;
		font-size: 0.9em;
		margin: 0.8rem 0;
	}
	:global(.mm-post-body :not(pre) > code) {
		background: var(--muted);
		padding: 0.1em 0.35em;
		border-radius: 4px;
		font-size: 0.9em;
	}
	:global(.mm-post-body img) {
		max-width: 100%;
		height: auto;
		border-radius: 6px;
	}
	/* Island node view: a selectable framed block. */
	:global(.mm-island-node) {
		margin: 1rem 0;
		border: 1px solid transparent;
		border-radius: 8px;
		transition: border-color 0.1s;
	}
	:global(.mm-post-body .ProseMirror-selectednode.mm-island-node),
	:global(.mm-island-node.ProseMirror-selectednode) {
		border-color: var(--primary);
		box-shadow: 0 0 0 1px var(--primary);
	}
	/* Keep full-bleed islands inside the narrow editor column (they break to 100vw at render time). */
	:global(.mm-post-body .mm-bleed) {
		width: 100%;
		left: 0;
		margin-left: 0;
	}
</style>
