<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import { Separator } from '$lib/components/ui/separator/index.js';
	import { Loader2, Plus, Trash2, TriangleAlert } from 'lucide-svelte';
	import { toast } from 'svelte-sonner';
	import {
		apiSaveCompressionSettings,
		presetLabel,
		MAX_QUALITY,
		MIN_QUALITY,
		PRESET_ID_PATTERN,
		type CompressionFormat,
		type CompressionPreset,
		type CompressionSettings
	} from '$lib/api/compression.js';

	/**
	 * The **compression presets** editor — the one place a workspace's recipes are defined.
	 *
	 * The load-bearing idea of Item 15 is that *quality belongs to the recipe, not the photo*: a preset
	 * is the unit and things subscribe to it. Phase 1 ships exactly one subscription — the workspace
	 * one ("applied to every image") — so this dialog edits the registry plus that single checkbox
	 * column. Per-class subscription and the `width` ladder are phase 2; `width` is rendered but
	 * **disabled**, so the field's existence is visible without being offered.
	 *
	 * Unlike the entity editors this dialog is **not** autosaved: preset edits mark derivatives stale
	 * and cost real encode work, so they are batched behind an explicit Save. Saving is still never a
	 * *prompt* — the server regenerates on its own and the dialog reports that as a fact afterwards
	 * (originals are never at risk, so there is nothing to confirm).
	 *
	 * @param open - Bindable dialog open state.
	 * @param settings - The currently persisted settings; cloned into local form state on each open.
	 * @param onsaved - Called with the server's authoritative settings after a successful save, plus
	 *   whether the change kicked a regeneration run (so the host can refresh its report + progress).
	 */
	let {
		open = $bindable(false),
		settings,
		onsaved
	}: {
		open?: boolean;
		settings: CompressionSettings;
		onsaved?: (settings: CompressionSettings, regenerating: boolean) => void;
	} = $props();

	const FORMATS: CompressionFormat[] = ['webp', 'avif', 'jpeg', 'png'];

	/** Local, editable copy of the registry — discarded unless the user saves. */
	let autoCompress = $state(true);
	let presets = $state<CompressionPreset[]>([]);
	let workspacePresets = $state<string[]>([]);
	let saving = $state(false);

	/** The "+ New preset" inline form (hidden until requested). */
	let adding = $state(false);
	let newId = $state('');
	let newLabel = $state('');
	let newFormat = $state<CompressionFormat>('webp');
	let newQuality = $state(80);

	/** Preset pending deletion, held while its confirmation dialog is open. */
	let deleteTarget = $state<CompressionPreset | null>(null);

	/** Nothing subscribes ⇒ no derivative will ever be generated. Allowed, but never silently. */
	const noSubscriptions = $derived(workspacePresets.length === 0);

	// Reset the form from the persisted settings every time the dialog opens, so a cancelled edit
	// leaves no residue and a save made elsewhere is picked up.
	$effect(() => {
		if (!open) return;
		autoCompress = settings.autoCompress;
		presets = settings.presets.map((p) => ({ ...p }));
		workspacePresets = [...settings.workspacePresets];
		adding = false;
		newId = '';
		newLabel = '';
		newFormat = 'webp';
		newQuality = 80;
	});

	/** Is this preset applied to every image (i.e. subscribed at workspace scope)? */
	function isSubscribed(id: string): boolean {
		return workspacePresets.includes(id);
	}

	/** Add/remove a preset id from the workspace subscription list. */
	function toggleSubscribed(id: string, on: boolean) {
		workspacePresets = on
			? [...new Set([...workspacePresets, id])]
			: workspacePresets.filter((p) => p !== id);
	}

	/** Patch one field of a preset row in place (rows are plain clones, so a reassign is enough). */
	function updatePreset(id: string, patch: Partial<CompressionPreset>) {
		presets = presets.map((p) => (p.id === id ? { ...p, ...patch } : p));
	}

	/** Clamp a typed quality into the server's accepted range so Save can't 400 on it. */
	function clampQuality(raw: string): number {
		const n = Number(raw);
		if (!Number.isFinite(n)) return MIN_QUALITY;
		return Math.min(MAX_QUALITY, Math.max(MIN_QUALITY, Math.round(n)));
	}

	/**
	 * Validate and append the new-preset form. The id is a directory name, so it is checked against
	 * the same pattern the server enforces, and duplicates are rejected before the round trip.
	 */
	function addPreset() {
		const id = newId.trim();
		if (!PRESET_ID_PATTERN.test(id)) {
			toast.error('Id must be lowercase letters, digits, - or _ (max 32) and start alphanumeric');
			return;
		}
		if (presets.some((p) => p.id === id)) {
			toast.error(`A preset called “${id}” already exists`);
			return;
		}
		const label = newLabel.trim();
		presets = [
			...presets,
			{ id, format: newFormat, quality: newQuality, ...(label ? { label } : {}) }
		];
		workspacePresets = [...workspacePresets, id];
		adding = false;
		newId = '';
		newLabel = '';
	}

	/** Drop the confirmed preset locally; its derivatives are reclaimed server-side on save. */
	function confirmDelete() {
		const target = deleteTarget;
		if (!target) return;
		presets = presets.filter((p) => p.id !== target.id);
		workspacePresets = workspacePresets.filter((p) => p !== target.id);
		deleteTarget = null;
	}

	/**
	 * Persist the whole registry. Reports (never asks about) the regeneration the server starts on its
	 * own when a recipe change made existing derivatives stale.
	 */
	async function save() {
		saving = true;
		try {
			const res = await apiSaveCompressionSettings({
				autoCompress,
				presets,
				workspacePresets
			});
			onsaved?.(res.settings, res.regenerating);
			toast.success(
				res.regenerating
					? 'Presets saved — changed recipes marked their derivatives stale, and they are being regenerated now.'
					: 'Presets saved.'
			);
			open = false;
		} catch (e) {
			console.error(e);
			toast.error(e instanceof Error ? e.message : 'Failed to save presets');
		} finally {
			saving = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="flex max-h-[90vh] max-w-3xl flex-col">
		<Dialog.Title>Compression presets</Dialog.Title>
		<Dialog.Description>
			A preset is a recipe — a format and a quality. Images subscribe to presets; nothing competes,
			so a file simply gets one derivative per preset applied to it.
		</Dialog.Description>

		<div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-2">
			<div class="flex flex-col gap-1">
				<div class="flex items-center gap-2">
					<Checkbox
						id="compression-auto"
						checked={autoCompress}
						onCheckedChange={(v) => (autoCompress = v === true)}
					/>
					<Label for="compression-auto" class="text-sm font-medium">
						Compress new uploads automatically
					</Label>
				</div>
				<p class="pl-6 text-xs text-muted-foreground">
					Uploads finish immediately; the derivative is generated in the background.
				</p>
			</div>

			<Separator />

			{#if presets.length === 0}
				<p class="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
					No presets yet. Add one below — until then nothing will be compressed.
				</p>
			{:else}
				<div class="flex flex-col gap-3">
					{#each presets as preset (preset.id)}
						<div class="flex flex-col gap-3 rounded-md border p-3">
							<div class="flex flex-wrap items-end gap-3">
								<div class="flex min-w-40 flex-1 flex-col gap-1.5">
									<Label for="preset-label-{preset.id}">Label</Label>
									<Input
										id="preset-label-{preset.id}"
										value={preset.label ?? ''}
										placeholder={preset.id}
										oninput={(e) => updatePreset(preset.id, { label: e.currentTarget.value })}
									/>
								</div>
								<div class="flex w-32 flex-col gap-1.5">
									<Label for="preset-id-{preset.id}">Id</Label>
									<Input
										id="preset-id-{preset.id}"
										value={preset.id}
										readonly
										title="The id is the derived/<id>/ folder name, so it is fixed at creation"
										class="bg-muted text-muted-foreground"
									/>
								</div>
								<div class="flex w-28 flex-col gap-1.5">
									<Label>Format</Label>
									<Select.Root
										type="single"
										value={preset.format}
										onValueChange={(v) =>
											updatePreset(preset.id, { format: (v as CompressionFormat) ?? 'webp' })}
									>
										<Select.Trigger>{preset.format.toUpperCase()}</Select.Trigger>
										<Select.Content>
											{#each FORMATS as f (f)}
												<Select.Item value={f}>{f.toUpperCase()}</Select.Item>
											{/each}
										</Select.Content>
									</Select.Root>
								</div>
								<div class="flex w-24 flex-col gap-1.5">
									<Label for="preset-quality-{preset.id}">Quality</Label>
									<Input
										id="preset-quality-{preset.id}"
										type="number"
										min={MIN_QUALITY}
										max={MAX_QUALITY}
										value={preset.quality}
										oninput={(e) =>
											updatePreset(preset.id, { quality: clampQuality(e.currentTarget.value) })}
									/>
								</div>
								<div class="flex w-28 flex-col gap-1.5">
									<Label for="preset-width-{preset.id}">Width</Label>
									<Input
										id="preset-width-{preset.id}"
										value={preset.width ?? ''}
										placeholder="full size"
										disabled
										title="Resizing arrives in phase 2 — presets currently keep the original dimensions"
									/>
								</div>
								<Button
									variant="ghost"
									size="icon"
									class="text-destructive"
									title="Delete preset"
									onclick={() => (deleteTarget = preset)}
								>
									<Trash2 class="size-4" />
								</Button>
							</div>

							<div class="flex items-center gap-2">
								<Checkbox
									id="preset-sub-{preset.id}"
									checked={isSubscribed(preset.id)}
									onCheckedChange={(v) => toggleSubscribed(preset.id, v === true)}
								/>
								<Label for="preset-sub-{preset.id}" class="text-sm font-normal">
									Applied to every image
								</Label>
								<span class="text-xs text-muted-foreground">
									Width is fixed at full size until phase 2.
								</span>
							</div>
						</div>
					{/each}
				</div>
			{/if}

			{#if noSubscriptions && presets.length > 0}
				<p
					class="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm"
				>
					<TriangleAlert class="mt-0.5 size-4 shrink-0 text-amber-600" />
					<span>
						No preset is applied to every image, so nothing new will be compressed. Existing
						derivatives stay on disk but stop being counted as coverage.
					</span>
				</p>
			{/if}

			{#if adding}
				<div class="flex flex-wrap items-end gap-3 rounded-md border border-dashed p-3">
					<div class="flex w-32 flex-col gap-1.5">
						<Label for="new-preset-id">Id</Label>
						<Input id="new-preset-id" bind:value={newId} placeholder="thumb" />
					</div>
					<div class="flex min-w-40 flex-1 flex-col gap-1.5">
						<Label for="new-preset-label">Label</Label>
						<Input id="new-preset-label" bind:value={newLabel} placeholder="Thumbnail" />
					</div>
					<div class="flex w-28 flex-col gap-1.5">
						<Label>Format</Label>
						<Select.Root
							type="single"
							value={newFormat}
							onValueChange={(v) => (newFormat = (v as CompressionFormat) ?? 'webp')}
						>
							<Select.Trigger>{newFormat.toUpperCase()}</Select.Trigger>
							<Select.Content>
								{#each FORMATS as f (f)}
									<Select.Item value={f}>{f.toUpperCase()}</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
					</div>
					<div class="flex w-24 flex-col gap-1.5">
						<Label for="new-preset-quality">Quality</Label>
						<Input
							id="new-preset-quality"
							type="number"
							min={MIN_QUALITY}
							max={MAX_QUALITY}
							value={newQuality}
							oninput={(e) => (newQuality = clampQuality(e.currentTarget.value))}
						/>
					</div>
					<Button size="sm" onclick={addPreset}>Add</Button>
					<Button size="sm" variant="ghost" onclick={() => (adding = false)}>Cancel</Button>
				</div>
			{:else}
				<div>
					<Button variant="outline" size="sm" onclick={() => (adding = true)}>
						<Plus class="size-4" /> New preset
					</Button>
				</div>
			{/if}
		</div>

		<Dialog.Footer>
			<p class="mr-auto max-w-sm text-left text-xs text-muted-foreground">
				Changing a quality marks that preset's existing derivatives stale; they are regenerated
				automatically after saving. Your originals are never touched.
			</p>
			<Button variant="ghost" disabled={saving} onclick={() => (open = false)}>Cancel</Button>
			<Button disabled={saving} onclick={save}>
				{#if saving}<Loader2 class="size-4 animate-spin" />{/if}
				Save presets
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<AlertDialog.Root
	open={deleteTarget !== null}
	onOpenChange={(v) => {
		if (!v) deleteTarget = null;
	}}
>
	<AlertDialog.Content>
		<AlertDialog.Title>Delete preset</AlertDialog.Title>
		<AlertDialog.Description>
			{#if deleteTarget}
				Delete “{presetLabel(deleteTarget)}”? When you save, every derivative generated from this
				recipe is deleted from disk and the space is reclaimed. Your original files are untouched.
			{/if}
		</AlertDialog.Description>
		<div class="mt-4 flex justify-end gap-2">
			<AlertDialog.Cancel type="button">Cancel</AlertDialog.Cancel>
			<Button variant="destructive" type="button" onclick={confirmDelete}>Delete preset</Button>
		</div>
	</AlertDialog.Content>
</AlertDialog.Root>
