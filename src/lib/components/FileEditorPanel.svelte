<script module lang="ts">
	import type { SchemaDefinition } from '$lib/core/types.js';

	/**
	 * What an autosave hands back to the host, so it can patch the edited grid row **in place** instead
	 * of refetching the list. A refetch is what used to make the host reassign `files`, which changed
	 * this component's `file` prop identity, which re-ran the reload effect and unmounted every input
	 * out from under the caret.
	 */
	export type SavedSections = {
		/** The blob the records belong to — NOT necessarily the open one (see `flushLeavingSync`). */
		fileId: string;
		sections: { classId: string; schema: SchemaDefinition; record: Record<string, unknown> }[];
	};
</script>

<script lang="ts">
	import { dirtyFieldPatch } from '$lib/core/dirtyPatch.js';
	import {
		apiBlobUrl,
		apiGetFileClasses,
		apiUpdateClassRecord,
		apiRenameFile,
		apiAddMembers,
		apiRemoveMembers,
		apiCheckFileExtension,
		apiGetClassFieldValues,
		type ExtensionCheck
	} from '$lib/api/files.js';
	import { hasAllowedImageExtension, isPdfFilename } from '$lib/core/images.js';
	import {
		apiGetFileCompression,
		formatBytes,
		humanizeRecipe,
		mayHaveDerivatives,
		ssimLabel,
		type FileCompressionDetail,
		type FilePresetCompression
	} from '$lib/api/compression.js';
	import { formatTimestamp } from '$lib/core/datetime.js';
	import { untrack } from 'svelte';
	import FieldInput from './FieldInput.svelte';
	import MetadataButton from './MetadataButton.svelte';
	import EditorPanelShell from './EditorPanelShell.svelte';
	import { createAutosave } from '$lib/actions/autosave.svelte.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { FileText, Loader2, Check, ChevronDown, ChevronRight } from 'lucide-svelte';
	import type { ClassSummary, FileItem, ClassConfig } from '$lib/core/types.js';

	/** One editable class section: schema/config plus the blob's (always-present) record. */
	type Section = {
		id: string;
		displayName: string;
		schema: SchemaDefinition;
		config: ClassConfig;
		record: Record<string, unknown>;
	};

	/**
	 * Per-file editor: one collapsible section per class the blob belongs to, each rendering that
	 * class's schema. Plus rename, intrinsic info, and add/remove-to-class. Edits **autosave** (debounced,
	 * mirroring the Records detail pane) — flushed on field blur/Enter, prev/next, file switch, close,
	 * and unload, with a "Saving…/Saved" status in the header. No explicit per-section Save button.
	 *
	 * Two distinct host callbacks keep autosave from flashing/clobbering the grid: `onSaved` (a field
	 * autosave — the host patches the one edited row from the payload and must NOT refetch the file
	 * list) vs `onStructureChanged` (rename / add / remove-to-class / metadata strip — the tile label,
	 * chips, or counts changed, so the host reloads). Refetching on every keystroke used to reassign the
	 * `file` prop, which re-ran the reload effect and unmounted the inputs mid-sentence.
	 */
	let {
		file,
		classes,
		refresh = 0,
		index = -1,
		total = 0,
		onPrev,
		onNext,
		onclose,
		onSaved,
		onStructureChanged
	}: {
		file: FileItem;
		classes: ClassSummary[];
		/** Bump from the parent to force a section reload (e.g. after a class schema change). */
		refresh?: number;
		/** Position of this file in the current filtered grid order (for prev/next). */
		index?: number;
		/** Total files in the current filtered grid order. */
		total?: number;
		onPrev?: () => void;
		onNext?: () => void;
		onclose: () => void;
		/**
		 * A field autosave settled. The host should patch the named row from `saved` (no refetch — a
		 * refetch here reassigns the row objects and remounts this panel's inputs mid-typing).
		 */
		onSaved?: (saved: SavedSections) => void;
		/** Membership/name/metadata changed — the host should refresh the grid + class meta. */
		onStructureChanged: () => void;
	} = $props();

	let sections = $state<Section[]>([]);
	let loading = $state(true);
	// Split rename (Item 12): the filename is edited as a base name + a separate extension so an
	// extension fix is one interaction. Both are seeded from `file.file_name` on every file change.
	let baseName = $state('');
	let ext = $state('');
	let renameError = $state<string | null>(null);
	let renaming = $state(false);
	/** Name-extension-vs-sniffed-type check for the open file (drives the one-tap "Fix" hint). */
	let extCheck = $state<ExtensionCheck | null>(null);
	const extMismatch = $derived(extCheck?.mismatch === true && extCheck.detectedExtension != null);
	let addClassId = $state('');
	/** When true, the image preview is shown full-screen over the whole app (click/Esc to close). */
	let lightboxOpen = $state(false);
	/** Per-section serialized snapshot at last save/load, to detect unsaved edits. */
	let savedSnapshots = $state<Record<string, string>>({});

	// --- Compression (Item 15 phase 2) — read-only reporting, deliberately outside the autosave loop.
	/** This blob's per-preset compression detail; `null` until loaded (or when never fetched). */
	let compression = $state<FileCompressionDetail | null>(null);
	let compressionLoading = $state(false);
	/** The section is collapsible; its header keeps the one-line summary visible when collapsed. */
	let compressionOpen = $state(true);

	/**
	 * The open blob's identity, pulled out as plain strings.
	 *
	 * Load-bearing: a `$derived` re-runs its dependents only when its **value** changes, whereas reading
	 * `file.id` inside an effect subscribes to the whole `file` prop — and the host hands down a fresh
	 * `FileItem` object every time it refetches the list, even for the same unchanged blob. Keying the
	 * reload effect on these strings is what stops a background refresh from tearing down the inputs
	 * while someone is typing in them.
	 */
	const fileId = $derived(file.id);
	const fileName = $derived(file.file_name);
	/** The blob `sections` currently describe — `null` until the first load settles. */
	let loadedFor: string | null = null;
	/** Monotonic load counter; a response whose ticket is stale is dropped instead of applied. */
	let loadSeq = 0;
	// Nonreactive coordination only: pending writes must not trigger load effects.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const pendingWrites = new Map<string, Promise<void>>();
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const pendingFields = new Map<string, string[]>();

	const memberClassIds = $derived(new Set(sections.map((s) => s.id)));
	const addable = $derived(classes.filter((c) => !memberClassIds.has(c.id)));
	const isImage = $derived(hasAllowedImageExtension(file.file_name));
	const isPdfFile = $derived(isPdfFilename(file.file_name));
	const addLabel = $derived(
		addable.find((c) => c.id === addClassId)?.displayName ?? 'Add to class…'
	);

	/** The patch a section would save (its schema keys), used both for saving and dirty detection. */
	function patchFor(section: Section): Record<string, unknown> {
		const patch: Record<string, unknown> = {};
		for (const key of Object.keys(section.schema)) patch[key] = section.record[key] ?? null;
		return patch;
	}
	const snapshotOf = (section: Section) => JSON.stringify(patchFor(section));
	/** Any section with edits not yet persisted. */
	const dirty = $derived(sections.some((s) => snapshotOf(s) !== savedSnapshots[s.id]));

	// Shared autosave: `saveDirtySections` runs on field blur / discrete change / Enter / prev-next /
	// close (`autosave.commit`), with a slow 3s idle safety net. `onSaved` (not a list refetch) keeps
	// the grid stable so typing never stutters.
	const autosave = createAutosave({ isDirty: () => dirty, save: saveDirtySections });

	/**
	 * (Re)fetch this blob's class sections.
	 *
	 * Two rules keep a reload from disturbing someone mid-sentence:
	 * - **The loading skeleton is only for a different blob.** Reloading the *same* blob (a schema
	 *   change, an add/remove-to-class) leaves the fields mounted, because `{#if loading}` swaps the
	 *   whole form out and a swapped-out `<textarea>` loses focus — the user has to click back in.
	 * - **Unsaved edits win.** A section still dirty when the response lands keeps its in-memory record;
	 *   the server copy would be older than what's on screen, so applying it would eat keystrokes.
	 *
	 * @param fid - The blob to load. Passed explicitly (never read off `file` inside an effect) so the
	 *   caller controls the reactive dependency, and so a response can be matched to its request.
	 */
	async function load(fid: string) {
		const sameBlob = loadedFor === fid;
		if (!sameBlob) {
			sections = [];
			loading = true;
		}
		const seq = ++loadSeq;
		try {
			await pendingWrites.get(fid)?.catch(() => {});
			if (seq !== loadSeq) return;
			const data = await apiGetFileClasses(fid);
			// A newer load (or a file switch) started while this one was in flight — drop the response.
			if (seq !== loadSeq) return;
			const previous = new Map(sections.map((sec) => [sec.id, sec]));
			const dirtyIds = new Set(
				sameBlob
					? sections
							.filter((sec) => snapshotOf(sec) !== savedSnapshots[sec.id])
							.map((sec) => sec.id)
					: []
			);
			sections = data.classes.map((c) => {
				const prev = dirtyIds.has(c.id) ? previous.get(c.id) : undefined;
				// Take the fresh schema/config either way; keep the unsaved record when there is one.
				return {
					...c,
					record: prev ? prev.record : ((c.record ?? { id: fid }) as Record<string, unknown>)
				};
			});
			savedSnapshots = Object.fromEntries(
				sections.map((sec) => [
					sec.id,
					dirtyIds.has(sec.id) ? (savedSnapshots[sec.id] ?? '') : snapshotOf(sec)
				])
			);
			loadedFor = fid;
		} finally {
			if (seq === loadSeq) loading = false;
		}
		// Membership decides which presets this blob is subscribed to, so the compression detail is
		// reloaded alongside the sections (open, refresh, add/remove-to-class) rather than once per file.
		void loadCompression(fid);
	}

	/**
	 * Fetch this blob's per-preset compression detail, unless its type could never have a derivative.
	 *
	 * @param fid - The blob id being loaded, captured so a fast file switch can't land a stale response
	 *   on the newly-opened file.
	 */
	async function loadCompression(fid: string) {
		if (!mayHaveDerivatives(fileName)) {
			compression = null;
			return;
		}
		compressionLoading = true;
		try {
			const detail = await apiGetFileCompression(fid);
			if (fileId === fid) compression = detail;
		} catch (e) {
			console.error(e);
			if (fileId === fid) compression = null;
		} finally {
			if (fileId === fid) compressionLoading = false;
		}
	}

	/** True when we know, without asking, that this file type is never compressed (a PDF, a zip…). */
	const compressionUnsupported = $derived(
		!mayHaveDerivatives(file.file_name) || compression?.compressible === false
	);

	/**
	 * The headline for the section: the single largest saving actually achieved, named so it can't be
	 * read as a total across presets (you only ever serve one derivative per request). The quality
	 * adjective is appended **only** when there is a score to support it, and is qualified with the
	 * width when the preset resizes — `imperceptible at 400px` is a claim about a 400px rendering, not
	 * a comparison against the original's dimensions.
	 */
	const compressionSummary = $derived.by(() => {
		const rows = (compression?.presets ?? []).filter((p) => p.generated && p.savedBytes != null);
		if (rows.length === 0) return null;
		const best = rows.reduce((a, b) => ((b.savedBytes ?? 0) > (a.savedBytes ?? 0) ? b : a));
		const adjective = ssimLabel(best.ssim);
		const qualified =
			adjective && best.resized && best.width ? `${adjective} at ${best.width}px` : adjective;
		return `Saving ${formatBytes(best.savedBytes ?? 0)} on “${best.label}”${
			qualified ? ` · ${qualified}` : ''
		}`;
	});

	/** Plain-language reason a preset produced nothing for this blob. */
	function skipReason(row: FilePresetCompression): string {
		if (row.skipped === 'unsupported') return 'Not a compressible image type.';
		if (row.skipped === 'larger') return 'Compressing made it bigger, so the original is used.';
		if (row.skipped === 'error') return "Couldn't be read.";
		return '';
	}

	/** `1.9 MB → 412 KB (−79%)` for a generated row; `''` when the sizes aren't both known. */
	function sizeChange(row: FilePresetCompression): string {
		if (row.originalSize == null || row.size == null) return '';
		// Never round a surviving file up to a flat −100%: a 1.3 MB → 4.8 KB derivative is −99.6%, and
		// printing "−100%" claims the bytes vanished entirely. Cap at 99 whenever something is left.
		const raw = row.originalSize > 0 ? (1 - row.size / row.originalSize) * 100 : 0;
		const rounded = Math.round(raw);
		const pct = rounded >= 100 && row.size > 0 ? 99 : rounded;
		return `${formatBytes(row.originalSize)} → ${formatBytes(row.size)} (${pct >= 0 ? '−' : '+'}${Math.abs(pct)}%)`;
	}

	/** Promise tail serializing snapshots so outgoing writes cannot land out of order. */
	let writeTail: Promise<unknown> = Promise.resolve();
	/**
	 * Capture dirty sections before any await, then serialize their writes. Baselines describe the
	 * submitted snapshot, never newer keystrokes; late responses cannot modify another file's state.
	 *
	 * @param fid - The outgoing blob id, captured independently of the currently selected file.
	 * Concerns / future improvements: pending writes are in-memory and remain best effort on unload.
	 */
	function persistSections(fid: string) {
		const seq = loadSeq;
		// Clone before awaiting: nested list/url values and the live sections can change mid-save.
		const pending = sections
			.map((section) => {
				const key = `${fid}/${section.id}`;
				const patch = dirtyFieldPatch(
					patchFor(section),
					JSON.parse(savedSnapshots[section.id] || '{}'),
					pendingFields.get(key)
				);
				if (Object.keys(patch).length) pendingFields.set(key, Object.keys(patch));
				return { id: section.id, schema: section.schema, patch };
			})
			.filter((section) => Object.keys(section.patch).length);
		if (!pending.length) return Promise.resolve();
		const write = writeTail
			.catch(() => {})
			.then(async () => {
				const saved: SavedSections['sections'] = [];
				for (const s of pending) {
					const updated = await apiUpdateClassRecord(s.id, fid, s.patch);
					if (seq === loadSeq && loadedFor === fid) {
						savedSnapshots[s.id] = JSON.stringify({
							...JSON.parse(savedSnapshots[s.id] || '{}'),
							...s.patch
						});
					}
					saved.push({ classId: s.id, schema: s.schema, record: updated });
				}
				onSaved?.({ fileId: fid, sections: saved });
			});
		writeTail = write;
		pendingWrites.set(fid, write);
		void write
			.finally(() => {
				if (pendingWrites.get(fid) === write) {
					pendingWrites.delete(fid);
					for (const section of pending) pendingFields.delete(`${fid}/${section.id}`);
				}
			})
			.catch(() => {});
		return write;
	}

	/** Autosave entry point; propagates persistence failures to the shared status/toast handler. */
	async function saveDirtySections() {
		await persistSections(fileId);
	}

	/** Queue the outgoing file's latest edits even when an earlier save is still running. */
	function flushLeavingSync(fid: string) {
		autosave.cancel();
		void persistSections(fid).catch((e) => console.error('Autosave on leave failed', e));
	}

	/** Flush pending edits, then run a prev/next navigation. */
	async function advance(go: (() => void) | undefined) {
		if (!go) return;
		if (await autosave.commit()) go();
	}

	async function handleClose() {
		if (await autosave.commit()) onclose();
	}

	/**
	 * Split a filename into its base and extension (incl. the dot). A name with no dot, or a dotfile
	 * like `.gitignore`, has an empty extension and keeps the whole name as the base.
	 */
	function splitFilename(name: string): { base: string; ext: string } {
		const dot = name.lastIndexOf('.');
		if (dot <= 0) return { base: name, ext: '' };
		return { base: name.slice(0, dot), ext: name.slice(dot) };
	}

	// Seed the split rename boxes from the current filename. Keyed on the NAME (a string), so an
	// external rename refreshes them while an unrelated list refetch — same name, new object — does not
	// wipe out a half-typed rename.
	$effect(() => {
		const parts = splitFilename(fileName);
		baseName = parts.base;
		ext = parts.ext;
		renameError = null;
	});

	// Reload whenever a DIFFERENT blob is selected; flush the outgoing blob's edits first. Keyed on
	// `fileId` (a string), never on the `file` object — see the note on `fileId`.
	$effect(() => {
		const fid = fileId;
		extCheck = null;
		// Drop the previous blob's figures immediately — a stale saving next to a new photo is worse
		// than a blank line while the fetch lands.
		compression = null;
		void apiCheckFileExtension(fid)
			.then((c) => {
				if (fileId === fid) extCheck = c;
			})
			.catch(() => {});
		lightboxOpen = false;
		void load(fid);
		return () => flushLeavingSync(fid);
	});

	// Best-effort flush if the tab is closed mid-edit.
	$effect(() => {
		const handler = () => flushLeavingSync(untrack(() => fileId));
		window.addEventListener('beforeunload', handler);
		return () => window.removeEventListener('beforeunload', handler);
	});

	$effect(() => {
		// Close the full-screen preview on Escape.
		if (!lightboxOpen) return;
		function onKey(e: KeyboardEvent) {
			if (e.key === 'Escape') lightboxOpen = false;
		}
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});

	$effect(() => {
		// Reload sections on external request (e.g. a class schema changed while open). `untrack` keeps
		// this effect's only dependency `refresh`, so it can't double-fire on a file switch.
		if (refresh) void load(untrack(() => fileId));
	});

	/** Whether a `file`- or `record`-field key is a broken reference on this section's record. */
	function isMissing(section: Section, key: string): boolean {
		const mf = section.record._missing_files as Record<string, string> | undefined;
		const mr = section.record._missing_records as Record<string, string> | undefined;
		return (!!mf && key in mf) || (!!mr && key in mr);
	}

	/** Recombine the base + extension fields into a safe filename (normalises a leading dot). */
	function composeName(): string {
		const b = baseName.trim();
		const e = ext.trim();
		const normExt = e ? (e.startsWith('.') ? e : `.${e}`) : '';
		return b + normExt;
	}

	/**
	 * Commit the split rename (Item 12). Fires on blur/Enter — not per keystroke — since a filename is
	 * all-or-nothing. No-ops when unchanged or the base is empty; surfaces a duplicate-name (409)
	 * inline and reverts the fields.
	 */
	async function commitRename() {
		renameError = null;
		const next = composeName();
		if (!baseName.trim() || next === file.file_name) {
			// Re-seed from the canonical name so a blank/abandoned edit snaps back.
			const parts = splitFilename(file.file_name);
			baseName = parts.base;
			ext = parts.ext;
			return;
		}
		renaming = true;
		try {
			await apiRenameFile(file.id, next);
			onStructureChanged();
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'Rename failed';
			renameError =
				msg.includes('409') || msg.includes('already exists')
					? 'A file with that name already exists'
					: msg;
			const parts = splitFilename(file.file_name);
			baseName = parts.base;
			ext = parts.ext;
		} finally {
			renaming = false;
		}
	}

	/** One-tap fix: set the extension field to the sniffed type and commit immediately. */
	async function fixExtension() {
		if (!extCheck?.detectedExtension) return;
		ext = extCheck.detectedExtension;
		await commitRename();
	}

	async function addToClass() {
		if (!addClassId) return;
		await apiAddMembers(addClassId, [file.id]);
		addClassId = '';
		await load(file.id);
		onStructureChanged();
	}

	async function removeFromClass(classId: string) {
		await apiRemoveMembers(classId, [file.id]);
		await load(file.id);
		onStructureChanged();
	}
</script>

<EditorPanelShell
	{index}
	{total}
	onPrev={() => advance(onPrev)}
	onNext={() => advance(onNext)}
	onclose={handleClose}
	meta={file.created_at ? `Added ${formatTimestamp(file.created_at)}` : undefined}
>
	{#snippet titleArea()}
		<Input
			class="min-w-0 flex-1 text-sm font-medium"
			aria-label="File name"
			bind:value={baseName}
			disabled={renaming}
			onblur={commitRename}
			onkeydown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
		/>
		<Input
			class="w-16 shrink-0 text-center text-sm"
			aria-label="File extension"
			placeholder=".ext"
			bind:value={ext}
			disabled={renaming}
			onblur={commitRename}
			onkeydown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
		/>
		<span class="shrink-0 text-xs text-muted-foreground">
			{#if autosave.status === 'saving'}
				<Loader2 class="inline size-3 animate-spin" /> Saving…
			{:else if autosave.status === 'saved' && !dirty}
				<Check class="inline size-3 text-green-600" /> Saved
			{:else if autosave.status === 'error'}
				<span class="text-destructive">Save failed</span>
			{/if}
		</span>
	{/snippet}
	{#snippet actions()}
		<MetadataButton id={file.id} filename={file.file_name} onchanged={onStructureChanged} />
	{/snippet}

	{#if renameError}
		<p class="mb-2 text-xs text-destructive">{renameError}</p>
	{/if}
	{#if extMismatch}
		<div
			class="mb-3 flex items-center gap-2 rounded border border-amber-500/50 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-300"
		>
			<span class="min-w-0 flex-1 truncate">
				Detected <code class="rounded bg-amber-500/20 px-1">{extCheck?.detectedExtension}</code> — extension
				doesn't match content.
			</span>
			<Button
				variant="outline"
				size="sm"
				class="h-6 shrink-0 px-2 text-xs"
				disabled={renaming}
				onclick={fixExtension}
			>
				Fix to {extCheck?.detectedExtension}
			</Button>
		</div>
	{/if}

	{#if isImage}
		<button
			type="button"
			class="mb-3 block w-full cursor-zoom-in rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			title="Click to preview full screen"
			onclick={() => (lightboxOpen = true)}
		>
			<img
				src={apiBlobUrl(file.id)}
				alt={file.file_name}
				class="max-h-48 w-full rounded object-contain"
			/>
		</button>
	{:else}
		<div
			class="mb-3 flex flex-col items-center justify-center gap-2 rounded border border-dashed py-8 text-muted-foreground"
		>
			<FileText class="h-10 w-10" />
			{#if isPdfFile}
				<a
					href={apiBlobUrl(file.id)}
					target="_blank"
					rel="noopener noreferrer"
					class="text-sm text-primary hover:underline"
				>
					Open PDF in new tab
				</a>
			{/if}
		</div>
	{/if}

	<div class="mb-3 flex items-center gap-2">
		<Select.Root type="single" value={addClassId} onValueChange={(v) => (addClassId = v)}>
			<Select.Trigger class="flex-1">{addLabel}</Select.Trigger>
			<Select.Content>
				{#each addable as c (c.id)}
					<Select.Item value={c.id}>{c.displayName}</Select.Item>
				{/each}
			</Select.Content>
		</Select.Root>
		<Button size="sm" disabled={!addClassId} onclick={addToClass}>Add</Button>
	</div>

	{#if loading}
		<p class="text-sm text-muted-foreground">Loading…</p>
	{:else if sections.length === 0}
		<p class="text-sm text-muted-foreground">Not a member of any class yet. Add it to one above.</p>
	{:else}
		{#each sections as section (section.id)}
			<section class="mb-4 rounded border">
				<div class="flex items-center justify-between border-b bg-muted/50 px-2 py-1">
					<span class="flex min-w-0 items-baseline gap-2">
						<span class="truncate text-sm font-semibold">{section.displayName}</span>
						{#if section.record.last_modified}
							<span class="shrink-0 text-xs text-muted-foreground">
								Modified {formatTimestamp(section.record.last_modified as string)}
							</span>
						{/if}
					</span>
					<Button
						variant="link"
						size="sm"
						class="h-auto p-0 text-destructive"
						onclick={() => removeFromClass(section.id)}>remove</Button
					>
				</div>
				<div class="space-y-2 p-2">
					{#if Object.keys(section.schema).length === 0}
						<p class="text-xs text-muted-foreground">Pure tag (no fields).</p>
					{/if}
					{#each Object.entries(section.schema) as [key, def] (key)}
						<div class="space-y-0.5">
							<span class="mb-0.5 block text-xs font-medium text-muted-foreground">{key}</span>
							<FieldInput
								{def}
								bind:value={section.record[key]}
								missing={isMissing(section, key)}
								missingName={(
									section.record._missing_files as Record<string, string> | undefined
								)?.[key] ??
									(section.record._missing_records as Record<string, string> | undefined)?.[key]}
								outOfClass={!!(
									section.record._out_of_class as Record<string, string> | undefined
								)?.[key]}
								oncommit={() => autosave.commit()}
								loadSuggestions={() =>
									apiGetClassFieldValues(section.id, key).then((r) => r.values)}
							/>
						</div>
					{/each}
				</div>
			</section>
		{/each}
	{/if}

	<!--
		Compression (Item 15 phase 2) — read-only reporting. It deliberately has no Save button and never
		touches `autosave`: nothing here is an edit. What a blob gets is decided by the workspace and its
		classes; this section only says what came of that.
	-->
	<section class="mb-4 rounded border">
		<div class="flex items-center justify-between border-b bg-muted/50 px-2 py-1">
			<Button
				variant="ghost"
				size="sm"
				class="h-auto min-w-0 flex-1 justify-start gap-1.5 px-0 py-0 hover:bg-transparent"
				aria-expanded={compressionOpen}
				onclick={() => (compressionOpen = !compressionOpen)}
			>
				{#if compressionOpen}
					<ChevronDown class="size-3.5 shrink-0" />
				{:else}
					<ChevronRight class="size-3.5 shrink-0" />
				{/if}
				<span class="text-sm font-semibold">Compression</span>
				{#if compressionSummary}
					<span class="min-w-0 truncate text-xs font-normal text-muted-foreground">
						{compressionSummary}
					</span>
				{/if}
			</Button>
		</div>
		{#if compressionOpen}
			<div class="space-y-2 p-2">
				{#if compressionUnsupported}
					<p class="text-xs text-muted-foreground">This file type isn't compressed.</p>
				{:else if compressionLoading && !compression}
					<p class="text-xs text-muted-foreground">Loading…</p>
				{:else if !compression}
					<p class="text-xs text-muted-foreground">Compression details aren't available.</p>
				{:else if compression.presets.length === 0}
					<p class="text-xs text-muted-foreground">
						No preset applies to this file, so no compressed copy is made. Presets are chosen in
						<a href="/compression" class="text-primary hover:underline">Compression</a> and per class
						in that class's settings.
					</p>
				{:else}
					{#each compression.presets as row (row.presetId)}
						<div class="rounded border px-2 py-1.5">
							<div class="flex items-baseline justify-between gap-2">
								<span class="min-w-0 truncate text-xs font-medium">{row.label}</span>
								<span class="shrink-0 text-[11px] text-muted-foreground">
									{humanizeRecipe(row.recipe)}
								</span>
							</div>
							{#if row.skipped}
								<p class="mt-0.5 text-[11px] text-muted-foreground">{skipReason(row)}</p>
							{:else if row.generated}
								<p class="mt-0.5 text-[11px] tabular-nums text-muted-foreground">
									{sizeChange(row)}
									{#if row.savedBytes != null}
										· saves {formatBytes(row.savedBytes)}
									{/if}
								</p>
								{#if row.ssim != null}
									<p class="text-[11px] text-muted-foreground">
										SSIM {row.ssim.toFixed(3)}
										{#if ssimLabel(row.ssim)}({ssimLabel(row.ssim)}){/if}
										{#if row.resized && row.width}
											<span class="italic">
												— measured at {row.width}px wide: codec loss at that size, not the
												downscale.
											</span>
										{/if}
									</p>
								{/if}
								{#if row.stale}
									<p class="text-[11px] text-amber-600 dark:text-amber-400">
										The recipe changed — queued for regeneration.
									</p>
								{/if}
							{:else if row.stale}
								<p class="mt-0.5 text-[11px] text-amber-600 dark:text-amber-400">
									The recipe changed — queued for regeneration.
								</p>
							{:else}
								<p class="mt-0.5 text-[11px] text-muted-foreground">Waiting to be generated.</p>
							{/if}
						</div>
					{/each}
				{/if}
			</div>
		{/if}
	</section>
</EditorPanelShell>

{#if lightboxOpen && isImage}
	<!-- Full-screen preview over the whole app; click anywhere (or Esc) to close. -->
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/80 p-6"
		role="button"
		tabindex="-1"
		onclick={() => (lightboxOpen = false)}
	>
		<img
			src={apiBlobUrl(file.id)}
			alt={file.file_name}
			class="max-h-full max-w-full object-contain"
		/>
	</div>
{/if}
