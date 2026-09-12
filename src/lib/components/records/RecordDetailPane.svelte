<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import { Trash2, Check, Loader2 } from 'lucide-svelte';
	import { toast } from 'svelte-sonner';
	import EditorPanelShell from '$lib/components/EditorPanelShell.svelte';
	import FieldInput from '$lib/components/FieldInput.svelte';
	import { createAutosave } from '$lib/actions/autosave.svelte.js';
	import { fieldLabel, schemaUserFieldKeys } from '$lib/core/fieldKeys.js';
	import type { SchemaDefinition } from '$lib/core/types.js';
	import { normalizeUrlValue } from '$lib/core/types.js';
	import { recordDetailTitle } from '$lib/core/recordDisplay.js';
	import { formatTimestamp } from '$lib/core/datetime.js';
	import {
		apiGetSchemaForType,
		apiGetRecordByIdForType,
		apiUpdatePropertiesByIdForType,
		apiDeleteRecordForType,
		apiGetFieldValuesForType
	} from '$lib/api/client.js';

	/**
	 * The Records Explorer's right-hand detail pane: an inline, **autosaving** editor for a single
	 * record. It composes the shared {@link EditorPanelShell} (the same chrome the Files hub uses —
	 * fixed-width aside, prev/next chevrons + ←/→ keys, close) and renders the type's schema as a stack
	 * of {@link FieldInput}s. There is no explicit Save button — edits are debounced and flushed on
	 * field blur, prev/next, record switch, close, and unload, with a "Saving…/Saved" status hint.
	 * Delete is kept (confirmed). Only renders when a record is selected (no reserved space).
	 *
	 * @param typeId - The `json` media type id.
	 * @param recordId - The open record (reloads when it changes).
	 * @param titleField - The schema field currently used to title records (for the header).
	 * @param index / total - Position in the current list order (for prev/next + the counter).
	 * @param onPrev / onNext - Move along the list order (this pane flushes pending edits first).
	 * @param onclose - Clear the selection (shows the empty detail state).
	 * @param onchanged - Called after a successful save with the **updated record**, so the host can
	 *   patch that one list row in place (no refetch — refetching would flash the page and clobber
	 *   in-flight keystrokes).
	 * @param ondeleted - Called after a successful delete.
	 * @param refresh - Bump from the host to force a reload (e.g. after a schema change).
	 */
	let {
		typeId,
		recordId,
		titleField = '',
		index = -1,
		total = 0,
		onPrev,
		onNext,
		onclose,
		onchanged,
		ondeleted,
		refresh = 0
	}: {
		typeId: string;
		recordId: string;
		titleField?: string;
		index?: number;
		total?: number;
		onPrev?: () => void;
		onNext?: () => void;
		onclose: () => void;
		onchanged: (updated: Record<string, unknown>) => void;
		ondeleted: () => void;
		refresh?: number;
	} = $props();

	let schema = $state<SchemaDefinition | null>(null);
	let record = $state<Record<string, unknown> | null>(null);
	let loading = $state(false);
	let deleteOpen = $state(false);
	let formValues = $state<Record<string, unknown>>({});
	let lastSavedPatch = $state<Record<string, unknown>>({});

	/** Identifies the record whose form is currently in `formValues` (for flush-on-leave). */
	let loaded = $state<{ typeId: string; recordId: string } | null>(null);
	/** Monotonic load counter; a response whose ticket is stale is dropped instead of applied. */
	let loadSeq = 0;

	/** Ordered editable keys (name first for display) — shared helper. */
	const getOrderedEditableKeys = schemaUserFieldKeys;

	function initFormValues(s: SchemaDefinition, rec: Record<string, unknown> | null) {
		const next: Record<string, unknown> = {};
		for (const key of getOrderedEditableKeys(s)) {
			const def = s[key];
			const type = def?.type;
			let value: unknown =
				rec?.[key] ??
				def?.defaultValue ??
				(type === 'boolean'
					? false
					: type === 'number'
						? 0
						: type === 'dropdown'
							? (def as { multiselect?: boolean }).multiselect
								? []
								: (def?.options?.[0] ?? '')
							: type === 'list'
								? []
								: type === 'url'
									? { display_name: '', url: '' }
									: '');
			if (type === 'url') value = normalizeUrlValue(value);
			if (type === 'dropdown' && (def as { multiselect?: boolean }).multiselect) {
				value = Array.isArray(value)
					? value
					: typeof value === 'string' && value !== ''
						? [value]
						: [];
			}
			next[key] = type === 'number' ? String(value ?? '') : value;
		}
		formValues = next;
	}

	function buildPatch(): Record<string, unknown> {
		if (!schema) return {};
		const patch: Record<string, unknown> = {};
		for (const key of getOrderedEditableKeys(schema)) {
			const def = schema[key];
			const current = formValues[key];
			if (def?.type === 'number') {
				const n = Number(current);
				patch[key] = Number.isNaN(n) ? 0 : n;
			} else if (def?.type === 'url') {
				const urlVal =
					current != null && typeof current === 'object' && 'url' in (current as object)
						? (current as { display_name?: string; url?: string })
						: normalizeUrlValue(current);
				patch[key] = { display_name: urlVal.display_name ?? '', url: urlVal.url ?? '' };
			} else {
				patch[key] = current;
			}
		}
		return patch;
	}

	const isDirty = $derived(
		schema !== null &&
			record !== null &&
			JSON.stringify(buildPatch()) !== JSON.stringify(lastSavedPatch)
	);

	const title = $derived(recordDetailTitle(record, recordId, titleField));

	// Shared autosave: `doSave` runs on field blur / discrete change / Enter / prev-next / close
	// (`autosave.commit`), with a slow 3s idle safety net. The host patches the edited row in place from
	// `onchanged(updated)` — no refetch — so typing never stutters.
	const autosave = createAutosave({ isDirty: () => isDirty, save: doSave });

	/**
	 * (Re)fetch the open record and its schema.
	 *
	 * A reload for the record already on screen (the `refresh` bump after a schema edit) keeps the form
	 * mounted and keeps any unsaved edits: `{#if loading}` swaps the whole field list out, and a
	 * swapped-out input loses focus — which reads to the user as being kicked out of the box they were
	 * typing in. Only a genuine record switch shows the skeleton. A stale response (a switch raced the
	 * fetch) is dropped rather than applied.
	 */
	async function load() {
		const sameRecord = loaded?.typeId === typeId && loaded?.recordId === recordId;
		if (!sameRecord) loading = true;
		const seq = ++loadSeq;
		try {
			const [s, r] = await Promise.all([
				apiGetSchemaForType(typeId),
				apiGetRecordByIdForType(typeId, recordId)
			]);
			if (seq !== loadSeq) return;
			const keep = sameRecord && isDirty ? { ...formValues } : null;
			schema = s;
			record = r as Record<string, unknown>;
			initFormValues(s, record);
			if (keep) {
				// Unsaved edits are newer than anything the server just handed back — keep them, but only
				// for keys the (possibly just-changed) schema still has.
				for (const key of getOrderedEditableKeys(s)) {
					if (key in keep) formValues[key] = keep[key];
				}
			} else {
				lastSavedPatch = buildPatch();
			}
			loaded = { typeId, recordId };
		} catch (e) {
			console.error(e);
			toast.error('Failed to load record');
		} finally {
			if (seq === loadSeq) loading = false;
		}
	}

	/**
	 * Persist the current edits if dirty. Advances the saved baseline and hands the host the updated
	 * record (patch-in-place, no refetch). Throws on failure — {@link createAutosave} owns the
	 * status/saving/toast bookkeeping.
	 */
	async function doSave() {
		if (!schema) return;
		const patch = buildPatch();
		if (JSON.stringify(patch) === JSON.stringify(lastSavedPatch)) return;
		const updated = await apiUpdatePropertiesByIdForType(typeId, recordId, patch);
		record = updated as Record<string, unknown>;
		lastSavedPatch = patch;
		onchanged(updated as Record<string, unknown>);
	}

	/**
	 * Fire-and-forget flush for the record we're leaving — used in the load effect's cleanup (which
	 * can't be async) and on `beforeunload`. Reads the still-current form state for the outgoing
	 * record before `load()` overwrites it.
	 */
	function flushLeavingSync() {
		autosave.cancel();
		if (!loaded || !schema || autosave.saving) return;
		const patch = buildPatch();
		if (JSON.stringify(patch) === JSON.stringify(lastSavedPatch)) return;
		void apiUpdatePropertiesByIdForType(loaded.typeId, loaded.recordId, patch)
			.then((updated) => onchanged(updated as Record<string, unknown>))
			.catch((e) => console.error('Autosave on leave failed', e));
	}

	// Reload whenever the open record changes; flush the outgoing record's edits first.
	$effect(() => {
		recordId;
		typeId;
		load();
		return () => flushLeavingSync();
	});

	// Reload on external request (e.g. a schema change while open).
	$effect(() => {
		if (refresh) load();
	});

	// Best-effort flush if the tab is closed mid-edit.
	$effect(() => {
		const handler = () => flushLeavingSync();
		window.addEventListener('beforeunload', handler);
		return () => window.removeEventListener('beforeunload', handler);
	});

	/** Flush pending edits, then run a prev/next navigation. */
	async function advance(go: (() => void) | undefined) {
		if (!go) return;
		await autosave.commit();
		go();
	}

	async function handleClose() {
		await autosave.commit();
		onclose();
	}

	async function deleteRecord() {
		try {
			autosave.cancel();
			await apiDeleteRecordForType(typeId, recordId);
			toast.success('Deleted');
			deleteOpen = false;
			ondeleted();
		} catch (e) {
			console.error(e);
			toast.error('Failed to delete');
		}
	}
</script>

<EditorPanelShell
	{index}
	{total}
	onPrev={() => advance(onPrev)}
	onNext={() => advance(onNext)}
	onclose={handleClose}
	meta={record?.last_modified
		? `Modified ${formatTimestamp(record.last_modified as string)}`
		: undefined}
>
	{#snippet titleArea()}
		<span class="min-w-0 flex-1 truncate text-sm font-medium" {title}>{title}</span>
		<span class="shrink-0 text-xs text-muted-foreground">
			{#if autosave.status === 'saving'}
				<Loader2 class="inline size-3 animate-spin" /> Saving…
			{:else if autosave.status === 'saved' && !isDirty}
				<Check class="inline size-3 text-green-600" /> Saved
			{:else if autosave.status === 'error'}
				<span class="text-destructive">Save failed</span>
			{/if}
		</span>
	{/snippet}

	{#snippet actions()}
		<AlertDialog.Root bind:open={deleteOpen}>
			<AlertDialog.Trigger>
				{#snippet child({ props })}
					<Button {...props} variant="ghost" size="icon" aria-label="Delete">
						<Trash2 class="size-4 text-destructive" />
					</Button>
				{/snippet}
			</AlertDialog.Trigger>
			<AlertDialog.Content>
				<AlertDialog.Title>Delete record</AlertDialog.Title>
				<AlertDialog.Description>Remove this record? This cannot be undone.</AlertDialog.Description
				>
				<div class="mt-4 flex justify-end gap-2">
					<AlertDialog.Cancel type="button">Cancel</AlertDialog.Cancel>
					<Button variant="destructive" type="button" onclick={deleteRecord}>Delete</Button>
				</div>
			</AlertDialog.Content>
		</AlertDialog.Root>
	{/snippet}

	{#if loading}
		<p class="text-sm text-muted-foreground">Loading…</p>
	{:else if schema}
		<Card.Root>
			<Card.Content class="pt-4">
				<div class="flex flex-col gap-4">
					{#each getOrderedEditableKeys(schema) as key (key)}
						{@const def = schema[key]}
						{@const rec = record as Record<string, unknown> | null}
						{@const mf = (rec?._missing_files ?? undefined) as Record<string, string> | undefined}
						{@const mr = (rec?._missing_records ?? undefined) as Record<string, string> | undefined}
						{@const oc = (rec?._out_of_class ?? undefined) as Record<string, string> | undefined}
						{@const isMissing =
							((def?.type === 'file' && mf?.[key] !== undefined) ||
								(def?.type === 'record' && mr?.[key] !== undefined)) &&
							formValues[key] === rec?.[key]}
						{@const isOutOfClass =
							def?.type === 'file' && oc?.[key] !== undefined && formValues[key] === rec?.[key]}
						<div class="flex flex-col gap-2">
							<Label for={key}>{fieldLabel(key)}</Label>
							{#if def}
								<FieldInput
									{def}
									id={key}
									bind:value={formValues[key]}
									missing={isMissing}
									missingName={mf?.[key] ?? mr?.[key]}
									outOfClass={isOutOfClass}
									oncommit={() => autosave.commit()}
									loadSuggestions={() =>
										apiGetFieldValuesForType(typeId, key).then((r) => r.values)}
								/>
							{/if}
						</div>
					{/each}
				</div>
			</Card.Content>
		</Card.Root>
	{/if}
</EditorPanelShell>
