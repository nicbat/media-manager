<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { Trash2, ImageOff } from 'lucide-svelte';
	import { autogrow } from '$lib/actions/autogrow.js';
	import type { IslandData, IslandKind } from './tiptap/islands.js';

	/**
	 * The editor for a selected photo block (`mm-*` island), shown in the Posts editor's **right metadata
	 * panel** (Item 14 layout redesign). It replaces the old cramped inline edit-bar: `PostBodyEditor`
	 * owns the ProseMirror editor + selection and exposes imperative mutators; this component is the
	 * presentational panel that drives them.
	 *
	 * Two conveniences beyond the old bar: a **kind switcher** that converts a block in place
	 * (inline ↔ beside ↔ pair ↔ bleed) without re-picking the photo, and a **full-height prose textarea**
	 * for the "text beside photo" block (blank lines become separate paragraphs at build time).
	 *
	 * Text buffers (caption / captionB / prose) are local and only pushed up on blur, so typing never
	 * rebuilds the island mid-keystroke. They re-sync when {@link pos} changes — i.e. a *different* island
	 * is selected — not on same-island rebuilds, so an edit never clobbers itself.
	 *
	 * @param data - The selected island's parsed fields.
	 * @param pos - The island's document position (identity: changes ⇒ a new island is selected).
	 * @param onField - Merge a field patch into the island (rebuilds its markup).
	 * @param onConvert - Convert the island to another kind, preserving shared fields.
	 * @param onChangePhoto - Open the picker to replace the primary image, or the pair's second image.
	 * @param onDelete - Remove the island from the document.
	 */
	let {
		data,
		pos,
		onField,
		onConvert,
		onChangePhoto,
		onDelete
	}: {
		data: IslandData;
		pos: number;
		onField: (patch: Partial<IslandData>) => void;
		onConvert: (kind: IslandKind) => void;
		onChangePhoto: (field: 'primary' | 'B') => void;
		onDelete: () => void;
	} = $props();

	const KINDS: { value: IslandKind; label: string }[] = [
		{ value: 'mm-inline', label: 'Inline photo' },
		{ value: 'mm-beside', label: 'Text beside photo' },
		{ value: 'mm-pair', label: 'Side-by-side pair' },
		{ value: 'mm-bleed', label: 'Full-bleed banner' }
	];
	const kindLabel = $derived(KINDS.find((k) => k.value === data.kind)?.label ?? 'Photo block');

	// Local text buffers — re-synced only when a *different* island is selected (pos changes).
	let caption = $state('');
	let captionB = $state('');
	let prose = $state('');
	let synced = $state(-1);
	$effect(() => {
		if (pos !== synced) {
			synced = pos;
			caption = data.caption ?? '';
			captionB = data.captionB ?? '';
			prose = data.text ?? '';
		}
	});
</script>

<div class="flex flex-col gap-3 rounded-lg border border-primary/40 bg-primary/[0.03] p-3">
	<div class="flex items-center justify-between">
		<span class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
			{kindLabel}
		</span>
		<Button
			variant="ghost"
			size="icon"
			class="size-7 text-muted-foreground hover:text-destructive"
			title="Delete block"
			onclick={onDelete}
		>
			<Trash2 class="size-4" />
		</Button>
	</div>

	<!-- Kind switcher (convert in place) -->
	<div class="flex flex-col gap-1.5">
		<Label class="text-xs text-muted-foreground">Layout</Label>
		<Select.Root
			type="single"
			value={data.kind}
			onValueChange={(v) => v && v !== data.kind && onConvert(v as IslandKind)}
		>
			<Select.Trigger class="h-8">{kindLabel}</Select.Trigger>
			<Select.Content>
				{#each KINDS as k (k.value)}
					<Select.Item value={k.value}>{k.label}</Select.Item>
				{/each}
			</Select.Content>
		</Select.Root>
	</div>

	<!-- Primary photo -->
	<Button
		variant="outline"
		size="sm"
		class="justify-start"
		onclick={() => onChangePhoto('primary')}
	>
		<ImageOff class="mr-2 size-4" />
		{data.uuid ? 'Change photo' : 'Choose photo'}
	</Button>

	<!-- Beside: side toggle + roomy prose -->
	{#if data.kind === 'mm-beside'}
		<div class="flex flex-col gap-1.5">
			<Label class="text-xs text-muted-foreground">Image side</Label>
			<div class="inline-flex overflow-hidden rounded-md border">
				<Button
					variant={data.side !== 'left' ? 'secondary' : 'ghost'}
					size="sm"
					class="flex-1 rounded-none"
					onclick={() => onField({ side: 'right' })}
				>
					Right
				</Button>
				<Button
					variant={data.side === 'left' ? 'secondary' : 'ghost'}
					size="sm"
					class="flex-1 rounded-none"
					onclick={() => onField({ side: 'left' })}
				>
					Left
				</Button>
			</div>
		</div>
		<div class="flex flex-col gap-1.5">
			<Label for="island-prose" class="text-xs text-muted-foreground">Prose beside the image</Label>
			<textarea
				id="island-prose"
				class="min-h-[7rem] w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
				placeholder="Write as much as you like — a blank line starts a new paragraph."
				bind:value={prose}
				use:autogrow={prose}
				onblur={() => onField({ text: prose })}
			></textarea>
		</div>
	{/if}

	<!-- Captions (inline / bleed / pair) -->
	{#if data.kind !== 'mm-beside'}
		<div class="flex flex-col gap-1.5">
			<Label for="island-cap" class="text-xs text-muted-foreground">
				{data.kind === 'mm-pair' ? 'Caption A' : 'Caption'}
			</Label>
			<Input
				id="island-cap"
				class="h-8"
				placeholder="Optional caption…"
				bind:value={caption}
				onblur={() => onField({ caption })}
			/>
		</div>
	{/if}

	<!-- Pair: second image + caption -->
	{#if data.kind === 'mm-pair'}
		<Button variant="outline" size="sm" class="justify-start" onclick={() => onChangePhoto('B')}>
			<ImageOff class="mr-2 size-4" />
			{data.uuidB ? 'Change photo B' : 'Choose photo B'}
		</Button>
		<div class="flex flex-col gap-1.5">
			<Label for="island-capb" class="text-xs text-muted-foreground">Caption B</Label>
			<Input
				id="island-capb"
				class="h-8"
				placeholder="Optional caption…"
				bind:value={captionB}
				onblur={() => onField({ captionB })}
			/>
		</div>
	{/if}
</div>
