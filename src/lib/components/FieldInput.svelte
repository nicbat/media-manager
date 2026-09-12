<script lang="ts">
	import type { FieldDefinition, UrlValue, ListItemType } from '$lib/core/types.js';
	import { normalizeUrlValue } from '$lib/core/types.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import StableInput from './StableInput.svelte';
	import { stableValue } from '$lib/actions/stableValue.js';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import * as Tooltip from '$lib/components/ui/tooltip/index.js';
	import { X, TriangleAlert, ExternalLink, Link2 } from 'lucide-svelte';
	import { autogrow, blurSaveOnEnter } from '$lib/actions/autogrow.js';
	import { fieldSupportsSuggest } from '$lib/core/types.js';
	import FilePicker from './FilePicker.svelte';
	import RecordPicker from './RecordPicker.svelte';
	import SuggestInput from './SuggestInput.svelte';
	import DateField from './DateField.svelte';

	/**
	 * The single schema-driven input for one field value, shared by every editor (the files-hub
	 * `FileEditorPanel` and the json record editors). Handles all FieldTypes — string / number /
	 * boolean / dropdown (single + multiselect) / list (string|number|url items) / url / file —
	 * with the full-fidelity list/url editing the record editors rely on (per-item chips + add row,
	 * url `{display_name,url}` items). `file` always uses the shared {@link FilePicker} dialog.
	 *
	 * @param def - The field's schema definition (type + options/itemTypes/multiselect).
	 * @param value - Two-way bound value; its shape matches the field type (host coerces on save).
	 * @param missing - Mark a broken `file` reference (renders a destructive hint).
	 * @param missingName - Optional name of the missing file (shown in the hint).
	 * @param oncommit - Optional: fired when this field reaches a committed value the host should
	 *   persist — on **blur** of a text/number/url input, **Enter** on a string field, and immediately
	 *   on a **discrete** change (checkbox, dropdown, date, file/record pick, list add/remove). The host
	 *   wires it to its autosave `commit()`; per-keystroke typing only updates `value` (stays dirty).
	 * @param id - Optional id applied to the primary control (for an external `<Label for>`).
	 * @param loadSuggestions - Optional host-supplied loader of distinct existing values for this field.
	 *   When provided and the field has `suggest` enabled (string, or list with string items), the input
	 *   becomes an autocomplete combobox ({@link SuggestInput}). The host binds it to its entity + key;
	 *   omitting it (e.g. globals, which has no sibling rows) leaves the plain input.
	 */
	let {
		def,
		value = $bindable(),
		missing = false,
		missingName,
		outOfClass = false,
		oncommit,
		id,
		loadSuggestions
	}: {
		def: FieldDefinition;
		value: unknown;
		missing?: boolean;
		missingName?: string;
		/** A class-scoped `file` ref whose blob exists but isn't a member of the field's class. */
		outOfClass?: boolean;
		oncommit?: () => void;
		id?: string;
		loadSuggestions?: () => Promise<string[]>;
	} = $props();

	// `multiselect` (array vs single value) is meaningful for dropdown, file, and record fields.
	const multiselect = $derived((def as { multiselect?: boolean }).multiselect === true);
	/** Target record type for a `record` field; '' when unconfigured (picker shows an empty state). */
	const recordType = $derived((def as { recordType?: string }).recordType ?? '');
	/** Class scope for a `file` field; '' = any file (picker unscoped). */
	const classId = $derived((def as { classId?: string }).classId ?? '');
	/** A `file`/`record` field that's half of a two-way relation link (edits mirror to the partner). */
	const linked = $derived(!!(def as { linkedField?: string }).linkedField);
	/** Normalized `file`/`record`-field value: an id array (multiselect) or a single id string. */
	const refValue = $derived<string | string[]>(
		multiselect
			? Array.isArray(value)
				? (value as string[])
				: []
			: typeof value === 'string'
				? value
				: ''
	);
	const itemType = $derived<ListItemType>(
		(def as { itemTypes?: ListItemType[] }).itemTypes?.[0] ?? 'string'
	);

	/** Whether to render the autocomplete combobox: field opted in, type qualifies, host wired a loader. */
	const suggestActive = $derived(
		!!(def as { suggest?: boolean }).suggest &&
			!!loadSuggestions &&
			fieldSupportsSuggest(def.type, [itemType])
	);

	/** Per-instance id base so multiselect checkbox/label pairs associate without colliding. */
	const uid = `fi-${Math.random().toString(36).slice(2, 9)}`;

	const url = $derived(
		def.type === 'url' ? normalizeUrlValue(value) : { display_name: '', url: '' }
	);
	function setUrl(patch: Partial<UrlValue>) {
		value = { ...url, ...patch };
	}

	/**
	 * Resolves a user-entered URL into something safe to put in an `<a href>` for navigation.
	 * Leaves schemed values (`https://…`, `mailto:…`, protocol-relative `//…`) untouched and
	 * assumes `https://` for bare hosts like `svelte.dev`, so the "open" button never produces a
	 * same-origin relative link. Does NOT mutate the stored value — display/edit keeps what was typed.
	 */
	function hrefFor(raw: string): string {
		const t = raw.trim();
		if (!t) return '';
		if (t.startsWith('//') || /^[a-zA-Z][\w+.-]*:/.test(t)) return t;
		return `https://${t}`;
	}

	/** Patch one url-typed list item in place (Option 1: inline-editable rows). */
	function updateUrlItem(i: number, patch: Partial<UrlValue>) {
		const arr = [...listItems];
		arr[i] = { ...normalizeUrlValue(arr[i]), ...patch };
		value = arr;
	}

	const stringValue = $derived(typeof value === 'string' ? value : '');
	const listItems = $derived(Array.isArray(value) ? (value as unknown[]) : []);

	// Local "new list item" inputs (scoped to this one field — no per-key maps needed).
	let newItem = $state('');
	let newUrlName = $state('');
	let newUrlUrl = $state('');

	/** Display text for a list item (string / number / url object). */
	function listItemDisplayText(item: unknown): string {
		if (item != null && typeof item === 'object' && 'url' in (item as object)) {
			const o = item as { display_name?: string; url?: string };
			const name = (o.display_name ?? '').trim();
			const u = (o.url ?? '').trim();
			if (name && u) return `${name} (${u})`;
			return u || name || '';
		}
		return String(item);
	}

	function addListItem() {
		const arr = [...listItems];
		if (itemType === 'url') {
			const u = newUrlUrl.trim();
			if (!u) return;
			arr.push({ display_name: newUrlName.trim(), url: u });
			newUrlName = '';
			newUrlUrl = '';
		} else if (itemType === 'number') {
			const n = Number(newItem.trim());
			if (newItem.trim() === '' || !Number.isFinite(n)) return;
			arr.push(n);
			newItem = '';
		} else {
			const v = newItem.trim();
			if (!v) return;
			arr.push(v);
			newItem = '';
		}
		value = arr;
		oncommit?.();
	}

	function removeListItem(i: number) {
		const arr = [...listItems];
		arr.splice(i, 1);
		value = arr;
		oncommit?.();
	}
</script>

<!-- Shared "open this URL in a new tab" icon button with a tooltip; disabled when empty. -->
{#snippet openLink(raw: string)}
	{@const target = hrefFor(raw)}
	<Tooltip.Root>
		<Tooltip.Trigger>
			{#if target}
				<a
					href={target}
					target="_blank"
					rel="noopener noreferrer"
					class={buttonVariants({ variant: 'outline', size: 'icon' }) + ' shrink-0'}
					aria-label="Open link in new tab"
				>
					<ExternalLink class="size-4" />
				</a>
			{:else}
				<span
					class={buttonVariants({ variant: 'outline', size: 'icon' }) +
						' shrink-0 cursor-not-allowed opacity-50'}
					aria-disabled="true"
					aria-label="Open link in new tab"
				>
					<ExternalLink class="size-4" />
				</span>
			{/if}
		</Tooltip.Trigger>
		<Tooltip.Content side="top" sideOffset={6}>
			{target ? 'Open link in new tab' : 'Enter a URL to open'}
		</Tooltip.Content>
	</Tooltip.Root>
{/snippet}

<!-- Subtle "this field is half of a two-way link" hint, shown under linked file/record pickers. -->
{#snippet linkedHint()}
	{#if linked}
		<Tooltip.Root>
			<Tooltip.Trigger>
				<span class="flex w-fit items-center gap-1 text-xs text-muted-foreground">
					<Link2 class="size-3 shrink-0" /> Linked
				</span>
			</Tooltip.Trigger>
			<Tooltip.Content side="top" sideOffset={6}>
				Two-way relation — editing this also updates the paired field.
			</Tooltip.Content>
		</Tooltip.Root>
	{/if}
{/snippet}

{#if def.type === 'boolean'}
	<Checkbox
		{id}
		checked={value === true}
		onCheckedChange={(v) => {
			value = v === true;
			oncommit?.();
		}}
	/>
{:else if def.type === 'date'}
	<DateField
		{id}
		value={typeof value === 'string' ? value : ''}
		onValueChange={(v) => {
			value = v;
			oncommit?.();
		}}
	/>
{:else if def.type === 'number'}
	<StableInput
		{id}
		type="number"
		value={typeof value === 'number' ? value : ((value as string | null) ?? '')}
		oninput={(e) => (value = e.currentTarget.value === '' ? 0 : Number(e.currentTarget.value))}
		onblur={() => oncommit?.()}
	/>
{:else if def.type === 'dropdown'}
	{#if multiselect}
		<div class="flex flex-wrap gap-3">
			{#each def.options ?? [] as opt, i (opt)}
				<div class="flex items-center gap-1.5 text-sm">
					<Checkbox
						id={`${uid}-${i}`}
						checked={Array.isArray(value) && (value as string[]).includes(opt)}
						onCheckedChange={(checked) => {
							const set = new Set(Array.isArray(value) ? (value as string[]) : []);
							if (checked) set.add(opt);
							else set.delete(opt);
							value = [...set];
							oncommit?.();
						}}
					/>
					<Label for={`${uid}-${i}`} class="font-normal">{opt}</Label>
				</div>
			{/each}
		</div>
	{:else}
		<Select.Root
			type="single"
			value={stringValue}
			onValueChange={(v) => {
				value = v;
				oncommit?.();
			}}
		>
			<Select.Trigger {id} class="w-full">{stringValue || 'Select…'}</Select.Trigger>
			<Select.Content>
				{#each def.options ?? [] as opt (opt)}
					<Select.Item value={opt}>{opt}</Select.Item>
				{/each}
			</Select.Content>
		</Select.Root>
	{/if}
{:else if def.type === 'list' && itemType === 'url'}
	<!-- Option 1: each url item is a persistent, inline-editable row + an "add" row at the bottom. -->
	<div class="flex flex-col gap-2">
		{#each listItems as item, i (i)}
			{@const u = normalizeUrlValue(item)}
			<div class="flex items-center gap-2">
				<StableInput
					class="w-32 shrink-0"
					placeholder="Display name"
					value={u.display_name}
					oninput={(e) => updateUrlItem(i, { display_name: e.currentTarget.value })}
					onblur={() => oncommit?.()}
				/>
				<StableInput
					class="min-w-0 flex-1"
					type="url"
					placeholder="https://…"
					value={u.url}
					oninput={(e) => updateUrlItem(i, { url: e.currentTarget.value })}
					onblur={() => oncommit?.()}
				/>
				{@render openLink(u.url)}
				<Button
					type="button"
					variant="ghost"
					size="icon"
					class="shrink-0 text-muted-foreground hover:text-destructive"
					onclick={() => removeListItem(i)}
					aria-label="Remove item"
				>
					<X class="size-4" />
				</Button>
			</div>
		{/each}
		<div class="flex items-center gap-2">
			<Input class="w-32 shrink-0" placeholder="Display name" bind:value={newUrlName} />
			<Input
				class="min-w-0 flex-1"
				type="url"
				placeholder="https://…"
				bind:value={newUrlUrl}
				onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), addListItem())}
			/>
			<Button type="button" variant="outline" size="sm" onclick={addListItem}>Add</Button>
		</div>
	</div>
{:else if def.type === 'list'}
	<div class="flex flex-col gap-2">
		{#if listItems.length > 0}
			<div class="flex flex-wrap gap-1">
				{#each listItems as item, i (i)}
					<span class="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-sm">
						{listItemDisplayText(item)}
						<button
							type="button"
							class="hover:text-destructive"
							onclick={() => removeListItem(i)}
							aria-label="Remove item"
						>
							<X class="size-3" />
						</button>
					</span>
				{/each}
			</div>
		{/if}
		<div class="flex flex-wrap items-end gap-2">
			{#if suggestActive}
				<div class="min-w-0 flex-1">
					<SuggestInput
						placeholder="Add item"
						bind:value={newItem}
						loadSuggestions={loadSuggestions!}
						exclude={listItems.map((it) => String(it))}
						oncommit={addListItem}
						keepOpenAfterCommit
					/>
				</div>
			{:else}
				<Input
					class="min-w-0 flex-1"
					type={itemType === 'number' ? 'number' : 'text'}
					placeholder="Add item"
					bind:value={newItem}
					onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), addListItem())}
				/>
			{/if}
			<Button type="button" variant="outline" size="sm" onclick={addListItem}>Add</Button>
		</div>
	</div>
{:else if def.type === 'url'}
	<div class="flex items-center gap-2">
		<StableInput
			class="w-32 shrink-0"
			placeholder="Display name"
			value={url.display_name}
			oninput={(e) => setUrl({ display_name: e.currentTarget.value })}
			onblur={() => oncommit?.()}
		/>
		<StableInput
			{id}
			type="url"
			class="min-w-0 flex-1"
			placeholder="https://…"
			value={url.url}
			oninput={(e) => setUrl({ url: e.currentTarget.value })}
			onblur={() => oncommit?.()}
		/>
		{@render openLink(url.url)}
	</div>
{:else if def.type === 'file'}
	<div class="flex w-full flex-col gap-1">
		<FilePicker
			{multiselect}
			classId={classId || undefined}
			value={refValue}
			onSelect={(v) => {
				value = v;
				oncommit?.();
			}}
		/>
		{@render linkedHint()}
		{#if missing}
			<div class="mt-1 flex items-center justify-between gap-2">
				<span class="flex items-center gap-1 text-xs text-destructive">
					<TriangleAlert class="size-3 shrink-0" />
					{missingName ? `Missing file: ${missingName}` : 'File not found on disk'}
				</span>
				<Button
					variant="ghost"
					size="sm"
					class="h-6 px-2 text-xs"
					onclick={() => (value = multiselect ? [] : '')}
				>
					Clear
				</Button>
			</div>
		{:else if outOfClass}
			<div class="mt-1 flex items-center justify-between gap-2">
				<span class="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-500">
					<TriangleAlert class="size-3 shrink-0" />
					Not a member of the required class
				</span>
				<Button
					variant="ghost"
					size="sm"
					class="h-6 px-2 text-xs"
					onclick={() => (value = multiselect ? [] : '')}
				>
					Clear
				</Button>
			</div>
		{/if}
	</div>
{:else if def.type === 'record'}
	<div class="flex w-full flex-col gap-1">
		<RecordPicker
			{recordType}
			{multiselect}
			value={refValue}
			onSelect={(v) => {
				value = v;
				oncommit?.();
			}}
		/>
		{@render linkedHint()}
		{#if missing}
			<div class="mt-1 flex items-center justify-between gap-2">
				<span class="flex items-center gap-1 text-xs text-destructive">
					<TriangleAlert class="size-3 shrink-0" />
					{missingName ? `Missing record: ${missingName}` : 'Referenced record not found'}
				</span>
				<Button
					variant="ghost"
					size="sm"
					class="h-6 px-2 text-xs"
					onclick={() => (value = multiselect ? [] : '')}
				>
					Clear
				</Button>
			</div>
		{/if}
	</div>
{:else if suggestActive}
	<SuggestInput
		{id}
		value={stringValue}
		onValueChange={(v) => (value = v)}
		loadSuggestions={loadSuggestions!}
		{oncommit}
	/>
{:else}
	<!--
		The value is applied via `stableValue` rather than a `value={...}` attribute: this is the field
		people write sentences in, and a controlled re-render while it has focus would move the caret to
		the end (and drop anything typed since the render's data was fetched).
	-->
	<textarea
		{id}
		rows="1"
		use:autogrow={value}
		use:stableValue={stringValue}
		onkeydown={(e) => blurSaveOnEnter(e)}
		onblur={() => oncommit?.()}
		class="flex w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
		oninput={(e) => (value = e.currentTarget.value)}
	></textarea>
{/if}
