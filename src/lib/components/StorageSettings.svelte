<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import { HardDriveIcon } from 'lucide-svelte';
	import { triggerImageListRefresh } from '$lib/stores/refreshTrigger.js';

	/**
	 * Storage-location control for the app Settings dialog: shows where the workspace's blobs currently
	 * live and lets the user point them somewhere else — switching classic ↔ static or relocating a
	 * static folder — **moving the existing blobs** as part of the change (move / copy / leave). Backed by
	 * `/api/settings/storage` (storage + commit) and `/preview` (dry run); the commit persists the choice to
	 * `media-manager.config.json` (creating it on first save when none exists) and applies it live with no
	 * restart. On success it refreshes open grids so the relocated blobs render immediately.
	 *
	 * Mirrors the CLI's static-assets config (Item 45) but from the UI — the fiddly manual steps
	 * (hand-moving files, editing the config) collapse into one action.
	 */

	interface StorageState {
		mode: 'static' | 'classic';
		dir: string;
		baseUrl: string | null;
		blobCount: number;
		configPath: string;
		configExists: boolean;
		canChange: boolean;
	}
	interface Preflight {
		sameDir: boolean;
		blobCount: number;
		presentAtSource: number;
		missingAtSource: string[];
		conflicts: string[];
		bytesToTransfer: number;
		freeSpaceOk: boolean;
		resolvedDir: string;
	}

	let storage = $state<StorageState | null>(null);
	let changeOpen = $state(false);

	// Change-dialog form.
	let mode = $state<'static' | 'classic'>('static');
	let dir = $state('');
	let baseUrl = $state('/media');
	let strategy = $state<'move' | 'copy' | 'leave'>('move');
	let force = $state(false);
	let preview = $state<Preflight | null>(null);
	let busy = $state(false);
	let errorMsg = $state('');
	let sectionMsg = $state('');

	// Fetch current storage when the component mounts (i.e. each time the Settings dialog opens).
	$effect(() => {
		fetchState();
	});

	async function fetchState() {
		try {
			const r = await fetch('/api/settings/storage');
			if (r.ok) storage = await r.json();
		} catch {
			// leave storage null; the section renders a muted "unavailable" note
		}
	}

	const strategyLabel = $derived(
		strategy === 'move' ? 'Move' : strategy === 'copy' ? 'Copy' : 'Leave (repoint only)'
	);
	const modeLabel = $derived(mode === 'static' ? 'A static folder' : 'Inside the workspace');
	const changeLabel = $derived(
		storage?.configExists ? 'Change location…' : 'Set location & create config…'
	);

	// A preview is safe to commit when nothing conflicts and there's room; missing-at-source needs the
	// explicit "migrate anyway" opt-in.
	const canMigrate = $derived(
		!!preview &&
			!preview.sameDir &&
			preview.conflicts.length === 0 &&
			preview.freeSpaceOk &&
			(preview.missingAtSource.length === 0 || force)
	);

	function humanBytes(n: number): string {
		if (!n) return '0 B';
		const u = ['B', 'KB', 'MB', 'GB', 'TB'];
		const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
		return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
	}

	function openChange() {
		errorMsg = '';
		sectionMsg = '';
		preview = null;
		force = false;
		mode = storage?.mode ?? 'static';
		dir = storage?.mode === 'static' ? (storage?.dir ?? '') : '';
		baseUrl = storage?.baseUrl ?? '/media';
		strategy = 'move';
		changeOpen = true;
	}

	function requestBody(includeForce = false) {
		const base: Record<string, unknown> =
			mode === 'static' ? { mode, dir, baseUrl, strategy } : { mode, strategy };
		if (includeForce) base.force = force;
		return base;
	}

	async function doPreview() {
		errorMsg = '';
		preview = null;
		busy = true;
		try {
			const r = await fetch('/api/settings/storage/preview', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(requestBody())
			});
			const data = await r.json().catch(() => ({}));
			if (!r.ok) {
				errorMsg = data.message ?? `Preview failed (${r.status})`;
				return;
			}
			preview = data;
		} catch (e) {
			errorMsg = (e as Error).message;
		} finally {
			busy = false;
		}
	}

	async function doMigrate() {
		errorMsg = '';
		busy = true;
		try {
			const r = await fetch('/api/settings/storage', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(requestBody(true))
			});
			const data = await r.json().catch(() => ({}));
			if (!r.ok) {
				// A 409 aborted-preflight carries the report; refresh the preview so conflicts show inline.
				errorMsg = data.reason ?? data.message ?? `Migration failed (${r.status})`;
				if (data && Array.isArray(data.conflicts)) preview = data;
				return;
			}
			const parts: string[] = [];
			if (data.moved) parts.push(`moved ${data.moved}`);
			if (data.copied) parts.push(`copied ${data.copied}`);
			if (data.skipped) parts.push(`skipped ${data.skipped}`);
			const where = data.mode === 'static' ? data.dir || 'static folder' : 'the workspace';
			sectionMsg = `Storage updated — ${parts.join(', ') || 'no files to move'} → ${where}.`;
			await fetchState();
			triggerImageListRefresh();
			changeOpen = false;
		} catch (e) {
			errorMsg = (e as Error).message;
		} finally {
			busy = false;
		}
	}
</script>

<div class="flex flex-col gap-2">
	<h3 class="flex items-center gap-2 text-lg font-bold">
		<HardDriveIcon class="size-4" /> Storage
	</h3>

	{#if storage}
		<div class="text-muted-foreground flex flex-col gap-1 text-sm">
			<div>
				Blobs live in
				<code class="bg-muted rounded px-1 py-0.5 text-xs">{storage.dir}</code>
				<span class="text-xs">({storage.mode})</span>
			</div>
			{#if storage.mode === 'static' && storage.baseUrl}
				<div>
					Served at <code class="bg-muted rounded px-1 py-0.5 text-xs">{storage.baseUrl}</code>
				</div>
			{/if}
			<div>{storage.blobCount} file{storage.blobCount === 1 ? '' : 's'} registered</div>
			{#if !storage.configExists}
				<div class="text-xs">
					No config file yet — the first change creates
					<code class="bg-muted rounded px-1 py-0.5 text-xs">{storage.configPath}</code>.
				</div>
			{/if}
		</div>

		{#if sectionMsg}
			<p class="text-sm text-green-600 dark:text-green-500">{sectionMsg}</p>
		{/if}

		<div>
			<Button variant="outline" size="sm" onclick={openChange} disabled={!storage.canChange}>
				{changeLabel}
			</Button>
			{#if !storage.canChange}
				<p class="text-muted-foreground mt-1 text-xs">
					The config file isn't writable, so the location can't be changed here.
				</p>
			{/if}
		</div>
	{:else}
		<p class="text-muted-foreground text-sm">Storage settings unavailable.</p>
	{/if}
</div>

<Dialog.Root bind:open={changeOpen}>
	<Dialog.Content class="max-w-lg">
		<Dialog.Title>Change storage location</Dialog.Title>
		<Dialog.Description>
			Point the workspace's blobs at a new folder and move the existing files with them.
		</Dialog.Description>

		<div class="flex flex-col gap-4 py-2">
			<div class="flex flex-col gap-2">
				<Label class="shrink-0">Store blobs in</Label>
				<Select.Root
					type="single"
					value={mode}
					onValueChange={(v) => {
						if (v) {
							mode = v as 'static' | 'classic';
							preview = null;
						}
					}}
				>
					<Select.Trigger class="w-full">{modeLabel}</Select.Trigger>
					<Select.Content>
						<Select.Item value="static">A static folder (CDN-served, not bundled)</Select.Item>
						<Select.Item value="classic">Inside the workspace (media/files)</Select.Item>
					</Select.Content>
				</Select.Root>
			</div>

			{#if mode === 'static'}
				<div class="flex flex-col gap-2">
					<Label for="storage-dir">Folder</Label>
					<Input
						id="storage-dir"
						bind:value={dir}
						placeholder="./static/media"
						oninput={() => (preview = null)}
					/>
					<p class="text-muted-foreground text-xs">Resolved relative to the config file.</p>
				</div>
				<div class="flex flex-col gap-2">
					<Label for="storage-baseurl">Served at (base URL)</Label>
					<Input
						id="storage-baseurl"
						bind:value={baseUrl}
						placeholder="/media"
						oninput={() => (preview = null)}
					/>
				</div>
			{/if}

			<div class="flex flex-col gap-2">
				<Label class="shrink-0">Existing files</Label>
				<Select.Root
					type="single"
					value={strategy}
					onValueChange={(v) => {
						if (v) {
							strategy = v as 'move' | 'copy' | 'leave';
							preview = null;
						}
					}}
				>
					<Select.Trigger class="w-full">{strategyLabel}</Select.Trigger>
					<Select.Content>
						<Select.Item value="move">Move (relocate the bytes)</Select.Item>
						<Select.Item value="copy">Copy (keep the originals too)</Select.Item>
						<Select.Item value="leave">Leave (I already moved them)</Select.Item>
					</Select.Content>
				</Select.Root>
			</div>

			{#if preview}
				<div class="bg-muted/50 flex flex-col gap-1 rounded-md border p-3 text-sm">
					{#if preview.sameDir}
						<p>That's already the current location — nothing to move.</p>
					{:else}
						<p>
							{preview.presentAtSource} of {preview.blobCount} file{preview.blobCount === 1
								? ''
								: 's'} ready
							{#if preview.bytesToTransfer > 0 && strategy !== 'leave'}
								· {humanBytes(preview.bytesToTransfer)}{/if}
						</p>
						{#if preview.conflicts.length > 0}
							<p class="text-red-600 dark:text-red-500">
								⚠ {preview.conflicts.length} name conflict{preview.conflicts.length === 1
									? ''
									: 's'} at the destination — resolve before migrating:
								<span class="text-xs">{preview.conflicts.slice(0, 5).join(', ')}</span>
							</p>
						{/if}
						{#if !preview.freeSpaceOk}
							<p class="text-red-600 dark:text-red-500">
								⚠ Not enough free space at the destination.
							</p>
						{/if}
						{#if preview.missingAtSource.length > 0}
							<p class="text-amber-600 dark:text-amber-500">
								{preview.missingAtSource.length} file{preview.missingAtSource.length === 1
									? ''
									: 's'} missing at the source (will stay missing).
							</p>
							<div class="flex flex-row items-center gap-2">
								<Checkbox
									id="storage-force"
									checked={force}
									onCheckedChange={(c) => (force = !!c)}
								/>
								<Label for="storage-force" class="text-xs">Migrate the rest anyway</Label>
							</div>
						{/if}
					{/if}
				</div>
			{/if}

			{#if errorMsg}
				<p class="text-sm text-red-600 dark:text-red-500">{errorMsg}</p>
			{/if}
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={() => (changeOpen = false)} disabled={busy}>Cancel</Button>
			<Button variant="secondary" onclick={doPreview} disabled={busy}>Preview</Button>
			<Button onclick={doMigrate} disabled={busy || !canMigrate}>
				{busy ? 'Working…' : 'Migrate'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
