<script lang="ts">
	import { onMount } from 'svelte';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Separator } from '$lib/components/ui/separator/index.js';
	import Breadcrumbs from '$lib/components/Breadcrumbs.svelte';
	import PresetsDialog from '$lib/components/compression/PresetsDialog.svelte';
	import { Eraser, Loader2, Shrink, SlidersHorizontal, TriangleAlert } from 'lucide-svelte';
	import { toast } from 'svelte-sonner';
	import {
		apiCancelBackfill,
		apiGetCompressionJob,
		apiGetCompressionReport,
		apiStartBackfill,
		apiSweepDerived,
		formatBytes,
		formatDuration,
		UNCLASSIFIED_CLASS_ID,
		type CompressionJobState,
		type CompressionReport,
		type CompressionSettings,
		type SweepResult
	} from '$lib/api/compression.js';

	/**
	 * The **Compression** page (Item 15, phase 1) — the workspace's savings report.
	 *
	 * It answers three questions in descending order of how often they're asked: *how much am I
	 * saving*, *is anything degraded*, *is anything not done yet*. The headline number is bytes, but
	 * quality sits immediately beside it by design — a great savings figure must never be readable
	 * without its cost.
	 *
	 * Unlike the three entity sub-apps this is a single-column **report** page: there is no entity list
	 * to rail, so it uses the plain breadcrumb + header + scroll-body frame rather than
	 * {@link EntityRail}. The header hosts the only two write actions: the presets editor and the
	 * backfill, which turns into live progress in place while a job runs.
	 *
	 * **The job lives on the server**, not in this page. Opening the page fetches the current state and
	 * starts polling if a backfill is already running, so navigating away and back shows live progress
	 * rather than a stalled snapshot. Polling stops on unmount (the `$effect` cleanup) — a leaked
	 * interval here would keep hammering the API from a dead page.
	 */

	/** How often the job-only endpoint is polled while a backfill runs. */
	const POLL_MS = 1000;

	let report = $state<CompressionReport | null>(null);
	let job = $state<CompressionJobState | null>(null);
	let loading = $state(true);
	let loadError = $state<string | null>(null);

	let presetsOpen = $state(false);
	let starting = $state(false);
	let cancelling = $state(false);

	/** Sweep flow: the dry-run preview held open in its confirmation dialog. */
	let sweepPreview = $state<SweepResult | null>(null);
	let sweepOpen = $state(false);
	let sweepBusy = $state(false);

	/** Wall clock, advanced on every poll, so the remaining-time estimate ticks while a job runs. */
	let now = $state(Date.now());

	/** Guards against overlapping polls when a request outlives its interval tick. */
	let polling = false;

	const stats = $derived(report?.stats ?? null);
	const settings = $derived(report?.settings ?? null);
	const running = $derived(job?.running === true);

	/** Files the backfill would visit: never-compressed blobs plus derivatives gone stale. */
	const pendingWork = $derived(stats ? stats.pendingFiles + stats.staleDerivatives : 0);

	/** Percentage of the original bytes saved by the headline preset (null when nothing is generated). */
	const savedPercent = $derived.by(() => {
		const h = stats?.headline;
		if (!h || h.originalBytes <= 0) return null;
		return (h.savedBytes / h.originalBytes) * 100;
	});

	/** Rough time remaining, extrapolated from elapsed ÷ done. Null until the first file finishes. */
	const eta = $derived.by(() => {
		if (!job?.running || !job.startedAt || job.done <= 0 || job.total <= job.done) return null;
		const elapsed = now - new Date(job.startedAt).getTime();
		if (elapsed <= 0) return null;
		return formatDuration(((job.total - job.done) * elapsed) / job.done);
	});

	/**
	 * Label for the idle primary action. "Nothing to compress" and "Everything is compressed" are
	 * different facts and the button says which: an empty workspace has no work *yet*, a covered one
	 * has none *left*.
	 */
	const backfillLabel = $derived.by(() => {
		if (pendingWork > 0) return `Backfill ${pendingWork} file${pendingWork === 1 ? '' : 's'}`;
		if (!stats || stats.totalFiles === 0) return 'Nothing to compress';
		return 'Everything is compressed';
	});

	/** True once the workspace has at least one preset applied to every image. */
	const hasSubscription = $derived((settings?.workspacePresets.length ?? 0) > 0);

	/** Largest bucket count, so the histogram bars can be drawn proportionally. */
	const histogramMax = $derived(Math.max(1, ...(stats?.histogram.map((b) => b.count) ?? [0])));

	/** Largest per-class saving, for the same reason. */
	const byClassMax = $derived(Math.max(1, ...(stats?.byClass.map((c) => c.savedBytes) ?? [0])));

	/** Whether the flagged list is a truncated view of a longer set. */
	const flaggedTruncated = $derived(!!stats && stats.flaggedCount > stats.flagged.length);

	/** SSIM thresholds, spelled out next to each bucket so the label means something concrete. */
	const BUCKET_THRESHOLDS: Record<string, string> = {
		identical: '≥ .995',
		imperceptible: '≥ .99',
		excellent: '≥ .97',
		slight: '≥ .94',
		visible: '< .94'
	};

	/** Bucket → bar colour, running good (green) → borderline (amber) → bad (destructive). */
	const BUCKET_COLORS: Record<string, string> = {
		identical: 'bg-emerald-500',
		imperceptible: 'bg-emerald-400',
		excellent: 'bg-primary',
		slight: 'bg-amber-500',
		visible: 'bg-destructive'
	};

	/** Human name for a `byClass` row — the reserved catch-all key reads as "Unclassified". */
	function className(classId: string): string {
		if (classId === UNCLASSIFIED_CLASS_ID) return 'Unclassified';
		return report?.classNames[classId] ?? classId;
	}

	/**
	 * Load the whole report.
	 *
	 * @param quiet - Skip the loading state (used for background refreshes after a job or a sweep, so
	 *   the page updates in place instead of blanking out).
	 */
	async function loadReport(quiet = false) {
		if (!quiet) loading = true;
		try {
			const next = await apiGetCompressionReport();
			report = next;
			job = next.job;
			loadError = null;
		} catch (e) {
			console.error(e);
			// A background refresh must not replace a good report with an error screen.
			if (!quiet) loadError = e instanceof Error ? e.message : 'Failed to load the report';
			else toast.error('Could not refresh the compression report');
		} finally {
			loading = false;
		}
	}

	/**
	 * Poll the cheap job-only endpoint. When the job flips from running to finished, refetch the full
	 * report so the savings/coverage numbers catch up with the work that just landed.
	 *
	 * Transient failures are swallowed: a single dropped poll should not tear down a running progress
	 * display, and the next tick will recover.
	 */
	async function pollJob() {
		if (polling) return;
		polling = true;
		try {
			const wasRunning = job?.running === true;
			job = await apiGetCompressionJob();
			now = Date.now();
			if (wasRunning && !job.running) await loadReport(true);
		} catch (e) {
			console.error(e);
		} finally {
			polling = false;
		}
	}

	async function startBackfill() {
		starting = true;
		try {
			job = await apiStartBackfill();
			now = Date.now();
		} catch (e) {
			console.error(e);
			toast.error(e instanceof Error ? e.message : 'Failed to start the backfill');
		} finally {
			starting = false;
		}
	}

	async function cancelBackfill() {
		cancelling = true;
		try {
			job = await apiCancelBackfill();
			toast.info('Cancelling — the files being compressed right now will finish first.');
		} catch (e) {
			console.error(e);
			toast.error(e instanceof Error ? e.message : 'Failed to cancel the backfill');
		} finally {
			cancelling = false;
		}
	}

	/** Step 1 of the sweep: ask what *would* be removed, then show it for confirmation. */
	async function previewSweep() {
		sweepBusy = true;
		try {
			sweepPreview = await apiSweepDerived(true);
			sweepOpen = true;
		} catch (e) {
			console.error(e);
			toast.error(e instanceof Error ? e.message : 'Failed to check for unused derivatives');
		} finally {
			sweepBusy = false;
		}
	}

	/** Step 2: actually delete. Only reachable from the confirmation dialog. */
	async function runSweep() {
		sweepBusy = true;
		try {
			const res = await apiSweepDerived(false);
			if (res.skippedReason) toast.info(res.skippedReason);
			else if (res.removed.length === 0)
				toast.success('Nothing to remove — no orphaned derivatives.');
			else
				toast.success(
					`Removed ${res.removed.length} file${res.removed.length === 1 ? '' : 's'} · ${formatBytes(res.bytes)} reclaimed`
				);
			sweepOpen = false;
			sweepPreview = null;
			await loadReport(true);
		} catch (e) {
			console.error(e);
			toast.error(e instanceof Error ? e.message : 'Failed to sweep unused derivatives');
		} finally {
			sweepBusy = false;
		}
	}

	/** Adopt the settings the server echoed back, and pick up any regeneration it kicked off. */
	function onPresetsSaved(next: CompressionSettings, regenerating: boolean) {
		if (report) report = { ...report, settings: next };
		void loadReport(true);
		if (regenerating) void pollJob();
	}

	onMount(loadReport);

	// Poll only while a job is running; the cleanup covers both "job finished" and "page unmounted".
	// `running` is a boolean derived, so a poll that leaves it true does not re-run this effect.
	$effect(() => {
		if (!running) return;
		const timer = setInterval(pollJob, POLL_MS);
		return () => clearInterval(timer);
	});
</script>

{#snippet statCard(title: string, value: string, detail: string, muted = false)}
	<Card.Root class="gap-2">
		<Card.Header class="pb-0">
			<Card.Description class="text-xs uppercase tracking-wide">{title}</Card.Description>
		</Card.Header>
		<Card.Content>
			<p class="text-3xl font-semibold tabular-nums {muted ? 'text-muted-foreground' : ''}">
				{value}
			</p>
			<p class="mt-1 text-xs text-muted-foreground">{detail}</p>
		</Card.Content>
	</Card.Root>
{/snippet}

<div class="flex h-screen w-full flex-col overflow-hidden">
	<div class="flex h-9 shrink-0 items-center border-b px-3">
		<Breadcrumbs items={[{ label: 'Home', href: '/' }, { label: 'Compression' }]} />
	</div>

	<header class="flex shrink-0 flex-wrap items-center gap-3 border-b p-3">
		<Shrink class="size-5 text-muted-foreground" />
		<h1 class="text-lg font-semibold tracking-tight">Compression</h1>
		<div class="flex-1"></div>

		<Button variant="outline" size="sm" onclick={() => (presetsOpen = true)} disabled={!settings}>
			<SlidersHorizontal class="size-4" /> Presets…
		</Button>

		{#if running}
			<div class="flex items-center gap-3 rounded-md border bg-muted/40 px-3 py-1.5">
				<Loader2 class="size-4 animate-spin text-primary" />
				<div class="text-xs leading-tight">
					<p class="font-medium">
						{#if job?.cancelling}
							Finishing the current files…
						{:else if job?.planning}
							Working out what needs compressing…
						{:else}
							Compressing {job?.total ?? 0} files
						{/if}
					</p>
					<!-- While planning, `total` is not yet meaningful — showing "0 / 0" would read as a stall. -->
					{#if !job?.planning}
						<p class="text-muted-foreground tabular-nums">
							{job?.done ?? 0} / {job?.total ?? 0}{eta ? ` · ~${eta} left` : ''} · saved {formatBytes(
								job?.savedBytes ?? 0
							)} · {job?.skipped ?? 0} skipped · {job?.flagged ?? 0} flagged
						</p>
					{/if}
				</div>
				<Button
					variant="ghost"
					size="sm"
					disabled={cancelling || job?.cancelling}
					onclick={cancelBackfill}
				>
					Cancel
				</Button>
			</div>
		{:else}
			<Button size="sm" disabled={starting || loading || pendingWork === 0} onclick={startBackfill}>
				{#if starting}<Loader2 class="size-4 animate-spin" />{/if}
				{backfillLabel}
			</Button>
		{/if}
	</header>

	<main class="min-h-0 flex-1 overflow-y-auto">
		<div class="mx-auto flex max-w-5xl flex-col gap-6 p-6">
			{#if loading}
				<p class="italic text-muted-foreground">Loading the compression report…</p>
			{:else if loadError}
				<Card.Root class="border-destructive/40">
					<Card.Header>
						<Card.Title class="text-base">Couldn't load the report</Card.Title>
						<Card.Description>{loadError}</Card.Description>
					</Card.Header>
					<Card.Content>
						<Button variant="outline" size="sm" onclick={() => loadReport()}>Try again</Button>
					</Card.Content>
				</Card.Root>
			{:else if stats && settings}
				{#if job?.error}
					<p
						class="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
					>
						<TriangleAlert class="mt-0.5 size-4 shrink-0 text-destructive" />
						<span>The last compression run stopped early: {job.error}</span>
					</p>
				{/if}

				{#if settings.presets.length === 0}
					<p
						class="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm"
					>
						<TriangleAlert class="mt-0.5 size-4 shrink-0 text-amber-600" />
						<span>
							No presets are configured, so nothing is being compressed. Add a recipe in
							<strong>Presets…</strong> to get started.
						</span>
					</p>
				{:else if !hasSubscription}
					<p
						class="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm"
					>
						<TriangleAlert class="mt-0.5 size-4 shrink-0 text-amber-600" />
						<span>
							No preset is applied to every image, so no new derivatives will be generated. Tick
							“Applied to every image” for a preset in <strong>Presets…</strong>.
						</span>
					</p>
				{/if}

				<!-- 1. How much am I saving — with the quality cost sitting right next to it. -->
				<section class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
					{#if stats.headline && stats.headline.generated > 0}
						{@render statCard(
							'Saved',
							formatBytes(stats.headline.savedBytes),
							`${formatBytes(stats.headline.originalBytes)} → ${formatBytes(stats.headline.derivedBytes)}${
								savedPercent !== null ? ` · −${savedPercent.toFixed(1)}%` : ''
							}`
						)}
					{:else}
						{@render statCard(
							'Saved',
							'—',
							stats.totalFiles === 0
								? 'No files in this workspace yet'
								: 'Nothing generated yet — run a backfill',
							true
						)}
					{/if}

					{@render statCard(
						'Covered',
						`${stats.coveredFiles}/${stats.totalFiles}`,
						`${stats.uncompressibleFiles} can't be compressed`
					)}

					{@render statCard(
						'Quality',
						stats.medianSsim !== null ? stats.medianSsim.toFixed(3) : '—',
						`median SSIM · ${stats.flaggedCount} flagged`,
						stats.medianSsim === null
					)}

					<!-- The sub-line describes *stale* specifically: a first-time backfill is compressing
					     pending files, not regenerating stale ones, so `running` alone must not claim it is. -->
					{@render statCard(
						'Stale',
						String(stats.staleDerivatives),
						stats.staleDerivatives === 0
							? 'up to date'
							: running
								? 'regenerating automatically'
								: 'run a backfill to refresh',
						stats.staleDerivatives === 0
					)}
				</section>

				<!-- 2. Is anything degraded — the distribution first, the offenders after. -->
				<section class="flex flex-col gap-3">
					<div>
						<h2 class="text-sm font-semibold">Quality distribution</h2>
						<p class="text-xs text-muted-foreground">
							SSIM of every generated derivative against its original.
						</p>
					</div>
					{#if stats.histogram.every((b) => b.count === 0)}
						<p class="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
							Nothing has been scored yet — quality appears once derivatives are generated.
						</p>
					{:else}
						<div class="flex flex-col gap-1.5">
							{#each stats.histogram as bucket (bucket.key)}
								<div class="flex items-center gap-3 text-sm">
									<span class="w-40 shrink-0 text-muted-foreground">
										<span class="tabular-nums">{BUCKET_THRESHOLDS[bucket.key] ?? ''}</span>
										{bucket.label}
									</span>
									<div class="h-3 flex-1 overflow-hidden rounded-sm bg-muted">
										<div
											class="h-full rounded-sm {BUCKET_COLORS[bucket.key] ?? 'bg-primary'}"
											style="width: {(bucket.count / histogramMax) * 100}%"
										></div>
									</div>
									<span class="w-12 shrink-0 text-right tabular-nums text-muted-foreground">
										{bucket.count}
									</span>
								</div>
							{/each}
						</div>
					{/if}
				</section>

				<Separator />

				<!-- Where the savings actually come from. -->
				<section class="flex flex-col gap-3">
					<h2 class="text-sm font-semibold">Savings by class</h2>
					{#if stats.byClass.length === 0}
						<p class="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
							No savings to attribute yet.
						</p>
					{:else}
						<div class="flex flex-col gap-1.5">
							{#each stats.byClass as row (row.classId)}
								<div class="flex items-center gap-3 text-sm">
									<span class="w-40 shrink-0 truncate" title={className(row.classId)}>
										{className(row.classId)}
									</span>
									<div class="h-3 flex-1 overflow-hidden rounded-sm bg-muted">
										<div
											class="h-full rounded-sm bg-primary"
											style="width: {(row.savedBytes / byClassMax) * 100}%"
										></div>
									</div>
									<span class="w-24 shrink-0 text-right tabular-nums">
										{formatBytes(row.savedBytes)}
									</span>
									<span class="w-16 shrink-0 text-right tabular-nums text-muted-foreground">
										{row.files} file{row.files === 1 ? '' : 's'}
									</span>
								</div>
							{/each}
						</div>
					{/if}
				</section>

				<Separator />

				<section class="flex flex-col gap-3">
					<div>
						<h2 class="text-sm font-semibold">
							Needs a look{stats.flaggedCount > 0 ? ` (${stats.flaggedCount})` : ''}
						</h2>
						<p class="text-xs text-muted-foreground">
							Derivatives whose SSIM fell below .94 — visible loss is likely.
							{#if flaggedTruncated}
								Showing the {stats.flagged.length} lowest-scoring.
							{/if}
						</p>
					</div>
					{#if stats.flagged.length === 0}
						<p class="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
							Nothing is flagged — every derivative scored above the visible-loss threshold. Good
							news.
						</p>
					{:else}
						<div class="overflow-hidden rounded-md border">
							<div
								class="flex items-center gap-3 border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground"
							>
								<span class="w-10 shrink-0"></span>
								<span class="flex-1">File</span>
								<span class="w-24 shrink-0 text-right">Original</span>
								<span class="w-24 shrink-0 text-right">Compressed</span>
								<span class="w-16 shrink-0 text-right">SSIM</span>
							</div>
							{#each stats.flagged as f (f.fileId + f.presetId)}
								<div class="flex items-center gap-3 border-b px-3 py-2 text-sm last:border-b-0">
									<img
										src="/api/files/{f.fileId}/blob?preset={encodeURIComponent(f.presetId)}"
										alt=""
										loading="lazy"
										class="size-10 shrink-0 rounded object-cover"
									/>
									<span class="min-w-0 flex-1 truncate" title={f.fileName}>{f.fileName}</span>
									<span class="w-24 shrink-0 text-right tabular-nums text-muted-foreground">
										{f.originalSize !== null ? formatBytes(f.originalSize) : '—'}
									</span>
									<span class="w-24 shrink-0 text-right tabular-nums text-muted-foreground">
										{f.derivedSize !== null ? formatBytes(f.derivedSize) : '—'}
									</span>
									<span class="w-16 shrink-0 text-right font-medium tabular-nums text-amber-600">
										{f.ssim.toFixed(3)}
									</span>
								</div>
							{/each}
						</div>
					{/if}
				</section>

				<!-- 3. Is anything not done yet. -->
				{#if stats.uncompressible.length > 0}
					<section class="flex flex-col gap-2">
						<h2 class="text-sm font-semibold">Not compressible</h2>
						<p class="text-sm">
							{#each stats.uncompressible as g, i (g.key)}{i > 0 ? ' · ' : ''}{g.count}
								{g.label}{/each}
						</p>
						{#each stats.uncompressible as g (g.key)}
							{#if g.examples.length > 0}
								<p class="truncate text-xs text-muted-foreground" title={g.examples.join(', ')}>
									{g.label}: {g.examples.join(', ')}{g.count > g.examples.length ? ' …' : ''}
								</p>
							{/if}
						{/each}
					</section>
				{/if}

				<Separator />

				<section class="flex flex-wrap items-center gap-3">
					<div class="min-w-0 flex-1">
						<h2 class="text-sm font-semibold">Unused derivative files</h2>
						<p class="text-xs text-muted-foreground">
							Files left behind by a deleted preset, a rename, or a format change. Sweeping never
							touches your originals.
						</p>
					</div>
					<Button variant="outline" size="sm" disabled={sweepBusy} onclick={previewSweep}>
						{#if sweepBusy && !sweepOpen}<Loader2 class="size-4 animate-spin" />{:else}<Eraser
								class="size-4"
							/>{/if}
						Sweep unused files…
					</Button>
				</section>
			{/if}
		</div>
	</main>
</div>

{#if settings}
	<PresetsDialog bind:open={presetsOpen} {settings} onsaved={onPresetsSaved} />
{/if}

<AlertDialog.Root
	bind:open={sweepOpen}
	onOpenChange={(v) => {
		if (!v) sweepPreview = null;
	}}
>
	<AlertDialog.Content>
		<AlertDialog.Title>Sweep unused derivatives</AlertDialog.Title>
		<AlertDialog.Description>
			{#if sweepPreview?.skippedReason}
				{sweepPreview.skippedReason}
			{:else if sweepPreview && sweepPreview.removed.length === 0}
				Nothing to remove — every derivative on disk is still referenced.
			{:else if sweepPreview}
				{sweepPreview.removed.length} file{sweepPreview.removed.length === 1 ? '' : 's'} would be deleted,
				reclaiming {formatBytes(sweepPreview.bytes)}.
				{#if sweepPreview.removedPresetDirs.length > 0}
					That includes {sweepPreview.removedPresetDirs.length} whole preset folder{sweepPreview
						.removedPresetDirs.length === 1
						? ''
						: 's'} ({sweepPreview.removedPresetDirs.join(', ')}).
				{/if}
				Your original files are never touched.
			{/if}
		</AlertDialog.Description>

		{#if sweepPreview && !sweepPreview.skippedReason && sweepPreview.removed.length > 0}
			<div class="max-h-40 overflow-y-auto rounded-md border bg-muted/30 p-2 font-mono text-xs">
				{#each sweepPreview.removed.slice(0, 100) as p (p)}
					<p class="truncate">{p}</p>
				{/each}
				{#if sweepPreview.removed.length > 100}
					<p class="text-muted-foreground">…and {sweepPreview.removed.length - 100} more</p>
				{/if}
			</div>
		{/if}

		{#if sweepPreview?.staticAssetsMode}
			<p
				class="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm"
			>
				<TriangleAlert class="mt-0.5 size-4 shrink-0 text-amber-600" />
				<span>
					This workspace stores blobs as static assets, so a site you already deployed may still be
					requesting these files. It's safest to sweep right after your next export.
				</span>
			</p>
		{/if}

		<div class="mt-4 flex justify-end gap-2">
			<AlertDialog.Cancel type="button">Cancel</AlertDialog.Cancel>
			{#if sweepPreview && !sweepPreview.skippedReason && sweepPreview.removed.length > 0}
				<Button variant="destructive" type="button" disabled={sweepBusy} onclick={runSweep}>
					{#if sweepBusy}<Loader2 class="size-4 animate-spin" />{/if}
					Delete {sweepPreview.removed.length} file{sweepPreview.removed.length === 1 ? '' : 's'}
				</Button>
			{/if}
		</div>
	</AlertDialog.Content>
</AlertDialog.Root>
