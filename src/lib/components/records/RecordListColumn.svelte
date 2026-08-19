<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import RecordBulkActions from '$lib/components/RecordBulkActions.svelte';
	import Breadcrumbs from '$lib/components/Breadcrumbs.svelte';
	import EntityRowMenu from '$lib/components/entity-settings/EntityRowMenu.svelte';
	import SortControl from '$lib/components/SortControl.svelte';
	import VerboseFieldsMenu from '$lib/components/data-grid/VerboseFieldsMenu.svelte';
	import SelectionCheckbox from '$lib/components/selection/SelectionCheckbox.svelte';
	import { ListChecks, Plus, X, AlertTriangle } from 'lucide-svelte';
	import { fieldLabel, schemaUserFieldKeys } from '$lib/core/fieldKeys.js';
	import { recordListTitle, recordListSubtitle } from '$lib/core/recordDisplay.js';
	import type { SortDir } from '$lib/core/sort.js';
	import type { JsonListItem, SchemaDefinition } from '$lib/core/types.js';

	/**
	 * The Records Explorer's middle column: the record list for the active type. Replaces the tile
	 * `DataGrid` with a name-forward scrollable list (records are text-first, not thumbnails). Owns the
	 * group control and the multiselect bulk bar; the host owns the data and the open record (search
	 * now lives in the rail). Rows resolve their title via {@link recordListTitle} so types without a
	 * `name` field show something meaningful instead of a raw id.
	 *
	 * @param typeName - Display name of the active type (column header).
	 * @param typeId - The active type id (for bulk actions + schema editor wiring).
	 * @param schema - The type's schema (drives the group field list).
	 * @param records - The records to show (already loaded by the host for the active group).
	 * @param loading - Show a loading hint instead of the list.
	 * @param groupBy - Bindable group field (host reloads on change). "Title by" is no longer here —
	 *   it's a persisted per-type setting in the ⋮ → Settings dialog.
	 * @param selectionMode / selectedIds / selectedRecordId - Multiselect + active-row state.
	 * @param onOpen / onToggleSelect / onSetSelected / onNewRecord / onToggleSelectionMode /
	 *   onBulkChanged - Callbacks (`onSetSelected` backs the master + per-group select-all checkboxes).
	 * @param onOpenSettings / onDeleteType - Open the active type's settings dialog / delete confirm
	 *   from the content-header ⋮ (always reachable, even when the rail is collapsed).
	 * @param crumbs - Optional breadcrumb trail rendered above the header (Home › Records › <type>).
	 */
	let {
		typeName,
		typeId,
		schema,
		records,
		loading,
		groupBy = $bindable(''),
		sortField = $bindable(''),
		sortDir = $bindable('desc'),
		onSortChange,
		verbose = $bindable(false),
		verboseFields = $bindable<string[]>([]),
		onVerboseChange,
		selectionMode,
		selectedIds,
		selectedRecordId,
		onOpen,
		onToggleSelect,
		onSetSelected,
		onNewRecord,
		onToggleSelectionMode,
		onBulkChanged,
		onOpenSettings,
		onDeleteType,
		crumbs
	}: {
		typeName: string;
		typeId: string;
		schema: SchemaDefinition | null;
		records: JsonListItem[];
		loading: boolean;
		groupBy?: string;
		sortField?: string;
		sortDir?: SortDir;
		onSortChange?: () => void;
		/** Verbose grid (Item 8): bindable toggle + chosen fields; `onVerboseChange` persists + reloads. */
		verbose?: boolean;
		verboseFields?: string[];
		onVerboseChange?: () => void;
		selectionMode: boolean;
		selectedIds: Set<string>;
		selectedRecordId: string | null;
		onOpen: (id: string) => void;
		onToggleSelect: (id: string, shiftKey?: boolean) => void;
		/** Bulk select/deselect (the master "Select all" + each group header's checkbox). */
		onSetSelected: (ids: string[], selected: boolean) => void;
		onNewRecord: () => void;
		onToggleSelectionMode: () => void;
		onBulkChanged: () => void;
		onOpenSettings: () => void;
		onDeleteType: () => void;
		crumbs?: { label: string; href?: string }[];
	} = $props();

	/**
	 * Whether Shift was down for the click currently being handled. A shadcn `Checkbox` reports a
	 * boolean change, not the originating event, so the row records the modifier in the capture phase
	 * and `onCheckedChange` reads it back — that's what lets a shift-click extend a range.
	 */
	let shiftHeld = $state(false);

	/** Schema field keys eligible for group-by / title (name first). */
	const schemaFieldKeys = $derived(schema ? schemaUserFieldKeys(schema) : []);

	/** Verbose-grid field options (Item 8): the type's user fields as `{ key, label }`. */
	const verboseOptions = $derived(schemaFieldKeys.map((k) => ({ key: k, label: fieldLabel(k) })));

	/** Sort options (Item 9): built-ins + each schema field. */
	const sortOptions = $derived([
		{ value: 'name', label: 'Name' },
		{ value: 'last_modified', label: 'Last modified' },
		...schemaFieldKeys.map((k) => ({ value: k, label: fieldLabel(k) }))
	]);

	/** Records grouped by the server-provided `group_by_value`, or null when flat. */
	const groupedRecords = $derived.by<[string, JsonListItem[]][] | null>(() => {
		if (!groupBy) return null;
		const groups: Record<string, JsonListItem[]> = {};
		for (const item of records) {
			const v = item.group_by_value;
			const key =
				v == null || v === ''
					? '—'
					: Array.isArray(v)
						? v.length
							? v.join(', ')
							: '—'
						: String(v);
			(groups[key] ??= []).push(item);
		}
		return Object.entries(groups).sort((a, b) => {
			if (a[0] === '—') return -1;
			if (b[0] === '—') return 1;
			return a[0].localeCompare(b[0]);
		});
	});

	/**
	 * Subtitle for a row: the type's configured "subtitle by" field (resolved server-side into
	 * `subtitle_value`), independent of grouping. Group values live only in the sticky group headers.
	 */
	function rowSubtitle(item: JsonListItem): string | null {
		const s = recordListSubtitle(item);
		return s && s !== recordListTitle(item) ? s : null;
	}

	/**
	 * Verbose-mode key/value rows for a record (Item 8): the server inlined the chosen field set as
	 * `field_values` (insertion order = the picker order), each value already stringified (`''` when
	 * empty). Label each key for display; absent ⇒ no rows (compact). Mirrors the Files tile's
	 * `GridItem.fields`, just rendered in the list row instead of a `DataGrid` tile.
	 */
	function verboseRows(item: JsonListItem): { label: string; value: string }[] {
		const fv = item.field_values;
		return fv ? Object.entries(fv).map(([k, value]) => ({ label: fieldLabel(k), value })) : [];
	}
</script>

<div class="flex h-screen min-w-0 flex-1 flex-col">
	{#if crumbs}
		<div class="flex h-9 items-center border-b px-3">
			<Breadcrumbs items={crumbs} />
		</div>
	{/if}
	<!-- Header: name + actions -->
	<header class="flex items-center gap-2 border-b p-3">
		<h1 class="truncate text-base font-semibold">{typeName}</h1>
		<span class="shrink-0 text-xs text-muted-foreground">
			{records.length} record{records.length === 1 ? '' : 's'}
		</span>
		<div class="flex-1"></div>
		<Button
			variant={selectionMode ? 'secondary' : 'ghost'}
			size="sm"
			onclick={onToggleSelectionMode}
			title={selectionMode ? 'Clear selection' : 'Select records'}
		>
			{#if selectionMode}
				<X class="size-4" /> Clear
			{:else}
				<ListChecks class="size-4" /> Select
			{/if}
		</Button>
		<Button size="sm" onclick={onNewRecord}>
			<Plus class="size-4" /> New
		</Button>
		<EntityRowMenu
			noun="record type"
			onSettings={onOpenSettings}
			onDelete={onDeleteType}
			triggerClass="size-8"
		/>
	</header>

	<!-- Controls: group + sort -->
	<div class="flex flex-wrap items-center gap-2 border-b p-2 text-sm">
		<div class="flex items-center gap-1.5">
			<span class="text-muted-foreground">Group</span>
			<Select.Root type="single" value={groupBy} onValueChange={(v) => (groupBy = v ?? '')}>
				<Select.Trigger class="h-8 w-32">{groupBy ? fieldLabel(groupBy) : 'None'}</Select.Trigger>
				<Select.Content>
					<Select.Item value="">None</Select.Item>
					{#each schemaFieldKeys as k (k)}
						<Select.Item value={k}>{fieldLabel(k)}</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
		</div>
		<SortControl
			options={sortOptions}
			bind:field={sortField}
			bind:dir={sortDir}
			onchange={onSortChange}
		/>
		<VerboseFieldsMenu
			bind:verbose
			bind:selected={verboseFields}
			groups={[{ label: 'Fields', options: verboseOptions }]}
			onchange={onVerboseChange}
			disabled={verboseOptions.length === 0}
		/>
	</div>

	<!-- Bulk bar -->
	{#if selectionMode}
		<div class="flex flex-wrap items-center gap-2 border-b bg-muted/40 p-2 text-sm">
			<!-- Master select-all over every visible record (tri-state; ticks itself when all are picked). -->
			<SelectionCheckbox
				ids={records.map((r) => r.id)}
				isSelected={(id) => selectedIds.has(id)}
				onSet={onSetSelected}
				label="Select all"
			/>
			<RecordBulkActions
				{typeId}
				{schema}
				selectedIds={[...selectedIds]}
				onchanged={onBulkChanged}
			/>
			<Button variant="ghost" size="sm" class="ml-auto text-xs" onclick={onToggleSelectionMode}>
				clear
			</Button>
		</div>
	{/if}

	<!-- List -->
	<div class="min-h-0 flex-1 overflow-y-auto">
		{#if loading}
			<p class="p-4 text-sm text-muted-foreground">Loading…</p>
		{:else if records.length === 0}
			<div class="flex flex-col items-center gap-3 p-8 text-center text-sm text-muted-foreground">
				<p>No records found.</p>
				<Button size="sm" onclick={onNewRecord}><Plus class="size-4" /> New record</Button>
			</div>
		{:else}
			{#snippet row(item: JsonListItem)}
				{@const subtitle = rowSubtitle(item)}
				<div
					class="flex items-center gap-2 border-b px-2 py-1.5 hover:bg-muted/50 {item.id ===
					selectedRecordId
						? 'bg-muted'
						: ''} {selectionMode ? 'select-none' : ''}"
					onclickcapture={(e) => (shiftHeld = e.shiftKey)}
				>
					{#if selectionMode}
						<!-- The checkbox reports a change, not the event, so the row grabs Shift on the way down
						     (capture beats the checkbox's own click handler) to drive range selection. -->
						<Checkbox
							checked={selectedIds.has(item.id)}
							onCheckedChange={() => onToggleSelect(item.id, shiftHeld)}
							aria-label="Select record"
						/>
					{/if}
					<button
						type="button"
						class="flex min-w-0 flex-1 flex-col items-start text-left"
						onclick={() => onOpen(item.id)}
					>
						<span class="flex w-full min-w-0 items-center gap-1.5">
							<span class="min-w-0 flex-1 truncate text-sm">{recordListTitle(item)}</span>
							{#if item.missing_file_fields?.length}
								<AlertTriangle
									class="size-3.5 shrink-0 text-amber-500"
									aria-label="Missing file reference: {item.missing_file_fields.join(', ')}"
								/>
							{/if}
						</span>
						{#if subtitle}
							<span class="w-full min-w-0 truncate text-xs text-muted-foreground">{subtitle}</span>
						{/if}
						{#if verboseRows(item).length}
							<!-- Verbose mode (Item 8): chosen field values as key/value rows under the row title. -->
							<dl
								class="mt-1 grid w-full min-w-0 grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs leading-tight"
							>
								{#each verboseRows(item) as f (f.label)}
									<dt class="truncate text-muted-foreground" title={f.label}>{f.label}</dt>
									<dd class="truncate {f.value ? '' : 'text-muted-foreground'}" title={f.value}>
										{f.value || '—'}
									</dd>
								{/each}
							</dl>
						{/if}
					</button>
				</div>
			{/snippet}

			{#if groupedRecords}
				{#each groupedRecords as [groupKey, list] (groupKey)}
					<div
						class="sticky top-0 z-10 flex items-center gap-2 border-b bg-background/95 px-2 py-1 text-xs font-medium text-muted-foreground backdrop-blur"
					>
						{#if selectionMode}
							<!-- Select/deselect this group; ticks itself once every row in it is picked by hand. -->
							<SelectionCheckbox
								ids={list.map((r) => r.id)}
								isSelected={(id) => selectedIds.has(id)}
								onSet={onSetSelected}
								ariaLabel="Select all in group"
							/>
						{/if}
						<span>{fieldLabel(groupBy)}: {groupKey} ({list.length})</span>
					</div>
					{#each list as item (item.id)}
						{@render row(item)}
					{/each}
				{/each}
			{:else}
				{#each records as item (item.id)}
					{@render row(item)}
				{/each}
			{/if}
		{/if}
	</div>
</div>
