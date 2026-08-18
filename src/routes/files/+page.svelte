<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { page } from '$app/stores';
	import { replaceState } from '$app/navigation';
	import { SvelteSet } from 'svelte/reactivity';
	import {
		apiListFiles,
		apiListClassMembers,
		apiListClasses,
		apiCreateClass,
		apiAddMembers,
		apiRemoveMembers,
		apiDeleteFilesFromDisk,
		apiDeleteClass,
		apiUploadFile,
		apiBlobUrl,
		apiGetMissingFiles,
		apiGetClass,
		apiUpdateClassConfig,
		apiBulkUpdateClassRecords,
		type MissingFilesResponse
	} from '$lib/api/files.js';
	import { fieldLabel } from '$lib/core/fieldKeys.js';
	import { OPERATORS } from '$lib/core/filters.js';
	import { hasAllowedImageExtension } from '$lib/core/images.js';
	import { formatBytes } from '$lib/core/bytes.js';
	import { ssimLabel } from '$lib/api/compression.js';
	import FileEditorPanel from '$lib/components/FileEditorPanel.svelte';
	import BulkSetFieldDialog from '$lib/components/BulkSetFieldDialog.svelte';
	import EntityRail from '$lib/components/rail/EntityRail.svelte';
	import Breadcrumbs from '$lib/components/Breadcrumbs.svelte';
	import SearchBox from '$lib/components/SearchBox.svelte';
	import SearchFieldSelect from '$lib/components/SearchFieldSelect.svelte';
	import EmptyFieldFilter from '$lib/components/EmptyFieldFilter.svelte';
	import SortControl from '$lib/components/SortControl.svelte';
	import VerboseFieldsMenu from '$lib/components/data-grid/VerboseFieldsMenu.svelte';
	import EntityRowMenu from '$lib/components/entity-settings/EntityRowMenu.svelte';
	import EntitySettingsDialog from '$lib/components/entity-settings/EntitySettingsDialog.svelte';
	import { classSettingsAdapter } from '$lib/components/entity-settings/adapters.js';
	import DataGrid from '$lib/components/data-grid/DataGrid.svelte';
	import EntityIcon from '$lib/components/EntityIcon.svelte';
	import type { GridItem, GridConfig, GridCallbacks } from '$lib/components/data-grid/types.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import * as Tooltip from '$lib/components/ui/tooltip/index.js';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import GooglePhotosDialog from '$lib/components/google-photos/GooglePhotosDialog.svelte';
	import { ChevronDown, ListChecks, Plus, Upload, X } from 'lucide-svelte';
	import { toast } from 'svelte-sonner';
	import { settingsStore } from '$lib/stores/settings.js';
	import { refreshTrigger, triggerImageListRefresh } from '$lib/stores/refreshTrigger.js';
	import type { SortDir } from '$lib/core/sort.js';
	import type { ClassSummary, FileItem, SchemaDefinition } from '$lib/core/types.js';

	let files = $state<FileItem[]>([]);
	let classes = $state<ClassSummary[]>([]);
	let loading = $state(true);

	/** Catalog view (single class) config: ad-hoc group-by and the class's schema keys. */
	let catalogSchemaKeys = $state<string[]>([]);
	/** The solo class's full schema — drives the bulk "Set field…" value widgets (null outside a catalog). */
	let catalogSchema = $state<SchemaDefinition | null>(null);
	let catalogGroupBy = $state('');
	let catalogLoadedFor: string | null = null;
	/**
	 * List sort (Item 9). `sortField`/`sortDir` are the **active** sort bound to the toolbar control;
	 * their persistence target depends on the view: a solo class persists to its class config, while
	 * the All Files / "any of" / "all of" views persist to the media-wide settings (`hubSort*`, the
	 * remembered hub default). Built-in keys: `name` · `created_at` · `size` (+ `last_modified` and the
	 * class's schema fields in a catalog).
	 */
	let sortField = $state('created_at');
	let sortDir = $state<SortDir>('desc');
	let hubSortField = $state('created_at');
	let hubSortDir = $state<SortDir>('desc');
	/**
	 * Verbose grid (Item 8). `verbose`/`verboseFields` are the **active** choice bound to the toolbar;
	 * like the sort, the persistence target depends on the view: a solo class catalog saves to its class
	 * config — a mix of class schema keys (server-resolved into `field_values`) and File-info keys —
	 * while All Files / multi-class saves to the media-wide hub default (`hubVerbose*`), File-info only.
	 * File-info keys are resolved client-side. See {@link FILE_INFO_OPTIONS} / {@link verboseGroups}.
	 */
	let verbose = $state(false);
	let verboseFields = $state<string[]>([]);
	let hubVerbose = $state(false);
	let hubVerboseFields = $state<string[]>([]);
	/**
	 * Empty/incomplete quick-filter (Item 10) — only meaningful in a single-class catalog (it needs a
	 * schema). Transient (NOT persisted), reset when the solo class changes/clears. `incomplete` keeps
	 * members with any empty class field; `emptyField` (`''` = off) keeps members whose that one field
	 * is empty. Both AND with search server-side.
	 */
	let incomplete = $state(false);
	let emptyField = $state('');
	/**
	 * Grid size for every view here — a single global app setting (`media/settings.json`), shared
	 * with the catalog, multi-class, and `json` record grids. Synced from the store; changing it
	 * persists globally (see {@link setSize}).
	 */
	let gridSize = $state<'small' | 'medium' | 'large'>('medium');
	/** Group the All Files / "any of" views by each file's exact set of classes (flat by default). */
	let groupByClass = $state(false);
	/**
	 * Multi-class "all of" view: group by one class's field, encoded `classId::field` ('' = flat).
	 * Schema keys per selected class are loaded lazily into `crossSchemas` for the option list.
	 */
	let crossGroupBy = $state('');
	let crossSchemas = $state<Record<string, string[]>>({});
	/** Bumped to force the open editor panel to reload (e.g. after a class schema change). */
	let editorRefresh = $state(0);

	let query = $state('');
	/**
	 * Which field the search is scoped to. `''` = All fields (filename + fields) in a class context,
	 * or just Filename in the All-Files / "any of" view. In a single-class catalog it's a class field
	 * key; in the cross "all of" view it's the `classId::field` encoding (same as the group-by picker).
	 */
	let searchField = $state('');
	const selectedClasses = new SvelteSet<string>();
	let unclassified = $state(false);
	let matchAll = $state(false);
	let classSearch = $state('');

	const selectedIds = new SvelteSet<string>();
	/** Multiselect: off by default; toggled by the header button. Tiles only select while on. */
	let selectionMode = $state(false);
	/**
	 * The open file is deep-linked via `?file=<id>` (alongside `?class=`), so a reload or shared URL
	 * reopens the same file editor. Initialized straight from the URL; {@link syncUrl} writes it back on
	 * change. `urlReady` gates that writer until the initial restore in {@link onMount} has run, so the
	 * first effect pass can't clobber the incoming `?class=`/`?file=` before we've consumed them.
	 */
	let editorFileId = $state<string | null>($page.url.searchParams.get('file'));
	let urlReady = $state(false);
	let missing = $state<MissingFilesResponse>({ count: 0, files: [] });
	/** Google Photos import dialog (Item 37). */
	let googlePhotosOpen = $state(false);
	let showMissing = $state(false);

	let newClassName = $state('');
	let showNewClass = $state(false);
	let bulkClassId = $state('');
	let setFieldOpen = $state(false);
	let deleteFilesOpen = $state(false);
	let fileInput = $state<HTMLInputElement | null>(null);

	// Unified class settings dialog (⋮ → Settings) + delete confirm.
	let settingsOpen = $state(false);
	let manageClassId = $state('');
	let manageClassName = $state('');
	let deleteClassOpen = $state(false);
	let deleteClassId = $state('');
	let deleteClassName = $state('');

	/** Rail collapse mirrors the shared global pref (same one the Records rail uses). */
	let railCollapsed = $state(false);

	const editorFile = $derived(files.find((f) => f.id === editorFileId) ?? null);
	const editorIndex = $derived(files.findIndex((f) => f.id === editorFileId));

	/** Open the neighbour file in the current filtered grid order. */
	function gotoFile(delta: number) {
		const next = files[editorIndex + delta];
		if (next) editorFileId = next.id;
	}
	const filteredClasses = $derived(
		classSearch
			? classes.filter((c) => c.displayName.toLowerCase().includes(classSearch.toLowerCase()))
			: classes
	);
	/** Single class selected (and not unclassified) ⇒ that class's catalog view. */
	const soloClass = $derived(
		!unclassified && selectedClasses.size === 1 ? [...selectedClasses][0] : null
	);
	/** Multiple classes intersected with "all of" ⇒ offer group-by-field across those classes. */
	const crossMode = $derived(matchAll && selectedClasses.size > 1 && !unclassified);
	/** Group-by options for {@link crossMode}: one `classId::field` entry per field, labelled `Class: field`. */
	const crossOptions = $derived.by(() => {
		if (!crossMode) return [] as { value: string; label: string }[];
		const opts: { value: string; label: string }[] = [];
		for (const cid of [...selectedClasses].sort((a, b) => a.localeCompare(b))) {
			const name = classLabel(cid);
			for (const k of crossSchemas[cid] ?? []) {
				opts.push({ value: `${cid}::${k}`, label: `${name}: ${fieldLabel(k)}` });
			}
		}
		return opts;
	});
	const crossGroupByLabel = $derived(
		crossGroupBy ? (crossOptions.find((o) => o.value === crossGroupBy)?.label ?? 'None') : 'None'
	);

	/**
	 * Fields offered by the rail's search-field picker — mirrors the group-by feature: a solo class's
	 * own fields, the `Class: field` set across an intersection, else none (filename only).
	 */
	const searchFields = $derived.by(() => {
		if (soloClass) return catalogSchemaKeys.map((k) => ({ key: k, label: fieldLabel(k) }));
		if (crossMode) return crossOptions.map((o) => ({ key: o.value, label: o.label }));
		return [] as { key: string; label: string }[];
	});
	/** The All-fields/Filename default label, and whether there's any field to narrow to. */
	const searchAllLabel = $derived(soloClass || crossMode ? 'All fields' : 'Filename');
	const searchFieldHasFields = $derived(soloClass != null || crossMode);

	// Drop a stale scoped field when the class context changes (e.g. solo → all files).
	$effect(() => {
		if (searchField && !searchFields.some((f) => f.key === searchField)) searchField = '';
	});

	// Reset the empty/incomplete filter (Item 10) outside a single-class catalog, and drop a stale
	// per-field key when the catalog's schema no longer has it — so a stale `incomplete` can't leak.
	$effect(() => {
		if (!soloClass) {
			if (incomplete) incomplete = false;
			if (emptyField) emptyField = '';
		} else if (emptyField && !catalogSchemaKeys.includes(emptyField)) {
			emptyField = '';
		}
	});
	const bulkLabel = $derived(
		classes.find((c) => c.id === bulkClassId)?.displayName ?? 'Add to class…'
	);

	/** Breadcrumb trail: Home › Files › <solo class | All Files>. The solo class crumb shows its icon. */
	const crumbs = $derived([
		{ label: 'Home', href: '/' },
		{ label: 'Files', href: '/files' },
		soloClass
			? { label: classLabel(soloClass), icon: classIcon(soloClass), iconFallback: 'tag' as const }
			: { label: 'All Files' }
	]);

	/** Human label for a sort key (built-ins + schema fields). */
	function sortLabel(key: string): string {
		if (key === 'name') return 'Name';
		if (key === 'last_modified') return 'Last modified';
		if (key === 'created_at') return 'Date added';
		if (key === 'size') return 'Size';
		// Compression pair (Item 15 phase 2): biggest wins first / worst-scoring derivative first.
		if (key === 'saved') return 'Bytes saved';
		if (key === 'quality') return 'Compression quality';
		return fieldLabel(key);
	}

	/**
	 * Sort options for the active view (Item 9): a solo class catalog offers the per-record keys + its
	 * schema fields; the All Files / multi-class views offer only intrinsic blob keys. `saved`/`quality`
	 * are intrinsic too (they describe the blob's derivatives, not any class's record), so they're
	 * offered everywhere; blobs with no derivative sort last rather than as a zero.
	 */
	const sortOptions = $derived.by(() => {
		const builtins = soloClass
			? ['name', 'last_modified', 'created_at', 'size', 'saved', 'quality']
			: ['name', 'created_at', 'size', 'saved', 'quality'];
		const fields = soloClass ? catalogSchemaKeys : [];
		return [...builtins, ...fields].map((k) => ({ value: k, label: sortLabel(k) }));
	});

	/**
	 * Verbose grid (Item 8) **File info** options — blob-intrinsic keys that exist for any file
	 * regardless of class. Available in **every** Files view (incl. a single-class catalog, alongside
	 * that class's Fields). Keys are namespaced with {@link FILE_INFO_PREFIX} so they coexist with schema
	 * field keys in one `verboseFields` array and are resolved **client-side** (see {@link intrinsicValue})
	 * — the server's `field_values` only ever covers real schema fields.
	 */
	const FILE_INFO_PREFIX = 'file:';
	const FILE_INFO_OPTIONS = [
		{ key: `${FILE_INFO_PREFIX}size`, label: 'Size' },
		{ key: `${FILE_INFO_PREFIX}dimensions`, label: 'Dimensions' },
		{ key: `${FILE_INFO_PREFIX}type`, label: 'Type' },
		{ key: `${FILE_INFO_PREFIX}created`, label: 'Date added' },
		// Compression (Item 15 phase 2) — read off `FileItem.compression`, absent for an uncompressed blob.
		{ key: `${FILE_INFO_PREFIX}saved`, label: 'Saved' },
		{ key: `${FILE_INFO_PREFIX}quality`, label: 'Quality' },
		{ key: `${FILE_INFO_PREFIX}presets`, label: 'Presets' }
	];

	/**
	 * Verbose-grid groups for the active view: a **File info** group always, plus a **Fields** group of
	 * the solo class's schema fields when in a single-class catalog. All Files / multi-class shows File
	 * info only (heterogeneous blobs have no shared schema).
	 */
	const verboseGroups = $derived(
		soloClass
			? [
					{ label: 'File info', options: FILE_INFO_OPTIONS },
					{
						label: 'Fields',
						options: catalogSchemaKeys.map((k) => ({ key: k, label: fieldLabel(k) }))
					}
				]
			: [{ label: 'File info', options: FILE_INFO_OPTIONS }]
	);

	/** A verboseFields key is a File-info (intrinsic) key vs. a class schema field key. */
	const isFileInfoKey = (key: string) => key.startsWith(FILE_INFO_PREFIX);

	/** Render one File-info (intrinsic) key for a blob to a short string (`''` when unknown). */
	function intrinsicValue(f: FileItem, key: string): string {
		const k = key.slice(FILE_INFO_PREFIX.length);
		if (k === 'size') return f.size != null ? formatBytes(f.size) : '';
		if (k === 'dimensions') return f.width && f.height ? `${f.width}×${f.height}` : '';
		if (k === 'type') {
			const dot = f.file_name.lastIndexOf('.');
			return dot > 0 ? f.file_name.slice(dot + 1).toUpperCase() : '';
		}
		if (k === 'created') return f.created_at ? new Date(f.created_at).toLocaleDateString() : '';
		// Compression (Item 15 phase 2). A blob with no derivative has no `compression` at all, and every
		// one of these returns '' for it — a "0 B" or "—" would read as a measured result rather than as
		// "this file was never compressed".
		if (k === 'saved') {
			if (!f.compression) return '';
			// Cap at 99%: a derivative that still exists never saved *all* the bytes, and a rounded
			// "100%" claims it did.
			const pct = Math.min(99, Math.round(f.compression.savedPct));
			return `${formatBytes(f.compression.savedBytes)}${pct > 0 ? ` (${pct}%)` : ''}`;
		}
		if (k === 'quality') {
			// The **lowest** score across this blob's derivatives — the worst thing actually being served.
			const ssim = f.compression?.ssim;
			if (ssim == null) return '';
			const label = ssimLabel(ssim);
			return label ? `${ssim.toFixed(3)} · ${label}` : ssim.toFixed(3);
		}
		if (k === 'presets') return f.compression?.presets.join(', ') ?? '';
		return '';
	}

	/** Label for a verboseFields key — File-info keys come from the fixed list, else the schema label. */
	function verboseKeyLabel(key: string): string {
		if (isFileInfoKey(key))
			return (
				FILE_INFO_OPTIONS.find((o) => o.key === key)?.label ?? key.slice(FILE_INFO_PREFIX.length)
			);
		return fieldLabel(key);
	}

	/** Load a class's catalog config (group-by + sort defaults, schema keys) for the catalog view. */
	async function loadCatalogConfig(classId: string) {
		try {
			const detail = await apiGetClass(classId);
			catalogSchema = detail.schema;
			catalogSchemaKeys = Object.keys(detail.schema).sort((a, b) => a.localeCompare(b));
			catalogGroupBy = detail.config.gridGroupByField ?? '';
			// Per-class persisted sort; default last_modified desc (catalog rows have records).
			sortField = detail.config.sortField || 'last_modified';
			sortDir = detail.config.sortDir === 'asc' ? 'asc' : 'desc';
			// Per-class persisted verbose grid (Item 8). Fields are class schema keys (server-resolved).
			verbose = detail.config.verbose ?? false;
			verboseFields = detail.config.verboseFields ?? [];
		} catch {
			catalogSchema = null;
			catalogSchemaKeys = [];
			catalogGroupBy = '';
			sortField = 'last_modified';
			sortDir = 'desc';
			verbose = false;
			verboseFields = [];
		}
	}

	/**
	 * (Re)load the current file listing.
	 *
	 * `quiet` performs a **background** refresh that does NOT toggle `loading` (so the grid never flashes)
	 * — used after a per-file field autosave in a catalog view, where the tile's server-resolved
	 * `title_value` (the title-by field) and verbose `field_values` change but nothing structural does.
	 * The open editor panel is undisturbed: its `sections` reload only when `file.id`/`file.file_name`
	 * change, neither of which a field edit touches.
	 */
	async function loadFiles({ quiet = false }: { quiet?: boolean } = {}) {
		if (!quiet) loading = true;
		try {
			if (soloClass) {
				if (catalogLoadedFor !== soloClass) {
					await loadCatalogConfig(soloClass);
					catalogLoadedFor = soloClass;
				}
				// Per-field "is empty" (Item 10) rides the existing filters param as a single clause; the
				// "Incomplete only" toggle goes via the dedicated incomplete flag.
				const filters = emptyField
					? [{ field: emptyField, operator: OPERATORS.is_empty }]
					: undefined;
				const data = await apiListClassMembers(soloClass, {
					groupBy: catalogGroupBy || undefined,
					query: query || undefined,
					searchField: searchField || undefined,
					sort: sortField || undefined,
					dir: sortDir,
					filters,
					incomplete: incomplete || undefined,
					// Verbose grid (Item 8): only the schema-field keys go to the server (it inlines them as
					// `field_values`); File-info keys are intrinsic and resolved client-side, so strip them.
					fields:
						verbose && verboseFields.length
							? verboseFields.filter((k) => !isFileInfoKey(k))
							: undefined
				});
				files = data.files;
			} else {
				catalogLoadedFor = null;
				// Outside a catalog the sort comes from the remembered media-wide hub default.
				sortField = hubSortField;
				sortDir = hubSortDir;
				// Verbose (Item 8) outside a catalog uses the hub default; fields are intrinsic (client-side).
				verbose = hubVerbose;
				verboseFields = hubVerboseFields;
				const [gc, gf] = crossMode && crossGroupBy ? crossGroupBy.split('::') : [];
				const data = await apiListFiles({
					query: query || undefined,
					classIds: unclassified ? [] : [...selectedClasses],
					matchAll,
					unclassified,
					groupByClass: gc,
					groupByField: gf,
					searchField: searchField || undefined,
					sort: sortField || undefined,
					dir: sortDir
				});
				files = data.files;
			}
		} finally {
			if (!quiet) loading = false;
		}
	}

	/**
	 * Debounced list-refresh bump for the high-frequency field-autosave path. In a catalog the edited
	 * field may be the title-by (drives `title_value`) or a verbose field (both server-resolved), and a
	 * linked `record`-field edit propagates to the partner Records type. Firing `refreshTrigger` (rather
	 * than calling `loadFiles` inline) drives this page's own quiet refetch via the subscription below AND
	 * notifies other tabs / mounted pickers. Coalesced so rapid autosaves don't storm.
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

	// Quiet refetch on any list-refresh bump: this page's own debounced reference refresh, a structural
	// change / bulk op here, OR a cross-tab edit (a record retitled or deleted in the Records app that a
	// tile renders via a `record`-field, a blob changed in another tab). Quiet so an open editor isn't
	// disturbed.
	$effect(() => {
		let prev = 0;
		const unsub = refreshTrigger.subscribe((n) => {
			if (n !== prev) {
				prev = n;
				loadFiles({ quiet: true });
			}
		});
		return unsub;
	});

	/** Re-run the catalog member query when the user picks a different group-by field. */
	async function changeCatalogGroupBy(field: string) {
		catalogGroupBy = field;
		await loadFiles();
	}

	/** Re-run the "all of" listing when the user picks a different cross-class group-by field. */
	async function changeCrossGroupBy(value: string) {
		crossGroupBy = value;
		await loadFiles();
	}

	/**
	 * Persist + apply a sort change (Item 9). A solo class saves to its class config; every other view
	 * saves to the media-wide hub default. The control has already updated `sortField`/`sortDir`.
	 */
	async function onSortChange() {
		try {
			if (soloClass) {
				await apiUpdateClassConfig(soloClass, { sortField, sortDir });
			} else {
				hubSortField = sortField;
				hubSortDir = sortDir;
				await fetch('/api/settings', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ sortField, sortDir })
				});
			}
		} catch (e) {
			console.error(e);
			toast.error('Failed to save sort');
		}
		await loadFiles();
	}

	/**
	 * Persist + apply a verbose-grid change (Item 8). A solo class saves to its class config; every other
	 * view saves to the media-wide hub default. The control has already updated `verbose`/`verboseFields`.
	 */
	async function onVerboseChange() {
		try {
			if (soloClass) {
				await apiUpdateClassConfig(soloClass, { verbose, verboseFields });
			} else {
				hubVerbose = verbose;
				hubVerboseFields = verboseFields;
				await fetch('/api/settings', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ verbose, verboseFields })
				});
			}
		} catch (e) {
			console.error(e);
			toast.error('Failed to save fields');
		}
		await loadFiles();
	}

	async function loadMeta() {
		[classes, missing] = await Promise.all([
			apiListClasses(),
			apiGetMissingFiles().catch(() => ({ count: 0, files: [] }))
		]);
	}

	/** After a class schema/settings/delete change: refresh metadata, the grid, and the open panel. */
	async function afterClassChange() {
		catalogLoadedFor = null; // re-read group-by/size/schema for the catalog view
		await loadMeta();
		await loadFiles();
		editorRefresh++;
	}

	/** Resolve a class id to its display name (falls back to the raw id). */
	function classLabel(cid: string): string {
		return classes.find((c) => c.id === cid)?.displayName ?? cid;
	}

	/** Resolve a class id to its stored icon id (undefined ⇒ chip/header use the generic `tag` fallback). */
	function classIcon(cid: string): string | undefined {
		return classes.find((c) => c.id === cid)?.icon;
	}

	/** Group files by their server-provided `group_by_value` (solo-class field or cross-class field). */
	function groupByFieldValue(): [string, FileItem[]][] {
		const groups: Record<string, FileItem[]> = {};
		for (const f of files) {
			const v = f.group_by_value;
			const key =
				v == null || v === ''
					? '—'
					: Array.isArray(v)
						? v.length
							? v.join(', ')
							: '—'
						: String(v);
			(groups[key] ??= []).push(f);
		}
		return Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0]));
	}

	/**
	 * Files grouped for the grid, or null when showing a flat list:
	 * - solo class + a chosen field → server-provided `group_by_value`;
	 * - multi-class "all of" + a chosen `Class: field` → likewise via `group_by_value`;
	 * - All Files / "any of" view + Group-by-class → each file's exact set of classes joined as one
	 *   combo group ("Images + Documents"), with member-less files under "Unclassified".
	 */
	const groupedFiles = $derived.by(() => {
		if (soloClass) {
			return catalogGroupBy ? groupByFieldValue() : null;
		}
		if (crossMode && crossGroupBy) {
			return groupByFieldValue();
		}
		if (groupByClass && !unclassified) {
			const groups: Record<string, FileItem[]> = {};
			for (const f of files) {
				const key =
					f.classes.length === 0
						? 'Unclassified'
						: f.classes
								.map(classLabel)
								.sort((a, b) => a.localeCompare(b))
								.join(' + ');
				(groups[key] ??= []).push(f);
			}
			return Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0]));
		}
		return null;
	});

	/** Map a blob row to a side-agnostic grid item (chips = class membership, capped at 3 + "+N"). */
	function toGridItem(f: FileItem): GridItem {
		const shown = f.classes.slice(0, 3);
		// In a single-class catalog view the server resolves that class's "Title by" field into
		// `title_value`; show it as the tile label and demote the filename to a muted subtitle so it's
		// not lost. Outside that view (All Files) `title_value` is absent ⇒ the filename stays primary.
		const title = f.title_value?.trim();
		return {
			id: f.id,
			primaryLabel: title || f.file_name,
			secondaryLabel: title && title !== f.file_name ? f.file_name : undefined,
			thumbnailUrl: hasAllowedImageExtension(f.file_name) ? apiBlobUrl(f.id) : undefined,
			aspectRatio: f.width && f.height ? f.width / f.height : undefined,
			chips:
				f.classes.length === 0
					? [{ label: 'unclassified', tone: 'muted' }]
					: shown.map((cid) => ({
							label: classLabel(cid),
							icon: classIcon(cid),
							iconFallback: 'tag' as const
						})),
			extraChips: f.classes.length > 3 ? f.classes.length - 3 : undefined,
			// Verbose mode (Item 8): walk the chosen keys in picker order, resolving each from the right
			// source — File-info (intrinsic) keys client-side, schema-field keys from the server's inlined
			// `field_values`. This lets a single-class catalog mix both groups on one tile.
			fields:
				verbose && verboseFields.length
					? verboseFields.map((k) => ({
							label: verboseKeyLabel(k),
							value: isFileInfoKey(k) ? intrinsicValue(f, k) : (f.field_values?.[k] ?? '')
						}))
					: undefined,
			warning: f.missing_file_fields?.length
				? `Missing file reference: ${f.missing_file_fields.join(', ')}`
				: undefined
		};
	}

	const gridItems = $derived(files.map(toGridItem));
	const groupedGridItems = $derived<[string | null, GridItem[]][] | null>(
		groupedFiles
			? groupedFiles.map(([k, list]) => [k, list.map(toGridItem)] as [string | null, GridItem[]])
			: null
	);
	/** Persist a new grid size globally (every grid view subscribes to the settings store). */
	function setSize(v: 'small' | 'medium' | 'large') {
		gridSize = v;
		settingsStore.updateSetting('gridSize', v);
	}

	const gridConfig = $derived<GridConfig>({
		size: gridSize,
		selectable: selectionMode,
		activeId: editorFileId,
		// Solo/cross field groups prefix the (qualified) field name; class-combo keys are self-describing.
		groupLabel: (k) =>
			soloClass
				? `${fieldLabel(catalogGroupBy)}: ${k}`
				: crossMode && crossGroupBy
					? `${crossGroupByLabel}: ${k}`
					: k,
		emptyText: 'No files.'
	});
	const gridCallbacks: GridCallbacks = {
		onOpen: (id) => (editorFileId = id),
		onToggleSelect: (id) => toggleSelect(id),
		isSelected: (id) => selectedIds.has(id)
	};

	// Keep the toolbar size control in sync with the global settings store (so the Settings dialog
	// on this same page updates it live).
	$effect(() => {
		const unsubscribe = settingsStore.subscribe((s) => {
			gridSize = s.gridSize;
			railCollapsed = s.railCollapsed;
		});
		return () => unsubscribe();
	});

	function toggleRail() {
		railCollapsed = !railCollapsed;
		settingsStore.updateSetting('railCollapsed', railCollapsed);
	}

	onMount(async () => {
		await settingsStore.fetchSettings();
		// Read the persisted All Files hub sort (Item 9) from media settings before the first listing.
		try {
			const s = await fetch('/api/settings').then((r) => r.json());
			hubSortField = typeof s.sortField === 'string' && s.sortField ? s.sortField : 'created_at';
			hubSortDir = s.sortDir === 'asc' ? 'asc' : 'desc';
			// All Files verbose grid (Item 8) hub default.
			hubVerbose = s.verbose === true;
			hubVerboseFields = Array.isArray(s.verboseFields)
				? s.verboseFields.filter((f: unknown): f is string => typeof f === 'string')
				: [];
		} catch {
			/* defaults already set */
		}
		await loadMeta();
		// ?class=<id> opens directly in that class's catalog view (?file= was restored at init).
		const initialClass = $page.url.searchParams.get('class');
		if (initialClass && classes.some((c) => c.id === initialClass)) {
			selectedClasses.add(initialClass);
		}
		await loadFiles();
		urlReady = true; // initial restore done — the URL writer below may now run
	});

	/**
	 * Keep the URL in sync with the open file + active solo class so reload / share / back-forward
	 * reproduce the view. `replaceState` (no history spam per click); gated by `urlReady` so it can't
	 * fire before the initial restore. Multi-class filter states aren't encoded — this targets the open
	 * item, not arbitrary filter combos.
	 */
	$effect(() => {
		const cls = soloClass;
		const file = editorFileId;
		if (!urlReady) return;
		const parts: string[] = [];
		if (cls) parts.push(`class=${encodeURIComponent(cls)}`);
		if (file) parts.push(`file=${encodeURIComponent(file)}`);
		replaceState(parts.length ? `/files?${parts.join('&')}` : '/files', {});
	});

	// Reload the grid when filters/search change.
	$effect(() => {
		query;
		searchField;
		[...selectedClasses].join(',');
		unclassified;
		matchAll;
		incomplete;
		emptyField;
		loadFiles();
	});

	// In "all of" mode, lazily load each selected class's schema keys for the group-by-field options.
	$effect(() => {
		if (!crossMode) return;
		for (const cid of [...selectedClasses]) {
			if (crossSchemas[cid]) continue;
			apiGetClass(cid)
				.then((d) => {
					crossSchemas = {
						...crossSchemas,
						[cid]: Object.keys(d.schema).sort((a, b) => a.localeCompare(b))
					};
				})
				.catch(() => {});
		}
	});

	function toggleClassFilter(id: string) {
		if (selectedClasses.has(id)) selectedClasses.delete(id);
		else {
			selectedClasses.add(id);
			unclassified = false;
		}
		crossGroupBy = ''; // a stale class::field would no longer match the selection
	}

	function clearFilters() {
		selectedClasses.clear();
		unclassified = false;
		query = '';
		crossGroupBy = '';
	}

	function toggleSelect(id: string) {
		if (selectedIds.has(id)) selectedIds.delete(id);
		else selectedIds.add(id);
	}

	/**
	 * Enter or leave multiselect. Entering closes the open editor and clears any prior selection so
	 * the selection ring can't be confused with the editor's active-tile ring; leaving clears too.
	 */
	function toggleSelectionMode() {
		selectedIds.clear();
		if (selectionMode) {
			selectionMode = false;
		} else {
			editorFileId = null;
			selectionMode = true;
		}
	}

	async function createClass() {
		const name = newClassName.trim();
		if (!name) return;
		const created = await apiCreateClass(name);
		newClassName = '';
		showNewClass = false;
		await loadMeta();
		selectedClasses.clear();
		selectedClasses.add(created.id);
	}

	async function bulkAdd() {
		if (!bulkClassId || selectedIds.size === 0) return;
		await apiAddMembers(bulkClassId, [...selectedIds]);
		bulkClassId = '';
		selectedIds.clear();
		await loadMeta();
		await loadFiles();
		// Membership change can flip a class-scoped picker's `_out_of_class` flag; notify pickers/tabs.
		triggerImageListRefresh();
	}

	async function bulkRemove() {
		if (!soloClass || selectedIds.size === 0) return;
		await apiRemoveMembers(soloClass, [...selectedIds]);
		selectedIds.clear();
		await loadMeta();
		await loadFiles();
		// Removing membership also unlinks the blob from any linked record (server-side cascade), so the
		// partner Records type changed — notify it (and pickers) here and in other tabs.
		triggerImageListRefresh();
	}

	/**
	 * Bulk "Set field…" in a single-class catalog: apply one class metadata field to every selected
	 * member (replace semantics). Throws on failure so the dialog stays open. A linked `record` field
	 * mutates the partner Records type / pickers (server-side mirror), so we refetch + cross-tab notify
	 * — mirroring {@link bulkRemove}.
	 */
	async function bulkSetField(key: string, value: unknown) {
		if (!soloClass || selectedIds.size === 0) return;
		await apiBulkUpdateClassRecords(soloClass, [...selectedIds], { [key]: value });
		toast.success(`Updated ${selectedIds.size} file${selectedIds.size === 1 ? '' : 's'}`);
		selectedIds.clear();
		await loadFiles();
		triggerImageListRefresh();
	}

	async function bulkDelete() {
		if (selectedIds.size === 0) return;
		await apiDeleteFilesFromDisk([...selectedIds]);
		selectedIds.clear();
		deleteFilesOpen = false;
		await loadMeta();
		await loadFiles();
		// Deleting a blob turns any record's `file`-field reference to it into a missing-ref; refresh an
		// open Records grid so that surfaces there too.
		triggerImageListRefresh();
	}

	async function onUpload(ev: Event) {
		const input = ev.currentTarget as HTMLInputElement;
		const list = input.files ? [...input.files] : [];
		for (const f of list) {
			try {
				await apiUploadFile(f, 'auto-rename');
			} catch (e) {
				console.error('upload failed', e);
			}
		}
		input.value = '';
		await loadMeta();
		await loadFiles();
	}

	function openSettings(c: ClassSummary) {
		manageClassId = c.id;
		manageClassName = c.displayName;
		settingsOpen = true;
	}

	function askDeleteClass(c: ClassSummary) {
		deleteClassId = c.id;
		deleteClassName = c.displayName;
		deleteClassOpen = true;
	}

	async function doDeleteClass() {
		try {
			await apiDeleteClass(deleteClassId);
			toast.success(`Deleted class “${deleteClassName}”`);
			selectedClasses.delete(deleteClassId);
			deleteClassOpen = false;
			await loadMeta();
			await loadFiles();
		} catch (e) {
			console.error(e);
			toast.error('Failed to delete class');
		}
	}
</script>

<div class="flex h-screen w-full overflow-hidden">
	<EntityRail current="files" collapsed={railCollapsed} onToggleCollapse={toggleRail}>
		{#snippet belowHeader()}
			<div class="flex flex-col gap-2">
				<SearchBox bind:value={query} placeholder="Search files…" />
				<SearchFieldSelect
					fields={searchFields}
					bind:value={searchField}
					allLabel={searchAllLabel}
					disabled={!searchFieldHasFields}
				/>
				{#if missing.count > 0}
					<Button
						variant="ghost"
						size="sm"
						class="w-full justify-start bg-destructive/10 text-xs text-destructive hover:bg-destructive/20"
						onclick={() => (showMissing = !showMissing)}
					>
						⚠ {missing.count} file{missing.count === 1 ? '' : 's'} missing — review
					</Button>
				{/if}
			</div>
		{/snippet}

		{#snippet body()}
			<div class="mb-1 flex items-center justify-between">
				<span class="text-xs font-medium uppercase text-muted-foreground">Classes</span>
				<Button
					variant="ghost"
					size="sm"
					class="h-6 px-1 text-xs"
					onclick={() => (showNewClass = !showNewClass)}
				>
					<Plus class="size-3" /> New
				</Button>
			</div>
			{#if showNewClass}
				<div class="mb-2 flex gap-1">
					<Input
						class="h-8 text-sm"
						placeholder="Class name"
						bind:value={newClassName}
						onkeydown={(e) => e.key === 'Enter' && createClass()}
					/>
					<Button size="sm" class="h-8" onclick={createClass}>Add</Button>
				</div>
			{/if}
			{#if classes.length > 4}
				<Input class="mb-2 h-8 text-xs" placeholder="filter classes…" bind:value={classSearch} />
			{/if}
			<ul class="space-y-0.5">
				{#each filteredClasses as c (c.id)}
					<li class="group flex items-center gap-2 rounded px-1 hover:bg-muted">
						<Checkbox
							id={`cls-${c.id}`}
							checked={selectedClasses.has(c.id)}
							onCheckedChange={() => toggleClassFilter(c.id)}
						/>
						<Label
							for={`cls-${c.id}`}
							class="flex flex-1 cursor-pointer items-center gap-2 py-1 text-sm font-normal"
						>
							<EntityIcon
								name={c.icon}
								fallback="tag"
								class="size-4 shrink-0 text-muted-foreground"
							/>
							<span class="flex-1 truncate">{c.displayName}</span>
							<span class="text-xs text-muted-foreground">{c.count}</span>
						</Label>
						<span class="opacity-0 transition-opacity group-hover:opacity-100">
							<EntityRowMenu
								noun="class"
								onSettings={() => openSettings(c)}
								onDelete={() => askDeleteClass(c)}
							/>
						</span>
					</li>
				{/each}
				{#if classes.length === 0}
					<li class="px-1 text-xs text-muted-foreground">No classes yet.</li>
				{/if}
			</ul>

			{#if selectedClasses.size > 1 && !unclassified}
				<div class="mt-2 flex items-center gap-2">
					<span class="text-xs text-muted-foreground">Match</span>
					<Button
						variant="outline"
						size="sm"
						class="h-7"
						onclick={() => {
							matchAll = !matchAll;
							crossGroupBy = '';
						}}
					>
						{matchAll ? 'all of' : 'any of'}
					</Button>
				</div>
			{/if}

			<div class="mt-3 flex items-center gap-2 border-t pt-2">
				<Checkbox
					id="filter-unclassified"
					checked={unclassified}
					onCheckedChange={(v) => {
						unclassified = !!v;
						if (unclassified) selectedClasses.clear();
					}}
				/>
				<Label for="filter-unclassified" class="cursor-pointer text-sm font-normal">
					Unclassified
				</Label>
			</div>

			{#if soloClass}
				<!-- Empty/incomplete quick-filter (Item 10): only in a single-class catalog (needs a schema). -->
				<div class="mt-3 border-t pt-3">
					<EmptyFieldFilter
						fields={catalogSchemaKeys.map((k) => ({ key: k, label: fieldLabel(k) }))}
						bind:incomplete
						bind:emptyField
					/>
				</div>
			{/if}

			{#if showMissing && missing.count > 0}
				<div class="mt-3 max-h-64 overflow-y-auto border-t pt-2 text-xs">
					{#each missing.files as mf (mf.file_id)}
						<div class="mb-2">
							<div class="font-medium text-destructive">
								{mf.file_name || mf.file_id.slice(0, 8)}
							</div>
							<ul class="ml-2 list-disc">
								{#each mf.refs as r (r.context + r.label + r.field)}
									<li>{r.context} · {r.label}{r.field ? ` (${r.field})` : ''}</li>
								{/each}
							</ul>
						</div>
					{/each}
				</div>
			{/if}
		{/snippet}

		{#snippet collapsedBody()}
			<div class="flex flex-col items-center gap-0.5">
				{#each classes as c (c.id)}
					<Tooltip.Provider delayDuration={300}>
						<Tooltip.Root>
							<Tooltip.Trigger>
								{#snippet child({ props })}
									<Button
										{...props}
										variant={selectedClasses.has(c.id) ? 'secondary' : 'ghost'}
										size="icon"
										onclick={() => toggleClassFilter(c.id)}
									>
										<EntityIcon name={c.icon} fallback="tag" class="size-4" />
									</Button>
								{/snippet}
							</Tooltip.Trigger>
							<Tooltip.Content side="right">{c.displayName} ({c.count})</Tooltip.Content>
						</Tooltip.Root>
					</Tooltip.Provider>
				{/each}
				<Tooltip.Provider delayDuration={300}>
					<Tooltip.Root>
						<Tooltip.Trigger>
							{#snippet child({ props })}
								<Button
									{...props}
									variant="ghost"
									size="icon"
									class="mt-1"
									onclick={() => {
										toggleRail();
										showNewClass = true;
									}}
								>
									<Plus class="size-4" />
								</Button>
							{/snippet}
						</Tooltip.Trigger>
						<Tooltip.Content side="right">New class</Tooltip.Content>
					</Tooltip.Root>
				</Tooltip.Provider>
			</div>
		{/snippet}
	</EntityRail>

	<!-- Main -->
	<main class="flex h-screen min-w-0 flex-1 flex-col">
		<div class="flex h-9 items-center border-b px-3">
			<Breadcrumbs items={crumbs} />
		</div>
		<header class="flex items-center gap-3 border-b p-3">
			<span class="text-sm text-muted-foreground"
				>{files.length} file{files.length === 1 ? '' : 's'}</span
			>
			<div class="flex items-center gap-1.5 text-sm">
				{#if soloClass}
					<span class="text-muted-foreground">Group by</span>
					<Select.Root type="single" value={catalogGroupBy} onValueChange={changeCatalogGroupBy}>
						<Select.Trigger class="h-8 w-36"
							>{catalogGroupBy ? fieldLabel(catalogGroupBy) : 'None'}</Select.Trigger
						>
						<Select.Content>
							<Select.Item value="">None</Select.Item>
							{#each catalogSchemaKeys as k (k)}
								<Select.Item value={k}>{fieldLabel(k)}</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
				{:else if crossMode}
					<span class="text-muted-foreground">Group by</span>
					<Select.Root type="single" value={crossGroupBy} onValueChange={changeCrossGroupBy}>
						<Select.Trigger class="h-8 w-48">{crossGroupByLabel}</Select.Trigger>
						<Select.Content>
							<Select.Item value="">None</Select.Item>
							{#each crossOptions as o (o.value)}
								<Select.Item value={o.value}>{o.label}</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
				{:else if !unclassified}
					<span class="text-muted-foreground">Group by</span>
					<Select.Root
						type="single"
						value={groupByClass ? 'class' : ''}
						onValueChange={(v) => (groupByClass = v === 'class')}
					>
						<Select.Trigger class="h-8 w-36">{groupByClass ? 'Class' : 'None'}</Select.Trigger>
						<Select.Content>
							<Select.Item value="">None</Select.Item>
							<Select.Item value="class">Class</Select.Item>
						</Select.Content>
					</Select.Root>
				{/if}
				<SortControl
					options={sortOptions}
					bind:field={sortField}
					bind:dir={sortDir}
					onchange={onSortChange}
				/>
				<VerboseFieldsMenu
					bind:verbose
					bind:selected={verboseFields}
					groups={verboseGroups}
					onchange={onVerboseChange}
				/>
				<span class="text-muted-foreground">Size</span>
				<Select.Root
					type="single"
					value={gridSize}
					onValueChange={(v) => setSize(v as 'small' | 'medium' | 'large')}
				>
					<Select.Trigger class="h-8 w-28">{gridSize}</Select.Trigger>
					<Select.Content>
						<Select.Item value="small">small</Select.Item>
						<Select.Item value="medium">medium</Select.Item>
						<Select.Item value="large">large</Select.Item>
					</Select.Content>
				</Select.Root>
			</div>
			<div class="flex-1"></div>
			<Button
				variant={selectionMode ? 'secondary' : 'ghost'}
				size="sm"
				onclick={toggleSelectionMode}
				title={selectionMode ? 'Clear selection' : 'Select files'}
			>
				{#if selectionMode}
					<X class="size-4" /> Clear
				{:else}
					<ListChecks class="size-4" /> Select
				{/if}
			</Button>
			<!-- Split button: main click = device upload (the common path); the attached chevron opens
			     rare ingest sources (Item 37: Google Photos import) without a second standalone dot-menu. -->
			<div class="inline-flex">
				<Button
					size="sm"
					class="rounded-r-none"
					onclick={() => fileInput?.click()}
					title="Upload from device"
				>
					<Upload class="size-4" /> Upload
				</Button>
				<DropdownMenu.Root>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<Button
								{...props}
								size="sm"
								class="rounded-l-none border-l border-primary-foreground/20 px-2"
								title="More sources…"
							>
								<ChevronDown class="size-4" />
							</Button>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="end">
						<DropdownMenu.Item onSelect={() => (googlePhotosOpen = true)}>
							Import from Google Photos…
						</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu.Root>
			</div>
			<input bind:this={fileInput} type="file" multiple class="hidden" onchange={onUpload} />
		</header>

		{#if selectionMode}
			<div class="flex flex-wrap items-center gap-2 border-b bg-muted/40 p-2 text-sm">
				<span>{selectedIds.size} selected</span>
				<Select.Root type="single" value={bulkClassId} onValueChange={(v) => (bulkClassId = v)}>
					<Select.Trigger class="h-8 w-44">{bulkLabel}</Select.Trigger>
					<Select.Content>
						{#each classes as c (c.id)}
							<Select.Item value={c.id}>{c.displayName}</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
				<Button size="sm" disabled={!bulkClassId || selectedIds.size === 0} onclick={bulkAdd}>
					Add
				</Button>
				{#if soloClass}
					<Button
						variant="outline"
						size="sm"
						disabled={selectedIds.size === 0 || !catalogSchema}
						onclick={() => (setFieldOpen = true)}
					>
						Set field…
					</Button>
					<Button
						variant="outline"
						size="sm"
						disabled={selectedIds.size === 0}
						onclick={bulkRemove}
					>
						Remove from {classes.find((c) => c.id === soloClass)?.displayName}
					</Button>
				{/if}
				<Button
					variant="destructive"
					size="sm"
					disabled={selectedIds.size === 0}
					onclick={() => (deleteFilesOpen = true)}
				>
					Delete from disk
				</Button>
				<Button variant="ghost" size="sm" class="ml-auto text-xs" onclick={toggleSelectionMode}>
					clear
				</Button>
			</div>
		{/if}

		<div class="min-h-0 flex-1">
			{#if loading}
				<p class="p-4 text-muted-foreground">Loading…</p>
			{:else}
				<DataGrid
					items={gridItems}
					groups={groupedGridItems}
					config={gridConfig}
					callbacks={gridCallbacks}
				/>
			{/if}
		</div>
	</main>

	{#if editorFile}
		<FileEditorPanel
			file={editorFile}
			{classes}
			refresh={editorRefresh}
			index={editorIndex}
			total={files.length}
			onPrev={() => gotoFile(-1)}
			onNext={() => gotoFile(1)}
			onclose={() => (editorFileId = null)}
			onSaved={() => {
				// A field autosave: nothing structural changed, but the edited field may be the catalog
				// title-by / a verbose field (server-resolved), or a linked `record`-field that propagates
				// to the partner Records type. Debounced bump → this page's own quiet refetch + other tabs /
				// pickers, without disturbing the open editor or storming on rapid edits.
				scheduleReferenceRefresh();
			}}
			onStructureChanged={async () => {
				await loadMeta();
				await loadFiles();
				// A rename / metadata change here can alter a filename that a record renders via a
				// `file`-field. Nudge an open Records grid (a separate sub-app) to refresh quietly.
				triggerImageListRefresh();
			}}
		/>
	{/if}
</div>

<!-- Unified class settings dialog (rename + title-by + group-by + schema + delete) -->
{#if manageClassId}
	{#key manageClassId}
		<EntitySettingsDialog
			adapter={classSettingsAdapter(manageClassId)}
			name={manageClassName}
			bind:open={settingsOpen}
			onchanged={afterClassChange}
			ondeleted={async () => {
				selectedClasses.delete(manageClassId);
				settingsOpen = false;
				await loadMeta();
				await loadFiles();
			}}
		/>
	{/key}
{/if}

<BulkSetFieldDialog
	bind:open={setFieldOpen}
	schema={catalogSchema}
	selectedCount={selectedIds.size}
	apply={bulkSetField}
/>

<AlertDialog.Root bind:open={deleteFilesOpen}>
	<AlertDialog.Content>
		<AlertDialog.Title>Delete files from disk</AlertDialog.Title>
		<AlertDialog.Description>
			Permanently delete {selectedIds.size} file{selectedIds.size === 1 ? '' : 's'} from disk and remove
			them from every class. This cannot be undone.
		</AlertDialog.Description>
		<div class="mt-4 flex justify-end gap-2">
			<AlertDialog.Cancel type="button">Cancel</AlertDialog.Cancel>
			<Button variant="destructive" type="button" onclick={bulkDelete}>Delete</Button>
		</div>
	</AlertDialog.Content>
</AlertDialog.Root>

<AlertDialog.Root bind:open={deleteClassOpen}>
	<AlertDialog.Content>
		<AlertDialog.Title>Delete class</AlertDialog.Title>
		<AlertDialog.Description>
			Delete the class “{deleteClassName}”? Its schema and per-file metadata are removed. The
			underlying files are not deleted. This cannot be undone.
		</AlertDialog.Description>
		<div class="mt-4 flex justify-end gap-2">
			<AlertDialog.Cancel type="button">Cancel</AlertDialog.Cancel>
			<Button variant="destructive" type="button" onclick={doDeleteClass}>Delete class</Button>
		</div>
	</AlertDialog.Content>
</AlertDialog.Root>

<GooglePhotosDialog
	bind:open={googlePhotosOpen}
	onImported={async (count) => {
		toast.success(`Imported ${count} photo${count === 1 ? '' : 's'} from Google Photos`);
		await loadMeta();
		await loadFiles();
	}}
/>
