<script lang="ts">
	import { settingsStore, type AppSettings } from '$lib/stores/settings';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Button } from '$lib/components/ui/button';
	import { Label } from '$lib/components/ui/label';
	import { Separator } from '$lib/components/ui/separator';
	import * as Select from '$lib/components/ui/select/index.js';
	import { SettingsIcon } from 'lucide-svelte';
	import AppearanceSettings from '$lib/components/AppearanceSettings.svelte';
	import StorageSettings from '$lib/components/StorageSettings.svelte';

	/**
	 * The single, global Settings dialog used everywhere (dashboard, the All Files hub, and every
	 * `json` record editor). All preferences are app-wide (stored in `media/settings.json` via
	 * `/api/settings`): there are no per-class or per-type overrides. Grid views subscribe to the
	 * settings store directly, so updating `gridSize` here propagates live without any extra plumbing.
	 */
	let settings = $state<AppSettings>({
		autoAdvanceToNextUnlinked: false,
		autoSaveOnAdvance: false,
		gridSize: 'medium',
		railCollapsed: false
	});
	let resetToDefaultsOpen = $state(false);
	let isOpen = $state(false);

	// Mirror the global store into local state for the form.
	$effect(() => {
		const unsubscribe = settingsStore.subscribe((s) => {
			settings = s;
		});
		return () => unsubscribe();
	});

	// Re-fetch when the dialog opens (in case it changed elsewhere).
	$effect(() => {
		if (isOpen) settingsStore.fetchSettings();
	});

	function setAutoAdvance(enabled: boolean) {
		settingsStore.updateSetting('autoAdvanceToNextUnlinked', enabled);
	}
	function setAutoSave(enabled: boolean) {
		settingsStore.updateSetting('autoSaveOnAdvance', enabled);
	}
	function setGridSize(value: 'small' | 'medium' | 'large') {
		settingsStore.updateSetting('gridSize', value);
	}

	async function handleResetToDefaults() {
		await settingsStore.resetToDefaults();
		resetToDefaultsOpen = false;
	}

	const gridSizeLabel = $derived(
		settings.gridSize === 'small' ? 'Small' : settings.gridSize === 'large' ? 'Large' : 'Medium'
	);
</script>

<Dialog.Root bind:open={isOpen}>
	<Dialog.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="outline" size="icon" title="App settings">
				<SettingsIcon />
			</Button>
		{/snippet}
	</Dialog.Trigger>
	<Dialog.Content>
		<Dialog.Title>App settings</Dialog.Title>
		<Dialog.Description>
			Global, app-wide preferences. Per-class / per-type settings live in each entity's ⋮ menu.
		</Dialog.Description>

		<div class="flex flex-col gap-4 py-4">
			<div class="flex flex-col gap-2">
				<h3 class="text-lg font-bold">Navigation</h3>
				<div class="flex flex-col gap-2">
					<div class="flex flex-row items-center gap-2">
						<Checkbox
							id="auto-advance"
							checked={settings.autoAdvanceToNextUnlinked}
							onCheckedChange={(checked) => setAutoAdvance(!!checked)}
						/>
						<Label for="auto-advance">Auto-advance to the next item after saving</Label>
					</div>
					<div class="flex flex-row items-center gap-2">
						<Checkbox
							id="auto-save-advance"
							checked={settings.autoSaveOnAdvance}
							onCheckedChange={(checked) => setAutoSave(!!checked)}
						/>
						<Label for="auto-save-advance">Auto-save when moving to the previous/next item</Label>
					</div>
				</div>
			</div>

			<Separator />

			<div class="flex flex-col gap-2">
				<h3 class="text-lg font-bold">Grid</h3>
				<div class="flex flex-row items-center gap-2">
					<Label for="grid-size-setting" class="shrink-0">Grid size</Label>
					<Select.Root
						type="single"
						value={settings.gridSize}
						onValueChange={(v) => v && setGridSize(v as 'small' | 'medium' | 'large')}
					>
						<Select.Trigger id="grid-size-setting" class="w-[120px]">{gridSizeLabel}</Select.Trigger
						>
						<Select.Content>
							<Select.Item value="small">Small</Select.Item>
							<Select.Item value="medium">Medium</Select.Item>
							<Select.Item value="large">Large</Select.Item>
						</Select.Content>
					</Select.Root>
				</div>
			</div>

			<Separator />

			<StorageSettings />

			<Separator />

			<AppearanceSettings />
		</div>

		<Separator />
		<Dialog.Footer>
			<AlertDialog.Root bind:open={resetToDefaultsOpen}>
				<AlertDialog.Trigger>
					{#snippet child({ props })}
						<Button {...props} variant="outline" class="btn btn-secondary">Reset to Defaults</Button
						>
					{/snippet}
				</AlertDialog.Trigger>
				<AlertDialog.Content>
					<AlertDialog.Title>Reset to Defaults</AlertDialog.Title>
					<AlertDialog.Description>
						Are you sure you want to reset all settings to their default values?
					</AlertDialog.Description>
					<div class="flex justify-end">
						<form
							onsubmit={(e) => {
								e.preventDefault();
								handleResetToDefaults();
							}}
							class="flex gap-2"
						>
							<AlertDialog.Cancel type="button">Cancel</AlertDialog.Cancel>
							<AlertDialog.Action type="submit">Reset</AlertDialog.Action>
						</form>
					</div>
				</AlertDialog.Content>
			</AlertDialog.Root>
			<Button
				variant="default"
				class="btn btn-primary"
				type="button"
				onclick={() => (isOpen = false)}
			>
				Done
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
