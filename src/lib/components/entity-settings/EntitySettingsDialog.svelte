<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import { Separator } from '$lib/components/ui/separator/index.js';
	import SchemaEditorBody from '$lib/components/schema-editor/SchemaEditorBody.svelte';
	import IconPicker from '$lib/components/IconPicker.svelte';
	import { Check, Loader2 } from 'lucide-svelte';
	import { toast } from 'svelte-sonner';
	import { createAutosave } from '$lib/actions/autosave.svelte.js';
	import {
		apiGetCompressionSettings,
		presetLabel,
		presetRecipe,
		type CompressionPreset
	} from '$lib/api/compression.js';
	import type { IconId } from '$lib/core/icons.js';
	import type { EntitySettingsAdapter, EntityGeneralConfig } from './types.js';

	/**
	 * The single, shared **entity settings** popup used by both the Files class sidebar and the Records
	 * type rail. One tabbed dialog combining **rename** + **title-by** (+ **group-by** and the
	 * **compression subscription** for Files) on a General tab, the shared schema editor on a Fields tab,
	 * and **delete** on a Danger tab. All data access is injected via {@link EntitySettingsAdapter}; the
	 * dialog itself is side-agnostic — each optional section is gated on an adapter capability flag
	 * (`hasGroupBy` / `hasSubtitle` / `hasCompression`).
	 *
	 * Title is always `{name} — settings` with a scope subtitle so it can't be confused with the global
	 * **App settings** (footer gear). Reached from the row ⋮ menu and the content-header ⋮.
	 *
	 * @param adapter - Data layer (load/save general config, schema adapter, delete).
	 * @param name - Current display name (for the title; the General tab can rename it).
	 * @param open - Bindable dialog open state.
	 * @param onchanged - Called after an autosave / schema mutation (host refreshes names/counts/list).
	 *   The General tab has no Save button — edits persist on field blur / discrete change, on close, and
	 *   on a slow 3s idle safety net, mirroring the editor-panel autosave policy ({@link createAutosave}).
	 * @param ondeleted - Called after the entity is deleted (host clears selection + reloads).
	 */
	let {
		adapter,
		name,
		open = $bindable(false),
		onchanged,
		ondeleted
	}: {
		adapter: EntitySettingsAdapter;
		name: string;
		open?: boolean;
		onchanged?: () => void;
		ondeleted?: () => void;
	} = $props();

	type Tab = 'general' | 'fields' | 'danger';
	let tab = $state<Tab>('general');

	let loading = $state(false);
	let deleting = $state(false);
	let confirmDeleteOpen = $state(false);

	let displayName = $state('');
	let icon = $state('');
	let titleBy = $state('');
	let subtitleBy = $state('');
	let groupBy = $state('');
	let fields = $state<{ key: string; label: string }[]>([]);

	/** This entity's own compression subscription (Item 15 phase 2); classes only. */
	let compressionPresets = $state<string[]>([]);
	/** The workspace preset registry, for naming the checkboxes. Loaded only when `hasCompression`. */
	let allPresets = $state<CompressionPreset[]>([]);
	/** Preset ids applied to **every** image; shown checked + disabled so the union is legible. */
	let workspacePresets = $state<string[]>([]);
	/** The registry couldn't be read — say so rather than rendering a silently empty list. */
	let presetsFailed = $state(false);
	/**
	 * Set once a save actually changed the subscription, so the section can *state* (never ask) that
	 * derivatives are being generated/pruned in the background.
	 */
	let regenerating = $state(false);

	/** JSON snapshot of the last persisted General-tab values (the autosave baseline). */
	let savedSnapshot = $state('');

	/** Live JSON snapshot of the General-tab form (name trimmed so trailing space isn't "dirty"). */
	const snapshot = $derived(
		JSON.stringify({
			displayName: displayName.trim(),
			icon,
			titleBy,
			subtitleBy,
			groupBy,
			compressionPresets
		})
	);

	// Dirty only when loaded, the name is non-empty (we never autosave a blank name), and the snapshot
	// has drifted from the last save. This is the sole signal driving the debounced autosave.
	const isDirty = $derived(!loading && displayName.trim() !== '' && snapshot !== savedSnapshot);

	const autosave = createAutosave({
		isDirty: () => isDirty,
		save: saveGeneral,
		errorMessage: 'Failed to save settings'
	});

	const titleByLabel = $derived(
		titleBy ? (fields.find((f) => f.key === titleBy)?.label ?? titleBy) : 'Default'
	);
	const subtitleByLabel = $derived(
		subtitleBy ? (fields.find((f) => f.key === subtitleBy)?.label ?? subtitleBy) : 'None'
	);
	const groupByLabel = $derived(
		groupBy ? (fields.find((f) => f.key === groupBy)?.label ?? groupBy) : 'None'
	);

	/** Generic glyph for this entity kind when no icon is set (classes ⇒ tag, record types ⇒ doc). */
	const fallbackIcon: IconId = $derived(adapter.noun === 'class' ? 'tag' : 'file-text');

	/** A preset applied workspace-wide: this entity's members get it whatever this dialog says. */
	const isWorkspacePreset = (id: string) => workspacePresets.includes(id);

	/**
	 * Is this preset in the union for this entity's members? True for its own subscription **and** for
	 * anything the workspace already applies — the point of the list is that the union is visible, not
	 * that this entity's slice of it is.
	 */
	const isSubscribed = (id: string) => isWorkspacePreset(id) || compressionPresets.includes(id);

	async function load() {
		loading = true;
		presetsFailed = false;
		regenerating = false;
		try {
			// Both reads are independent, so a class's settings dialog opens in one round trip's time.
			const [cfg] = await Promise.all([adapter.load(), loadPresetRegistry()]);
			const general: EntityGeneralConfig = cfg;
			displayName = general.displayName;
			icon = general.icon;
			titleBy = general.titleBy;
			subtitleBy = general.subtitleBy;
			groupBy = general.groupBy;
			compressionPresets = general.compressionPresets;
			fields = general.fields;
			savedSnapshot = snapshot;
		} catch (e) {
			console.error(e);
			toast.error(`Failed to load ${adapter.noun} settings`);
		} finally {
			loading = false;
		}
	}

	/**
	 * Read the workspace preset registry so the subscription checkboxes can be *named* (label + recipe)
	 * and the workspace-wide ones can be shown as already-applied. A failure here is reported inline
	 * instead of failing the whole dialog — everything else on the General tab still works.
	 */
	async function loadPresetRegistry() {
		if (!adapter.hasCompression) {
			allPresets = [];
			workspacePresets = [];
			return;
		}
		try {
			const settings = await apiGetCompressionSettings();
			allPresets = settings.presets;
			workspacePresets = settings.workspacePresets;
		} catch (e) {
			console.error(e);
			allPresets = [];
			workspacePresets = [];
			presetsFailed = true;
		}
	}

	/**
	 * Add/remove a preset from **this entity's** subscription and commit immediately (a checkbox is a
	 * discrete change, per the shared autosave policy). Workspace-wide presets are inert here: they are
	 * a workspace-level decision, unchecked only in the Presets dialog.
	 *
	 * @param id - The preset id being toggled.
	 * @param on - The checkbox's new state.
	 */
	function toggleCompressionPreset(id: string, on: boolean) {
		if (isWorkspacePreset(id)) return;
		compressionPresets = on
			? [...new Set([...compressionPresets, id])]
			: compressionPresets.filter((p) => p !== id);
		void autosave.commit();
	}

	// (Re)load whenever the dialog opens (reset to the General tab); flush any pending edit on close so
	// nothing is lost if the user closes before the safety net fires.
	$effect(() => {
		if (open) {
			tab = 'general';
			load();
		} else {
			void autosave.commit();
		}
	});

	/**
	 * Persist the General tab if dirty. Advances the saved baseline and notifies the host. Throws on
	 * failure — {@link createAutosave} owns the status/saving/toast bookkeeping. No-ops on a blank name
	 * (we never autosave one) or when nothing changed.
	 */
	async function saveGeneral() {
		const trimmed = displayName.trim();
		if (loading || !trimmed || snapshot === savedSnapshot) return;
		const committed = snapshot;
		const previousPresets = subscriptionOf(savedSnapshot);
		await adapter.save({
			displayName: trimmed,
			icon,
			titleBy,
			subtitleBy,
			groupBy,
			compressionPresets
		});
		savedSnapshot = committed;
		// Only claim a background run when the subscription is what actually changed — a rename must not
		// print "generating derivatives".
		if (adapter.hasCompression && previousPresets !== JSON.stringify(compressionPresets))
			regenerating = true;
		onchanged?.();
	}

	/**
	 * The `compressionPresets` slice of a saved snapshot, as a comparable string. Returns `null` for an
	 * unreadable snapshot so a parse failure reads as "unknown" rather than as "was empty".
	 *
	 * @param snap - A JSON snapshot previously produced by {@link snapshot}.
	 */
	function subscriptionOf(snap: string): string | null {
		try {
			return JSON.stringify(
				(JSON.parse(snap) as { compressionPresets?: string[] }).compressionPresets ?? []
			);
		} catch {
			return null;
		}
	}

	async function doDelete() {
		deleting = true;
		try {
			await adapter.remove();
			// Drop any pending autosave and mark clean so closing doesn't flush a write to the deleted entity.
			autosave.cancel();
			savedSnapshot = snapshot;
			toast.success(`Deleted ${adapter.noun} “${name}”`);
			confirmDeleteOpen = false;
			open = false;
			ondeleted?.();
		} catch (e) {
			console.error(e);
			toast.error(`Failed to delete ${adapter.noun}`);
		} finally {
			deleting = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="flex max-h-[90vh] max-w-2xl flex-col">
		<Dialog.Title>{name} — settings</Dialog.Title>
		<Dialog.Description>
			Settings for this {adapter.noun} — global preferences live in <strong>App settings</strong>.
		</Dialog.Description>

		<!-- Tab strip (no shadcn `tabs` primitive in this project; Buttons are the navigation control). -->
		<div class="flex gap-1 border-b">
			<Button
				variant="ghost"
				size="sm"
				class="rounded-none border-b-2 {tab === 'general'
					? 'border-primary'
					: 'border-transparent text-muted-foreground'}"
				onclick={() => (tab = 'general')}
			>
				General
			</Button>
			<Button
				variant="ghost"
				size="sm"
				class="rounded-none border-b-2 {tab === 'fields'
					? 'border-primary'
					: 'border-transparent text-muted-foreground'}"
				onclick={() => (tab = 'fields')}
			>
				Fields
			</Button>
			<Button
				variant="ghost"
				size="sm"
				class="rounded-none border-b-2 {tab === 'danger'
					? 'border-primary'
					: 'border-transparent text-muted-foreground'}"
				onclick={() => (tab = 'danger')}
			>
				Danger
			</Button>
		</div>

		<div class="min-h-0 flex-1 overflow-y-auto py-2">
			{#if loading}
				<p class="py-4 italic text-muted-foreground">Loading…</p>
			{:else if tab === 'general'}
				<div class="flex flex-col gap-4 py-2">
					<div class="flex items-end gap-3">
						<div class="flex flex-col gap-2">
							<Label>Icon</Label>
							<IconPicker
								value={icon}
								fallback={fallbackIcon}
								onSelect={(id) => {
									icon = id ?? '';
									void autosave.commit();
								}}
								label="Choose {adapter.noun} icon"
							/>
						</div>
						<div class="flex flex-1 flex-col gap-2">
							<Label for="entity-display-name">Display name</Label>
							<Input
								id="entity-display-name"
								bind:value={displayName}
								placeholder="Name"
								onblur={() => autosave.commit()}
								onkeydown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
							/>
						</div>
					</div>

					<div class="flex flex-col gap-2">
						<Label>Title rows by</Label>
						<Select.Root
							type="single"
							value={titleBy}
							onValueChange={(v) => {
								titleBy = v ?? '';
								void autosave.commit();
							}}
						>
							<Select.Trigger>{titleByLabel}</Select.Trigger>
							<Select.Content>
								<Select.Item value="">Default</Select.Item>
								{#each fields as f (f.key)}
									<Select.Item value={f.key}>{f.label}</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
						<p class="text-xs text-muted-foreground">
							Which field labels each row in the list. Persisted.
						</p>
					</div>

					{#if adapter.hasSubtitle}
						<div class="flex flex-col gap-2">
							<Label>Subtitle (optional)</Label>
							<Select.Root
								type="single"
								value={subtitleBy}
								onValueChange={(v) => {
									subtitleBy = v ?? '';
									void autosave.commit();
								}}
							>
								<Select.Trigger>{subtitleByLabel}</Select.Trigger>
								<Select.Content>
									<Select.Item value="">None</Select.Item>
									{#each fields as f (f.key)}
										<Select.Item value={f.key}>{f.label}</Select.Item>
									{/each}
								</Select.Content>
							</Select.Root>
							<p class="text-xs text-muted-foreground">
								A muted secondary line under each row. Choose “None” to hide it.
							</p>
						</div>
					{/if}

					{#if adapter.hasGroupBy}
						<div class="flex flex-col gap-2">
							<Label>Group by</Label>
							<Select.Root
								type="single"
								value={groupBy}
								onValueChange={(v) => {
									groupBy = v ?? '';
									void autosave.commit();
								}}
							>
								<Select.Trigger>{groupByLabel}</Select.Trigger>
								<Select.Content>
									<Select.Item value="">None</Select.Item>
									{#each fields as f (f.key)}
										<Select.Item value={f.key}>{f.label}</Select.Item>
									{/each}
								</Select.Content>
							</Select.Root>
						</div>
					{/if}

					{#if adapter.hasCompression}
						<Separator />
						<div class="flex flex-col gap-2">
							<Label>Compression</Label>
							{#if presetsFailed}
								<p class="text-sm text-muted-foreground">
									Couldn't read the compression presets. Open
									<a href="/compression" class="text-primary hover:underline">Compression</a> to check.
								</p>
							{:else if allPresets.length === 0}
								<p class="text-sm text-muted-foreground">
									No compression presets exist yet, so there is nothing for this {adapter.noun} to subscribe
									to. Create one in
									<a href="/compression" class="text-primary hover:underline">Compression</a>.
								</p>
							{:else}
								<p class="text-xs text-muted-foreground">
									Members of this {adapter.noun} get these on top of the workspace default. A file in
									several classes gets every preset any of them asks for — nothing competes.
								</p>
								<div class="flex flex-col gap-1 rounded-md border p-2">
									{#each allPresets as preset (preset.id)}
										{@const workspaceWide = isWorkspacePreset(preset.id)}
										<div class="flex items-center gap-2 rounded px-1 py-1 hover:bg-muted/50">
											<Checkbox
												id="compression-sub-{preset.id}"
												checked={isSubscribed(preset.id)}
												disabled={workspaceWide}
												onCheckedChange={(v) => toggleCompressionPreset(preset.id, v === true)}
											/>
											<Label
												for="compression-sub-{preset.id}"
												class="flex min-w-0 flex-1 items-baseline gap-2 text-sm font-normal"
											>
												<span class="truncate">{presetLabel(preset)}</span>
												<span class="shrink-0 text-xs text-muted-foreground">
													{presetRecipe(preset)}
												</span>
											</Label>
											{#if workspaceWide}
												<span class="shrink-0 text-xs text-muted-foreground">
													applied to everything
												</span>
											{/if}
										</div>
									{/each}
								</div>
								{#if regenerating}
									<p class="text-xs text-muted-foreground">
										Saved. Derivatives for this {adapter.noun}'s files are being generated and
										pruned in the background — your originals aren't touched.
									</p>
								{/if}
							{/if}
						</div>
					{/if}

					<div class="flex h-4 justify-end text-xs text-muted-foreground">
						{#if autosave.status === 'saving'}
							<span><Loader2 class="inline size-3 animate-spin" /> Saving…</span>
						{:else if autosave.status === 'saved' && !isDirty}
							<span><Check class="inline size-3 text-green-600" /> Saved</span>
						{:else if autosave.status === 'error'}
							<span class="text-destructive">Save failed</span>
						{/if}
					</div>
				</div>
			{:else if tab === 'fields'}
				{#key open}
					<SchemaEditorBody
						adapter={adapter.schema}
						recordNoun={adapter.recordNoun}
						onchanged={() => onchanged?.()}
					/>
				{/key}
			{:else}
				<div class="flex flex-col gap-3 py-2">
					<div
						class="flex items-center justify-between rounded-md border border-destructive/40 bg-destructive/5 p-3"
					>
						<span class="text-sm text-muted-foreground">
							Delete this {adapter.noun} and everything it stores. This cannot be undone.
						</span>
						<Button variant="destructive" size="sm" onclick={() => (confirmDeleteOpen = true)}>
							Delete…
						</Button>
					</div>
				</div>
			{/if}
		</div>
	</Dialog.Content>
</Dialog.Root>

<AlertDialog.Root bind:open={confirmDeleteOpen}>
	<AlertDialog.Content>
		<AlertDialog.Title>Delete {adapter.noun}</AlertDialog.Title>
		<AlertDialog.Description>
			Delete the {adapter.noun} “{name}”? This cannot be undone.
		</AlertDialog.Description>
		<div class="mt-4 flex justify-end gap-2">
			<AlertDialog.Cancel type="button">Cancel</AlertDialog.Cancel>
			<Button variant="destructive" type="button" disabled={deleting} onclick={doDelete}>
				Delete {adapter.noun}
			</Button>
		</div>
	</AlertDialog.Content>
</AlertDialog.Root>
