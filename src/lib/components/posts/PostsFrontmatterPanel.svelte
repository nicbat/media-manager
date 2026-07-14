<script lang="ts">
	import FieldInput from '$lib/components/FieldInput.svelte';
	import { fieldLabel } from '$lib/core/fieldKeys.js';
	import type { SchemaDefinition } from '$lib/core/types.js';

	/**
	 * The **schema-driven** frontmatter editor for a post (Item 14, converged). It renders the
	 * collection's frontmatter **schema** (a `SchemaDefinition`, identical in shape to a Records type /
	 * Files class) as a typed key→value table via the shared {@link FieldInput} — the same primitive the
	 * record + file editors use. Fields are added / edited / deleted / **reordered** in the collection's
	 * settings dialog (the shared `EntitySettingsDialog` Fields tab), not here — exactly like Records.
	 *
	 * File-kind values are bare manifest ids **while editing** (what FieldInput/FilePicker speak); the
	 * host ({@link PostsEditorPane}) strips/re-adds the `mm://` prefix at the load/save boundary and seeds
	 * any schema key missing from the post's frontmatter, so every field here has a value to bind.
	 *
	 * @param frontmatter - Two-way bound frontmatter object (plain YAML-ish values).
	 * @param schema - The collection's frontmatter schema (drives field order + input types).
	 * @param oncommit - Fired when a field reaches a committed value the host should persist.
	 */
	let {
		frontmatter = $bindable(),
		schema,
		oncommit
	}: {
		frontmatter: Record<string, unknown>;
		schema: SchemaDefinition;
		oncommit?: () => void;
	} = $props();

	const keys = $derived(Object.keys(schema));
</script>

{#if keys.length === 0}
	<p class="text-sm text-muted-foreground">
		No fields yet. Add frontmatter fields in <strong>Collection settings → Fields</strong>.
	</p>
{:else}
	<!-- Stacked (label over input) so the fields fit the narrow right-hand metadata panel. -->
	<div class="flex flex-col gap-3">
		{#each keys as key (key)}
			<div class="flex min-w-0 flex-col gap-1">
				<span class="text-xs font-medium text-muted-foreground" title={key}>{fieldLabel(key)}</span>
				<div class="min-w-0">
					<FieldInput def={schema[key]} bind:value={frontmatter[key]} {oncommit} />
				</div>
			</div>
		{/each}
	</div>
{/if}
