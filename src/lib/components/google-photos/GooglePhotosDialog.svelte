<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { ExternalLink, Loader2, CheckCircle2, AlertTriangle } from 'lucide-svelte';
	import { toast } from 'svelte-sonner';
	import {
		apiGetGooglePhotosStatus,
		apiSaveGoogleCredentials,
		apiSaveGoogleOAuthLink,
		apiStartGoogleAuth,
		apiCreateGooglePhotosSession,
		apiPollGooglePhotosSession,
		apiImportGooglePhotos,
		type GoogleStatus,
		type ImportResult
	} from '$lib/api/googlePhotos.js';

	/**
	 * The Google Photos import wizard (Item 37): a single `Dialog` that walks the user through the
	 * connection state machine — first-run setup (bring-your-own creds) → connect (OAuth in a new tab)
	 * → pick (Google's hosted picker in a new tab) → import → done. State is seeded from
	 * `/api/google-photos/status` on open; imported photos land in All Files unclassified, so on
	 * success the host reloads its grid via {@link onImported}.
	 *
	 * @param open - Bindable open state (the host's "⋮ More → Import from Google Photos…" toggles it).
	 * @param onImported - Called with the imported count after a successful import (host reloads).
	 */
	let {
		open = $bindable(false),
		onImported
	}: {
		open?: boolean;
		onImported?: (count: number) => void;
	} = $props();

	type View = 'loading' | 'setup' | 'connect' | 'ready' | 'picking' | 'importing' | 'done';
	let view = $state<View>('loading');
	let error = $state<string | null>(null);
	let busy = $state(false);

	// Setup form
	let clientId = $state('');
	let clientSecret = $state('');

	// Saved shortcut to the project's Google Cloud Credentials page (seeded from status).
	let oauthLink = $state('');
	let savingLink = $state(false);

	// Connection / Testing-mode hint
	let status = $state<GoogleStatus | null>(null);

	// Import result
	let result = $state<ImportResult | null>(null);

	/** A monotonic token to cancel in-flight polling loops when the dialog closes or advances. */
	let runToken = 0;

	/** Seed the view from server status whenever the dialog opens. */
	$effect(() => {
		if (open) {
			void refreshStatus(true);
		} else {
			runToken++; // cancel any polling
			error = null;
			result = null;
		}
	});

	/** Fetch status and (optionally) route to the right starting view. */
	async function refreshStatus(route: boolean): Promise<GoogleStatus | null> {
		try {
			const s = await apiGetGooglePhotosStatus();
			status = s;
			if (!oauthLink) oauthLink = s.oauthProjectUrl ?? '';
			if (route) {
				view = !s.hasCreds ? 'setup' : !s.connected ? 'connect' : 'ready';
			}
			return s;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load status';
			return null;
		}
	}

	async function saveCredentials() {
		error = null;
		if (!clientId.trim() || !clientSecret.trim()) {
			error = 'Enter both the Client ID and secret.';
			return;
		}
		busy = true;
		try {
			await apiSaveGoogleCredentials(clientId.trim(), clientSecret.trim());
			clientSecret = '';
			await refreshStatus(true);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to save credentials';
		} finally {
			busy = false;
		}
	}

	/** Persist (or clear) the saved shortcut to the project's Credentials page. */
	async function saveOAuthLink() {
		error = null;
		savingLink = true;
		try {
			await apiSaveGoogleOAuthLink(oauthLink.trim());
			await refreshStatus(false);
			toast.success('Saved credentials link');
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to save the link';
		} finally {
			savingLink = false;
		}
	}

	async function connect() {
		error = null;
		busy = true;
		const token = ++runToken;
		try {
			const authUrl = await apiStartGoogleAuth();
			window.open(authUrl, '_blank', 'noopener');
			view = 'connect';
			// Poll status until the loopback callback stores the refresh token (~3 min budget).
			const deadline = Date.now() + 3 * 60_000;
			while (Date.now() < deadline && token === runToken) {
				await sleep(2000);
				if (token !== runToken) return;
				const s = await refreshStatus(false);
				if (s?.connected) {
					view = 'ready';
					toast.success('Connected to Google Photos');
					return;
				}
			}
			if (token === runToken) error = 'Timed out waiting for Google sign-in. Try again.';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Sign-in failed';
		} finally {
			if (token === runToken) busy = false;
		}
	}

	async function pickAndImport() {
		error = null;
		result = null;
		busy = true;
		const token = ++runToken;
		try {
			const session = await apiCreateGooglePhotosSession();
			window.open(session.pickerUri, '_blank', 'noopener');
			view = 'picking';
			// Poll the session until the user finishes selecting (~10 min budget).
			const deadline = Date.now() + 10 * 60_000;
			let ready = false;
			while (Date.now() < deadline && token === runToken) {
				await sleep(session.pollIntervalMs);
				if (token !== runToken) return;
				ready = await apiPollGooglePhotosSession(session.sessionId);
				if (ready) break;
			}
			if (token !== runToken) return;
			if (!ready) {
				error = 'Timed out waiting for you to finish picking. Try again.';
				view = 'ready';
				return;
			}
			view = 'importing';
			const res = await apiImportGooglePhotos(session.sessionId);
			if (token !== runToken) return;
			result = res;
			view = 'done';
			if (res.imported > 0) onImported?.(res.imported);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Import failed';
			view = 'ready';
		} finally {
			if (token === runToken) busy = false;
		}
	}

	function sleep(ms: number): Promise<void> {
		return new Promise((r) => setTimeout(r, ms));
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Import from Google Photos</Dialog.Title>
			{#if status?.connected && status.expiresInDays !== null}
				<Dialog.Description>
					Connected · sign-in expires in ~{status.expiresInDays} day{status.expiresInDays === 1
						? ''
						: 's'} (Testing mode). Set your consent screen to “In production” to avoid weekly re-login.
				</Dialog.Description>
			{/if}
		</Dialog.Header>

		{#if error}
			<div class="flex items-start gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
				<AlertTriangle class="mt-0.5 size-4 shrink-0" />
				<span>{error}</span>
			</div>
		{/if}

		{#if view === 'loading'}
			<div class="flex items-center gap-2 py-8 text-muted-foreground">
				<Loader2 class="size-4 animate-spin" /> Loading…
			</div>
		{:else if view === 'setup'}
			<div class="space-y-3 text-sm">
				<p class="text-muted-foreground">
					One-time setup. You’ll use <b>your own</b> Google credentials — nothing is shared with
					anyone, and they’re stored locally in <code>media/google.json</code>.
				</p>
				<ol class="list-decimal space-y-1 pl-5 text-muted-foreground">
					<li>
						Open the
						<a
							href="https://console.cloud.google.com/"
							target="_blank"
							rel="noopener"
							class="inline-flex items-center gap-1 font-medium text-primary hover:underline"
						>
							Google Cloud Console <ExternalLink class="size-3" />
						</a>
						→ create a project.
					</li>
					<li>APIs &amp; Services → Library → enable the <b>Google Photos Picker API</b>.</li>
					<li>
						OAuth consent screen → External; add yourself as a test user (or set “In production” for
						long-lived sign-in).
					</li>
					<li>Credentials → Create OAuth client ID → <b>Desktop app</b>.</li>
				</ol>
				<div class="space-y-1">
					<Label for="gp-client-id">Client ID</Label>
					<Input
						id="gp-client-id"
						bind:value={clientId}
						placeholder="…apps.googleusercontent.com"
					/>
				</div>
				<div class="space-y-1">
					<Label for="gp-client-secret">Client secret</Label>
					<Input id="gp-client-secret" type="password" bind:value={clientSecret} />
				</div>
				<div class="space-y-1.5 rounded-md border p-3">
					<div class="flex items-center justify-between gap-2">
						<Label for="gp-oauth-link">Your credentials page</Label>
						{#if status?.oauthProjectUrl}
							<a
								href={status.oauthProjectUrl}
								target="_blank"
								rel="noopener"
								class="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
							>
								<ExternalLink class="size-3" /> Open
							</a>
						{/if}
					</div>
					<p class="text-xs text-muted-foreground">
						Save a shortcut straight to this project’s Credentials page so regenerating a client
						secret is one click next time.
					</p>
					<div class="flex gap-2">
						<Input
							id="gp-oauth-link"
							bind:value={oauthLink}
							placeholder="https://console.cloud.google.com/apis/credentials?project=…"
						/>
						<Button variant="outline" onclick={saveOAuthLink} disabled={savingLink}>
							{#if savingLink}<Loader2 class="size-4 animate-spin" />{/if} Save
						</Button>
					</div>
				</div>
			</div>
			<Dialog.Footer>
				<Button onclick={saveCredentials} disabled={busy}>
					{#if busy}<Loader2 class="size-4 animate-spin" />{/if} Save &amp; continue
				</Button>
			</Dialog.Footer>
		{:else if view === 'connect'}
			<div class="space-y-3 py-2 text-sm text-muted-foreground">
				<p>
					Sign in with Google in the new tab — approve access (you may see an “unverified app”
					screen; click <b>Advanced → Go to…</b>), then come back here.
				</p>
				{#if busy}
					<div class="flex items-center gap-2">
						<Loader2 class="size-4 animate-spin" /> Waiting for Google…
					</div>
				{/if}
				<p class="text-xs">
					Make sure your OAuth client is a <b>Desktop app</b> (it has no “redirect URI” field). A “Web
					application” client won’t work with the loopback sign-in.
				</p>
				{#if status?.oauthProjectUrl}
					<a
						href={status.oauthProjectUrl}
						target="_blank"
						rel="noopener"
						class="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
					>
						<ExternalLink class="size-3" /> Open my credentials page
					</a>
				{/if}
			</div>
			<Dialog.Footer class="sm:justify-between">
				<Button variant="ghost" size="sm" disabled={busy} onclick={() => (view = 'setup')}>
					Change credentials…
				</Button>
				<Button onclick={connect} disabled={busy}>
					<ExternalLink class="size-4" /> Sign in with Google
				</Button>
			</Dialog.Footer>
		{:else if view === 'ready'}
			<div class="space-y-3 py-2 text-sm text-muted-foreground">
				<p>
					Click below to open Google’s photo picker in a new tab. Hand-pick the photos you want —
					they’ll import into <b>All Files</b> (unclassified). Finish picking within ~60 minutes.
				</p>
			</div>
			<Dialog.Footer class="sm:justify-between">
				<Button variant="ghost" size="sm" onclick={() => (view = 'setup')}
					>Manage connection…</Button
				>
				<Button onclick={pickAndImport} disabled={busy}>
					<ExternalLink class="size-4" /> Pick photos
				</Button>
			</Dialog.Footer>
		{:else if view === 'picking'}
			<div class="flex items-center gap-2 py-8 text-muted-foreground">
				<Loader2 class="size-4 animate-spin" /> Waiting for you to finish picking in Google’s tab…
			</div>
		{:else if view === 'importing'}
			<div class="flex items-center gap-2 py-8 text-muted-foreground">
				<Loader2 class="size-4 animate-spin" /> Downloading &amp; importing…
			</div>
		{:else if view === 'done' && result}
			<div class="space-y-3 py-2 text-sm">
				<div class="flex items-center gap-2 text-green-600">
					<CheckCircle2 class="size-5" />
					<span>Imported {result.imported} photo{result.imported === 1 ? '' : 's'}.</span>
				</div>
				{#if result.failed > 0}
					<div class="rounded-md bg-destructive/10 p-3 text-destructive">
						<div class="flex items-center gap-2 font-medium">
							<AlertTriangle class="size-4" />
							{result.failed} failed
						</div>
						<ul class="mt-1 list-disc pl-5 text-xs">
							{#each result.failures.slice(0, 8) as f (f.filename)}
								<li>{f.filename}: {f.reason}</li>
							{/each}
						</ul>
					</div>
				{/if}
			</div>
			<Dialog.Footer class="sm:justify-between">
				<Button variant="ghost" onclick={() => (view = 'ready')}>Import more</Button>
				<Button onclick={() => (open = false)}>Done</Button>
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>
