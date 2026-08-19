<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { page } from '$app/stores';
	import { replaceState } from '$app/navigation';
	import { goto } from '$app/navigation';
	import { SvelteSet } from 'svelte/reactivity';
	import RecordsRail from '$lib/components/records/RecordsRail.svelte';
	import RecordListColumn from '$lib/components/records/RecordListColumn.svelte';
	import RecordDetailPane from '$lib/components/records/RecordDetailPane.svelte';
	import Breadcrumbs from '$lib/components/Breadcrumbs.svelte';
	import EntitySettingsDialog from '$lib/components/entity-settings/EntitySettingsDialog.svelte';
	import { typeSettingsAdapter } from '$lib/components/entity-settings/adapters.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { FolderOpen } from 'lucide-svelte';
	import { toast } from 'svelte-sonner';
	import {
		apiListMediaTypes,
		apiGetSchemaForType,
		apiGetTypeSettings,
		apiListRecordsForType,
		apiCreateRecordForType,
		apiCreateMediaType,
		apiDeleteMediaType,
		type MediaTypeSummary
	} from '$lib/api/client.js';
	import { currentMediaTypeStore } from '$lib/stores/currentMediaType.js';
	import {
		refreshTrigger,
		schemaRefreshTrigger,
		triggerImageListRefresh
	} from '$lib/stores/refreshTrigger.js';
	import { settingsStore } from '$lib/stores/settings.js';
	import { isUserFieldKey, schemaUserFields } from '$lib/core/fieldKeys.js';
	import { OPERATORS } from '$lib/core/filters.js';
	import { projectRecordRow } from '$lib/core/recordDisplay.js';
	import { apiUpdateTypeSettings } from '$lib/api/client.js';
	import type { SortDir } from '$lib/core/sort.js';
	import { resolveRangeSelection } from '$lib/core/rangeSelect.js';
	import type { JsonListItem, SchemaDefinition } from '$lib/core/types.js';

	/**
	 * The **Records Explorer** — the records sub-app's home. A persistent three-pane layout: a
	 * collapsible type rail (cross-cutting navigator), a record-list column for the active type, and an
	 * inline autosaving detail pane. There is deliberately no "All Records" merged view (records aren't
	 * attached to blobs the way files are; a record type is the records-side analogue of a class). The
	 * active type is held in `?type=<id>` (in-page selection — deep per-record routing is deferred). The
	 * reserved `globals` singleton is **not** a record type here — it has its own sub-app at `/globals`,
	 * so it is filtered out of the type list ({@link fetchTypes}) and `?type=globals` redirects there.
	 */

	let types = $state<MediaTypeSummary[]>([]);
	let activeTypeId = $state<string | null>(null);
	let railCollapsed = $state(false);
	let loadingTypes = $state(true);

	let schema = $state<SchemaDefinition | null>(null);
	let records = $state<JsonListItem[]>([]);
	let loading = $state(true);
	let query = $state('');
	/** Field to scope the search to (`''` = All fields). Lives in the rail, like the Files hub. */
	let searchField = $state('');
	let groupBy = $state('');
	let titleField = $state('');
	let subtitleField = $state('');
	/** Per-type list sort (Item 9), persisted in the type's settings.json. Default: last_modified desc. */
	let sortField = $state('last_modified');
	let sortDir = $state<SortDir>('desc');
	/**
	 * Verbose grid (Item 8), persisted per-type in settings.json. `verbose` shows the chosen
	 * `verboseFields` (schema keys, ≤ MAX_VERBOSE_FIELDS) as key/value rows under each record row.
	 */
	let verbose = $state(false);
	let verboseFields = $state<string[]>([]);
	/**
	 * Empty/incomplete quick-filter (Item 10) — transient view state (NOT persisted), reset on type
	 * switch. `incomplete` keeps records with any empty user field; `emptyField` (a field key, `''` =
	 * off) keeps records whose that one field is empty. Both AND with search server-side.
	 */
	let incomplete = $state(false);
	let emptyField = $state('');

	/** User fields of the active type offered by the rail's search-field picker. */
	const searchFields = $derived(schema ? schemaUserFields(schema) : []);

	// Drop a stale scoped search / empty-filter field if it's no longer in the active type's schema.
	$effect(() => {
		if (searchField && !searchFields.some((f) => f.key === searchField)) searchField = '';
		if (emptyField && !searchFields.some((f) => f.key === emptyField)) emptyField = '';
	});

	const selectedIds = new SvelteSet<string>();
	let selectionMode = $state(false);
	/** Shift-click range state: the last plainly-clicked row, and the span the live range claimed. */
	let rangeAnchorId: string | null = null;
	let lastShiftRange: string[] = [];
	/**
	 * The open record is deep-linked via `?record=<id>` (alongside `?type=`), so reload / share /
	 * back-forward reopen the same detail pane. {@link syncUrl} writes both back on change; `urlReady`
	 * gates that writer until the initial restore in {@link onMount} has consumed the incoming params.
	 */
	let selectedRecordId = $state<string | null>(null);
	let urlReady = $state(false);
	let editorRefresh = $state(0);

	// New-type dialog (shared with the dashboard flow).
	let newTypeOpen = $state(false);
	let newTypeName = $state('');

	// Unified per-type settings dialog (⋮ → Settings) + delete confirm.
	let settingsOpen = $state(false);
	let settingsTargetId = $state<string | null>(null);
	let deleteOpen = $state(false);
	let deleteTargetId = $state<string | null>(null);
	const settingsTargetName = $derived(
		types.find((t) => t.id === settingsTargetId)?.displayName ?? settingsTargetId ?? ''
	);
	const deleteTargetName = $derived(
		types.find((t) => t.id === deleteTargetId)?.displayName ?? deleteTargetId ?? ''
	);

	const isGlobals = $derived(activeTypeId === 'globals');
	const activeType = $derived(types.find((t) => t.id === activeTypeId) ?? null);
	const typeName = $derived(activeType?.displayName ?? activeTypeId ?? '');

	/** Breadcrumb trail: Home › Records › <active type>. The active-type crumb shows its icon. */
	const crumbs = $derived([
		{ label: 'Home', href: '/' },
		{ label: 'Records', href: '/media' },
		...(activeTypeId
			? [{ label: typeName, icon: activeType?.icon, iconFallback: 'file-text' as const }]
			: [])
	]);

	/**
	 * The visible record order (grouped) — drives prev/next in the detail pane. Search is now applied
	 * server-side (the list is already filtered), so this only mirrors the group ordering.
	 */
	const orderedIds = $derived.by<string[]>(() => {
		const filtered = records;
		if (!groupBy) return filtered.map((r) => r.id);
		const groups: Record<string, JsonListItem[]> = {};
		for (const item of filtered) {
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
		return Object.entries(groups)
			.sort((a, b) => (a[0] === '—' ? -1 : b[0] === '—' ? 1 : a[0].localeCompare(b[0])))
			.flatMap(([, list]) => list.map((i) => i.id));
	});
	const editorIndex = $derived(selectedRecordId ? orderedIds.indexOf(selectedRecordId) : -1);

	function gotoRecord(delta: number) {
		const next = orderedIds[editorIndex + delta];
		if (next) selectedRecordId = next;
	}

	/**
	 * List record types for the Records hub, excluding the reserved `globals` singleton — Globals is now
	 * its own sub-app at `/globals`, so it must never appear in the Records rail or become the active
	 * type here. All type loads in this page go through this so the exclusion holds in one place.
	 */
	async function fetchTypes(): Promise<MediaTypeSummary[]> {
		const all = await apiListMediaTypes();
		return all.filter((t) => t.id !== 'globals');
	}

	async function loadSchema() {
		if (!activeTypeId || isGlobals) return;
		try {
			const [s, settings] = await Promise.all([
				apiGetSchemaForType(activeTypeId),
				apiGetTypeSettings(activeTypeId).catch(() => ({
					displayField: '',
					subtitleField: '',
					sortField: '',
					sortDir: '',
					verbose: false,
					verboseFields: [] as string[]
				}))
			]);
			schema = s;
			// The persisted subtitle field (⋮ → Settings → General) is sticky like the title field.
			subtitleField = settings.subtitleField || '';
			// Persisted per-type sort (Item 9). Absent ⇒ default (last_modified desc).
			sortField = settings.sortField || 'last_modified';
			sortDir = settings.sortDir === 'asc' ? 'asc' : 'desc';
			// Persisted per-type verbose grid (Item 8). Fields are validated against the schema at render.
			verbose = 'verbose' in settings ? Boolean(settings.verbose) : false;
			verboseFields = 'verboseFields' in settings ? (settings.verboseFields ?? []) : [];
			// The persisted "title by" (settings.displayField, set in the ⋮ → Settings dialog) wins and
			// makes the choice sticky across type switches. Otherwise fix the id-instead-of-title bug out
			// of the box: when a type has no `name` field, auto-pick a sensible field (first string, else
			// first user field).
			if (settings.displayField) {
				titleField = settings.displayField;
			} else if (!titleField && schema && !('name' in schema)) {
				const keys = Object.keys(schema).filter((k) => isUserFieldKey(k));
				const firstString = keys.find((k) => schema?.[k]?.type === 'string');
				titleField = firstString ?? keys[0] ?? '';
			}
		} catch (e) {
			console.error(e);
		}
	}

	/**
	 * Fetch the active type's record list.
	 *
	 * `quiet` performs a **background** refresh used after an edit that could change a value OTHER rows
	 * render *by reference* — a record's title shown via another row's `record`-field, or a renamed blob
	 * shown via a `file`-field (the optimistic {@link patchRecordRow} only fixes the *edited* row). It (a)
	 * does NOT toggle `loading`, so the grid never flashes, and (b) preserves the currently-open record's
	 * in-memory row so a refetch landing mid-typing can't clobber unsaved keystrokes (`patchRecordRow`
	 * already keeps that one row correct). A normal (non-quiet) load replaces every row.
	 */
	async function loadRecords({ quiet = false }: { quiet?: boolean } = {}) {
		if (!activeTypeId || isGlobals) return;
		if (!quiet) loading = true;
		try {
			// Per-field "is empty" (Item 10) rides the existing filters param as a single clause; the
			// "Incomplete only" toggle goes via the dedicated incomplete flag (the AND-only clause model
			// can't express its OR-of-empties).
			const filters = emptyField
				? [{ field: emptyField, operator: OPERATORS.is_empty }]
				: undefined;
			const data = await apiListRecordsForType(activeTypeId, {
				groupBy: groupBy || undefined,
				titleField: titleField || undefined,
				subtitleField: subtitleField || undefined,
				searchQuery: query || undefined,
				searchField: searchField || undefined,
				sort: sortField || undefined,
				dir: sortDir,
				filters,
				incomplete: incomplete || undefined,
				// Verbose grid (Item 8): only request inline field values when the mode is on with a selection.
				fields: verbose && verboseFields.length ? verboseFields : undefined
			});
			const next = 'records' in data ? (data.records as JsonListItem[]) : [];
			// A quiet refresh must not stomp the open row: keep its current in-memory version (which
			// patchRecordRow keeps fresh) so an in-flight edit survives a background refetch.
			records =
				quiet && selectedRecordId
					? next.map((r) =>
							r.id === selectedRecordId ? (records.find((o) => o.id === selectedRecordId) ?? r) : r
						)
					: next;
		} catch (e) {
			console.error(e);
			if (!quiet) toast.error('Failed to load records');
		} finally {
			if (!quiet) loading = false;
		}
	}

	/**
	 * Optimistically patch the one edited row in place after an autosave — **no refetch**. Reusing the
	 * same `projectRecordRow` projection the server list endpoint uses keeps the row's title/subtitle/
	 * group value identical to what a reload would produce, while avoiding the full-list re-render that
	 * used to flash the page and drop in-flight keystrokes in the open editor.
	 */
	/**
	 * The field rows are actually titled by — mirrors the server's resolution in `jsonRepo.listRecords`
	 * (explicit `displayField` → `name` → first string field → first field). The optimistic patch and the
	 * reference-change check below must use THIS, not the raw `titleField`: when no `displayField` is set
	 * the page's `titleField` is `''`, but the server still populates `title_value` from the default — so
	 * projecting with `titleField || null` would wrongly blank the row's title and hide a title change.
	 */
	const effectiveTitleField = $derived.by(() => {
		if (titleField) return titleField;
		const s = schema;
		if (!s) return null;
		const keys = Object.keys(s);
		if (keys.includes('name')) return 'name';
		return keys.find((k) => s[k]?.type === 'string') ?? keys[0] ?? null;
	});

	function patchRecordRow(updated: Record<string, unknown>) {
		if (!schema) return;
		const id = updated.id as string;
		const projected = projectRecordRow(schema, updated, {
			titleField: effectiveTitleField,
			subtitleField: subtitleField || null,
			groupBy: groupBy || null
		});
		// Did the edited record's *display title* change? If so, any OTHER row in this type that points
		// at it via a `record`-field renders a now-stale title (in its tile, verbose row, or a group
		// header) — schedule a quiet background refresh so those referencing rows catch up without
		// flashing.
		const prev = records.find((r) => r.id === id);
		const titleChanged = prev != null && prev.title_value !== projected.title_value;
		records = records.map((r) =>
			r.id === id
				? {
						...r,
						name: projected.name,
						title_value: projected.title_value,
						subtitle_value: projected.subtitle_value,
						group_by_value: projected.group_by_value
					}
				: r
		);
		// Two cases need the quiet refetch: (1) a title change (above) — referencing rows; (2) the verbose
		// grid is on — this patch does NOT recompute the edited row's server-resolved `field_values`, so a
		// changed `file`/`record` verbose field would otherwise show its old filename/title until reload.
		if (titleChanged || (verbose && verboseFields.length > 0)) scheduleReferenceRefresh();
	}

	/**
	 * Debounced refresh of server-resolved display values the optimistic patch can't recompute — a
	 * *referenced* entity's title/filename on other rows, and the edited row's own verbose `field_values`.
	 * Coalesced (one trailing fire after edits settle) so rapid edits don't storm. Fires the shared
	 * `refreshTrigger`, which (a) drives THIS page's own quiet refetch via its subscription below, (b)
	 * broadcasts to other tabs (a Files grid / Records grid referencing this record by id), and (c)
	 * refreshes any mounted file/record picker — all without flashing or disturbing the open editor.
	 */
	let referenceRefreshTimer: ReturnType<typeof setTimeout> | null = null;
	function scheduleReferenceRefresh() {
		if (referenceRefreshTimer) clearTimeout(referenceRefreshTimer);
		referenceRefreshTimer = setTimeout(() => {
			referenceRefreshTimer = null;
			triggerImageListRefresh();
		}, 650);
	}
	onDestroy(() => {
		if (referenceRefreshTimer) clearTimeout(referenceRefreshTimer);
	});

	/** Switch the active type, resetting per-type view state. The URL is kept in sync by {@link syncUrl}. */
	function selectType(id: string) {
		if (id === activeTypeId) return;
		activeTypeId = id;
		selectedRecordId = null;
		clearSelection();
		selectionMode = false;
		query = '';
		searchField = '';
		groupBy = '';
		titleField = '';
		subtitleField = '';
		sortField = 'last_modified';
		sortDir = 'desc';
		verbose = false;
		verboseFields = [];
		incomplete = false;
		emptyField = '';
	}

	/**
	 * Persist the verbose grid choice (Item 8) durably on the active type, then reload so the rows pick
	 * up `field_values`. Called by the RecordListColumn Fields popover on toggle / field selection.
	 */
	async function persistVerbose() {
		if (!activeTypeId || isGlobals) return;
		try {
			await apiUpdateTypeSettings(activeTypeId, { verbose, verboseFields });
		} catch (e) {
			console.error(e);
			toast.error('Failed to save fields');
		}
		await loadRecords();
	}

	/** Persist the chosen sort durably on the active type (Item 9). The reload runs via the sort $effect. */
	async function persistSort() {
		if (!activeTypeId || isGlobals) return;
		try {
			await apiUpdateTypeSettings(activeTypeId, { sortField, sortDir });
		} catch (e) {
			console.error(e);
			toast.error('Failed to save sort');
		}
	}

	/**
	 * Tick a row's checkbox. A plain click toggles that one record and drops the range anchor there; a
	 * **shift**-click extends from the anchor across {@link orderedIds} — the same flattened group
	 * order the list renders — giving back only what the previous shift-range had claimed.
	 */
	function toggleSelect(id: string, shiftKey = false) {
		if (shiftKey && rangeAnchorId) {
			const { range, deselect } = resolveRangeSelection({
				ordered: orderedIds,
				anchorId: rangeAnchorId,
				targetId: id,
				previousRange: lastShiftRange
			});
			if (range.length) {
				for (const rid of deselect) selectedIds.delete(rid);
				for (const rid of range) selectedIds.add(rid);
				lastShiftRange = range; // anchor stays put so the next shift-click re-extends from it
				return;
			}
		}
		if (selectedIds.has(id)) selectedIds.delete(id);
		else selectedIds.add(id);
		rangeAnchorId = id;
		lastShiftRange = [];
	}

	/**
	 * Bulk-apply a selection state to a set of ids — the list's master "Select all" (every visible
	 * record) and each group header's checkbox both land here. Deselecting a group only drops that
	 * group's ids, so a selection spanning several groups survives. A bulk action ends any live
	 * shift-range: the next shift-click starts from a fresh anchor.
	 */
	function setSelected(ids: string[], selected: boolean) {
		for (const id of ids) {
			if (selected) selectedIds.add(id);
			else selectedIds.delete(id);
		}
		rangeAnchorId = null;
		lastShiftRange = [];
	}

	/** Drop the whole selection **and** the shift-click range state (they must never outlive it). */
	function clearSelection() {
		selectedIds.clear();
		rangeAnchorId = null;
		lastShiftRange = [];
	}

	function toggleSelectionMode() {
		clearSelection();
		if (selectionMode) {
			selectionMode = false;
		} else {
			selectedRecordId = null;
			selectionMode = true;
		}
	}

	async function createRecord() {
		if (!activeTypeId || isGlobals) return;
		try {
			const created = await apiCreateRecordForType(activeTypeId);
			await loadRecords();
			selectedRecordId = created.id;
		} catch (e) {
			console.error(e);
			toast.error('Failed to create record');
		}
	}

	async function createRecordType() {
		const name = newTypeName.trim();
		if (!name) return;
		try {
			const created = await apiCreateMediaType({ displayName: name, kind: 'json' });
			newTypeName = '';
			newTypeOpen = false;
			types = await fetchTypes().catch(() => types);
			selectType(created.id);
		} catch (e) {
			console.error(e);
			toast.error('Failed to create record type');
		}
	}

	function toggleRail() {
		railCollapsed = !railCollapsed;
		settingsStore.updateSetting('railCollapsed', railCollapsed);
	}

	function openTypeSettings(id: string) {
		settingsTargetId = id;
		settingsOpen = true;
	}

	function askDeleteType(id: string) {
		deleteTargetId = id;
		deleteOpen = true;
	}

	/** After a rename / title-by / schema change in the settings dialog: refresh names + the active view. */
	async function afterTypeSettingsChange() {
		types = await fetchTypes().catch(() => types);
		if (activeTypeId && !isGlobals) {
			await loadSchema();
			await loadRecords();
			editorRefresh++;
		}
	}

	async function doDeleteType() {
		const id = deleteTargetId;
		if (!id) return;
		try {
			await apiDeleteMediaType(id);
			toast.success('Record type deleted');
			deleteOpen = false;
			settingsOpen = false;
			types = await fetchTypes().catch(() => types);
			if (activeTypeId === id) {
				selectedRecordId = null;
				activeTypeId = types[0]?.id ?? null; // URL kept in sync by syncUrl
			}
		} catch (e) {
			console.error(e);
			toast.error('Failed to delete record type');
		}
	}

	async function afterBulk() {
		clearSelection();
		await loadRecords();
		// A bulk set-field/delete can change titles or drop records that other grids/pickers reference;
		// notify them (here and in other tabs).
		triggerImageListRefresh();
	}

	// Initial load: settings (rail state), the type list, and the initial active type from ?type=.
	onMount(() => {
		// Back-compat: Globals moved out of the Records hub to its own /globals route. Redirect any
		// stale ?type=globals link there instead of trying to open it as a record type.
		if ($page.url.searchParams.get('type') === 'globals') {
			goto('/globals', { replaceState: true });
			return;
		}
		settingsStore.fetchSettings();
		(async () => {
			try {
				types = await fetchTypes();
			} catch (e) {
				console.error(e);
			}
			const wanted = $page.url.searchParams.get('type');
			activeTypeId = wanted && types.some((t) => t.id === wanted) ? wanted : (types[0]?.id ?? null);
			// Reopen the deep-linked record (?record=) for the active type.
			const wantedRecord = $page.url.searchParams.get('record');
			if (wantedRecord && activeTypeId === wanted) selectedRecordId = wantedRecord;
			loadingTypes = false;
			urlReady = true; // initial restore done — the URL writer below may now run
		})();
		return () => currentMediaTypeStore.set(null);
	});

	/**
	 * Keep the URL in sync with the active type + open record so reload / share / back-forward
	 * reproduce the view. `replaceState` (no per-click history spam); gated by `urlReady` so it can't
	 * fire before the initial restore consumes the incoming `?type=`/`?record=`.
	 */
	$effect(() => {
		const type = activeTypeId;
		const record = selectedRecordId;
		if (!urlReady) return;
		const parts: string[] = [];
		if (type) parts.push(`type=${encodeURIComponent(type)}`);
		if (record) parts.push(`record=${encodeURIComponent(record)}`);
		replaceState(parts.length ? `/media?${parts.join('&')}` : '/media', {});
	});

	// Mirror the persisted rail-collapsed pref.
	$effect(() => {
		const unsub = settingsStore.subscribe((s) => {
			railCollapsed = s.railCollapsed;
		});
		return unsub;
	});

	// When the active type changes: set the shared store (for SchemaEditorButton) + load schema/records.
	$effect(() => {
		const id = activeTypeId;
		if (!id) return;
		const t = types.find((x) => x.id === id);
		currentMediaTypeStore.set({ typeId: id, kind: 'json', displayName: t?.displayName });
		if (id !== 'globals') {
			loadSchema();
			loadRecords();
		}
	});

	// Reload when group-by / title-field / search / sort change (all server-side now).
	$effect(() => {
		groupBy;
		titleField;
		subtitleField;
		query;
		searchField;
		sortField;
		sortDir;
		incomplete;
		emptyField;
		if (activeTypeId && !isGlobals) loadRecords();
	});

	// Quiet refetch on any list-refresh bump: this page's own debounced reference refresh
	// (`scheduleReferenceRefresh`), a record delete/bulk op here, OR a cross-tab edit (a blob renamed in
	// the Files app, a linked record edited in another tab) that changes a value this type renders by id.
	// Quiet so an open editor here isn't disturbed.
	$effect(() => {
		let prev = 0;
		const unsub = refreshTrigger.subscribe((n) => {
			if (n !== prev) {
				prev = n;
				if (activeTypeId && !isGlobals) loadRecords({ quiet: true });
			}
		});
		return unsub;
	});
	$effect(() => {
		let prev = 0;
		const unsub = schemaRefreshTrigger.subscribe((n) => {
			if (n !== prev) {
				prev = n;
				if (activeTypeId && !isGlobals) {
					loadSchema();
					loadRecords();
					editorRefresh++;
				}
			}
		});
		return unsub;
	});
</script>

<div class="flex h-screen w-full overflow-hidden">
	<RecordsRail
		{types}
		{activeTypeId}
		collapsed={railCollapsed}
		onSelect={selectType}
		onToggleCollapse={toggleRail}
		onNewType={() => (newTypeOpen = true)}
		onOpenSettings={openTypeSettings}
		onDeleteType={askDeleteType}
		bind:query
		bind:searchField
		{searchFields}
		bind:incomplete
		bind:emptyField
	/>

	{#if loadingTypes}
		<div class="flex flex-1 items-center justify-center p-8">
			<p class="text-muted-foreground">Loading…</p>
		</div>
	{:else if !activeTypeId}
		<div class="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
			<FolderOpen class="size-8 text-muted-foreground" />
			<p class="text-muted-foreground">No record types yet.</p>
			<Button onclick={() => (newTypeOpen = true)}>New record type</Button>
		</div>
	{:else}
		<RecordListColumn
			{crumbs}
			{typeName}
			typeId={activeTypeId}
			{schema}
			{records}
			{loading}
			bind:groupBy
			bind:sortField
			bind:sortDir
			onSortChange={persistSort}
			bind:verbose
			bind:verboseFields
			onVerboseChange={persistVerbose}
			{selectionMode}
			{selectedIds}
			{selectedRecordId}
			onOpen={(id) => (selectedRecordId = id)}
			onToggleSelect={toggleSelect}
			onSetSelected={setSelected}
			onNewRecord={createRecord}
			onToggleSelectionMode={toggleSelectionMode}
			onBulkChanged={afterBulk}
			onOpenSettings={() => activeTypeId && openTypeSettings(activeTypeId)}
			onDeleteType={() => activeTypeId && askDeleteType(activeTypeId)}
		/>

		{#if selectedRecordId}
			<RecordDetailPane
				typeId={activeTypeId}
				recordId={selectedRecordId}
				{titleField}
				index={editorIndex}
				total={orderedIds.length}
				refresh={editorRefresh}
				onPrev={() => gotoRecord(-1)}
				onNext={() => gotoRecord(1)}
				onclose={() => (selectedRecordId = null)}
				onchanged={patchRecordRow}
				ondeleted={async () => {
					selectedRecordId = null;
					await loadRecords();
					// A deleted record turns any blob's `record`-field reference to it into a missing-ref;
					// notify the Files grid / pickers (here and in other tabs) so that surfaces there too.
					triggerImageListRefresh();
				}}
			/>
		{/if}
	{/if}
</div>

<Dialog.Root bind:open={newTypeOpen}>
	<Dialog.Content class="max-w-sm">
		<Dialog.Title>New record type</Dialog.Title>
		<Dialog.Description>A `json` record type — pure records, no file attachment.</Dialog.Description
		>
		<div class="flex flex-col gap-2 py-2">
			<Label for="new-type-name">Name</Label>
			<Input
				id="new-type-name"
				bind:value={newTypeName}
				placeholder="Record type name"
				onkeydown={(e) => e.key === 'Enter' && createRecordType()}
			/>
		</div>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (newTypeOpen = false)}>Cancel</Button>
			<Button onclick={createRecordType} disabled={!newTypeName.trim()}>Create</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

{#if settingsTargetId}
	{#key settingsTargetId}
		<EntitySettingsDialog
			adapter={typeSettingsAdapter(settingsTargetId)}
			name={settingsTargetName}
			bind:open={settingsOpen}
			onchanged={afterTypeSettingsChange}
			ondeleted={async () => {
				const id = settingsTargetId;
				settingsOpen = false;
				types = await fetchTypes().catch(() => types);
				if (activeTypeId === id) {
					selectedRecordId = null;
					activeTypeId = types[0]?.id ?? null;
				}
			}}
		/>
	{/key}
{/if}

<AlertDialog.Root bind:open={deleteOpen}>
	<AlertDialog.Content>
		<AlertDialog.Title>Delete record type</AlertDialog.Title>
		<AlertDialog.Description>
			Delete the record type “{deleteTargetName}” and all its records? This cannot be undone.
		</AlertDialog.Description>
		<div class="mt-4 flex justify-end gap-2">
			<AlertDialog.Cancel type="button">Cancel</AlertDialog.Cancel>
			<Button variant="destructive" type="button" onclick={doDeleteType}>Delete record type</Button>
		</div>
	</AlertDialog.Content>
</AlertDialog.Root>
