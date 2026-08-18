import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library';
import { randomUUID } from 'node:crypto';
import * as http from 'node:http';
import * as net from 'node:net';
import { readGoogleConfig, updateGoogleConfig } from '$lib/storage/googleConfig.js';

/**
 * Server-side Google Photos integration (Item 37): OAuth 2.0 loopback + PKCE and the Photos
 * **Picker API** REST dance (create session → poll → list → download → cleanup).
 *
 * Design notes:
 * - **Bring-your-own credentials.** The OAuth client id/secret come from `media/google.json`
 *   ({@link readGoogleConfig}); the user creates their own Google Cloud **Desktop** client, so no
 *   app-wide verification applies (the Picker scope is *sensitive*, not *restricted* — no CASA).
 * - **Dedicated loopback listener.** {@link startLoopbackAuth} spins a throwaway raw HTTP server on a
 *   free `127.0.0.1:<port>` and uses `http://127.0.0.1:<port>` as the OAuth redirect. This is the
 *   exact form Google's Desktop-client loopback flow auto-accepts (no port pre-registration) — and it
 *   is **decoupled from however the app itself is served** (https / `localhost` / a proxy would all
 *   produce a redirect Google rejects, which is why reusing the app origin does not work). The
 *   listener handles the callback in-process, persists the refresh token, then closes.
 * - **Single-node only**, like the rest of the storage layer.
 */

/** The only OAuth scope needed — read-only access to items the user hand-picks in the Picker. */
export const PICKER_SCOPE = 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly';

/** Base URL for the Google Photos Picker REST API. */
const PICKER_API = 'https://photospicker.googleapis.com/v1';

/** Grab a free ephemeral TCP port on the loopback interface (for the OAuth callback listener). */
function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.on('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const addr = srv.address();
			const port = typeof addr === 'object' && addr ? addr.port : 0;
			srv.close(() => resolve(port));
		});
	});
}

/** Render the minimal "you can close this tab" page shown in the OAuth popup after the redirect. */
function callbackPage(title: string, message: string, ok: boolean): string {
	const color = ok ? '#16a34a' : '#dc2626';
	return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#0b0b0c;color:#e5e5e5}
.card{text-align:center;max-width:30rem;padding:2rem}h1{color:${color};font-size:1.25rem}p{color:#a3a3a3}</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p><p>You can close this tab and return to media-manager.</p></div>
<script>setTimeout(()=>window.close(),1500)</script></body></html>`;
}

/** Build an OAuth2 client from stored credentials, optionally bound to a redirect URI. */
async function getOAuthClient(redirectUri?: string): Promise<OAuth2Client> {
	const cfg = await readGoogleConfig();
	if (!cfg?.clientId || !cfg.clientSecret) {
		throw new Error('Google credentials are not configured. Add a Client ID and secret first.');
	}
	return new OAuth2Client({
		clientId: cfg.clientId,
		clientSecret: cfg.clientSecret,
		redirectUri
	});
}

/** Connection status for the UI: whether creds exist, whether connected, and the Testing-mode expiry hint. */
export interface GoogleStatus {
	hasCreds: boolean;
	connected: boolean;
	tokenObtainedAt: string | null;
	/** Days until the 7-day Testing-mode refresh-token expiry (clamped ≥0); null when not connected. */
	expiresInDays: number | null;
	/**
	 * The effective shortcut to the project's Google Cloud **Credentials** page: the user's saved
	 * `oauthProjectUrl` if set, else a default derived from the client id's project-number prefix, else
	 * `null` when we have neither. The dialog renders it as a one-click "Open my credentials page".
	 */
	oauthProjectUrl: string | null;
}

/**
 * Derive a best-effort deep link to a project's Credentials page from an OAuth client id.
 *
 * A Desktop client id looks like `123456789012-abc.apps.googleusercontent.com`; the leading digits are
 * the Google Cloud **project number**, which the console accepts in a `?project=` query. This lets us
 * offer a working shortcut even before the user saves a custom one.
 *
 * @param clientId - The stored OAuth client id (may be undefined).
 * @returns The derived console URL, or `null` when no project-number prefix can be read.
 */
export function deriveProjectCredentialsUrl(clientId: string | undefined): string | null {
	const projectNumber = clientId?.match(/^(\d+)-/)?.[1];
	if (!projectNumber) return null;
	return `https://console.cloud.google.com/apis/credentials?project=${projectNumber}`;
}

/**
 * Report the integration's status for the dialog/toolbar badge.
 *
 * The 7-day hint assumes "Testing" publishing status (the conservative default); a user who has set
 * their consent screen to "In production" gets a long-lived token and can ignore it.
 */
export async function getStatus(): Promise<GoogleStatus> {
	const cfg = await readGoogleConfig();
	const hasCreds = Boolean(cfg?.clientId && cfg.clientSecret);
	const connected = Boolean(cfg?.refreshToken);
	const tokenObtainedAt = cfg?.tokenObtainedAt ?? null;
	let expiresInDays: number | null = null;
	if (connected && tokenObtainedAt) {
		const ageDays = (Date.now() - new Date(tokenObtainedAt).getTime()) / 86_400_000;
		expiresInDays = Math.max(0, Math.ceil(7 - ageDays));
	}
	const oauthProjectUrl =
		cfg?.oauthProjectUrl?.trim() || deriveProjectCredentialsUrl(cfg?.clientId);
	return { hasCreds, connected, tokenObtainedAt, expiresInDays, oauthProjectUrl };
}

/**
 * Begin the OAuth flow: start a throwaway `http://127.0.0.1:<port>` listener, build the PKCE consent
 * URL pointed at it, and return that URL for the client to open in a new tab. The listener catches
 * Google's redirect, exchanges the code, persists the refresh token, shows a "close this tab" page,
 * and then shuts itself down (or times out after 5 minutes). The dialog detects success by polling
 * {@link getStatus}.
 *
 * @returns The consent `authUrl`.
 * @throws When credentials are missing or a loopback port can't be bound.
 */
export async function startLoopbackAuth(): Promise<{ authUrl: string }> {
	const port = await findFreePort();
	const redirectUri = `http://127.0.0.1:${port}`;
	const client = await getOAuthClient(redirectUri);
	const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
	const state = randomUUID();
	const authUrl = client.generateAuthUrl({
		access_type: 'offline',
		prompt: 'consent', // force a refresh_token even on re-consent
		scope: [PICKER_SCOPE],
		code_challenge_method: CodeChallengeMethod.S256,
		code_challenge: codeChallenge,
		state
	});

	const server = http.createServer(async (req, res) => {
		const send = (status: number, title: string, message: string, ok: boolean) => {
			res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
			res.end(callbackPage(title, message, ok));
			close();
		};
		try {
			const reqUrl = new URL(req.url ?? '/', redirectUri);
			// Ignore favicon / unrelated probes so they don't tear down the listener.
			if (!reqUrl.searchParams.has('code') && !reqUrl.searchParams.has('error')) {
				res.writeHead(204).end();
				return;
			}
			const oauthError = reqUrl.searchParams.get('error');
			if (oauthError)
				return send(400, 'Connection cancelled', `Google reported: ${oauthError}`, false);
			const code = reqUrl.searchParams.get('code');
			if (!code || reqUrl.searchParams.get('state') !== state) {
				return send(
					400,
					'Connection failed',
					'Missing or mismatched authorization response.',
					false
				);
			}
			const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri });
			if (!tokens.refresh_token) {
				return send(
					400,
					'Connection failed',
					'Google did not return a refresh token. Revoke the app under your Google Account permissions and reconnect.',
					false
				);
			}
			await updateGoogleConfig((cur) => ({
				...cur,
				refreshToken: tokens.refresh_token ?? cur.refreshToken,
				tokenObtainedAt: new Date().toISOString()
			}));
			send(200, 'Connected to Google Photos', 'Your account is now linked.', true);
		} catch (err) {
			send(400, 'Connection failed', (err as Error).message, false);
		}
	});

	let timer: NodeJS.Timeout;
	function close() {
		clearTimeout(timer);
		server.close();
	}
	server.listen(port, '127.0.0.1');
	timer = setTimeout(() => server.close(), 5 * 60_000);
	timer.unref?.();

	return { authUrl };
}

/**
 * Mint a fresh access token from the stored refresh token (google-auth-library auto-refreshes).
 *
 * @throws When the app is not yet connected, or the refresh token has expired/been revoked.
 */
export async function getAccessToken(): Promise<string> {
	const cfg = await readGoogleConfig();
	if (!cfg?.refreshToken) throw new Error('Not connected to Google Photos.');
	const client = await getOAuthClient();
	client.setCredentials({ refresh_token: cfg.refreshToken });
	try {
		const { token } = await client.getAccessToken();
		if (!token) throw new Error('Google returned no access token.');
		return token;
	} catch (err) {
		throw new Error(
			`Google sign-in expired (refresh tokens last ~7 days in Testing mode). Please reconnect. [${(err as Error).message}]`
		);
	}
}

// ---- Picker REST ----------------------------------------------------------

/** A picking session as returned by `POST /v1/sessions`. */
export interface PickerSession {
	id: string;
	pickerUri: string;
	/** Present once the user has finished selecting in Google's hosted picker. */
	mediaItemsSet?: boolean;
	pollingConfig?: { pollInterval?: string; timeoutIn?: string };
}

/** One picked media item (subset of the Picker `mediaItems` shape we use). */
export interface PickedItem {
	id: string;
	type?: string;
	mediaFile?: { baseUrl?: string; mimeType?: string; filename?: string };
}

/**
 * Flatten a thrown `fetch` error into a message that names the actual failure.
 *
 * Node's `fetch` (undici) reports every transport-level problem as the useless `TypeError: fetch
 * failed` and hides the real reason — DNS failure, TLS error, `ECONNRESET`, a socket the peer closed
 * — one or more levels down the `cause` chain. Surfacing that chain is the difference between a
 * bug report that says "fetch failed" and one that says `ECONNRESET`.
 *
 * @param err The value thrown by `fetch`.
 * @returns A single-line description including every nested cause.
 */
function describeFetchError(err: unknown): string {
	const parts: string[] = [];
	let cur: unknown = err;
	for (let depth = 0; cur instanceof Error && depth < 5; depth++) {
		const code = (cur as NodeJS.ErrnoException).code;
		parts.push(`${cur.message}${code ? ` (${code})` : ''}`);
		cur = (cur as Error).cause;
	}
	return parts.length ? parts.join(' ← ') : String(err);
}

/** Per-attempt ceiling for a Picker call, so a hung socket can't stall a poll forever. */
const PICKER_TIMEOUT_MS = 20_000;

/**
 * Authenticated JSON call against the Picker API, with bounded retries on transient faults.
 *
 * Retries only when it is safe to do so: a transport-level failure (nothing reached Google, so
 * nothing was applied) or a 5xx **on an idempotent method**. A `POST /sessions` is never retried
 * after a response, since a duplicate would leak a second picking session.
 *
 * @param accessToken A fresh OAuth access token.
 * @param pathAndQuery Path appended to {@link PICKER_API}, e.g. `/sessions/abc`.
 * @param init Standard `fetch` init; `Authorization` is merged in.
 * @returns The successful `Response`.
 * @throws When every attempt fails — the message names the real transport error or the HTTP body.
 *
 * Concerns / future improvements:
 * - Backoff is a fixed short ramp, not jittered exponential; polling cadence already paces us.
 * - A 401 is not special-cased into a token refresh; {@link getAccessToken} mints per call.
 */
async function pickerFetch(
	accessToken: string,
	pathAndQuery: string,
	init?: RequestInit
): Promise<Response> {
	const method = (init?.method ?? 'GET').toUpperCase();
	const idempotent = method === 'GET' || method === 'DELETE';
	const attempts = 3;
	let lastError = '';

	for (let attempt = 1; attempt <= attempts; attempt++) {
		let res: Response;
		try {
			res = await fetch(`${PICKER_API}${pathAndQuery}`, {
				...init,
				headers: { Authorization: `Bearer ${accessToken}`, ...(init?.headers ?? {}) },
				signal: AbortSignal.timeout(PICKER_TIMEOUT_MS)
			});
		} catch (err) {
			// Transport-level: the request never got a response, so retrying is always safe.
			lastError = `network error on ${pathAndQuery}: ${describeFetchError(err)}`;
			if (attempt < attempts) {
				await new Promise((r) => setTimeout(r, 300 * attempt));
				continue;
			}
			throw new Error(`Picker API ${lastError}`);
		}

		if (res.ok) return res;

		const body = await res.text().catch(() => '');
		lastError = `Picker API ${res.status} on ${pathAndQuery}${body ? `: ${body}` : ''}`;
		if (res.status >= 500 && idempotent && attempt < attempts) {
			await new Promise((r) => setTimeout(r, 300 * attempt));
			continue;
		}
		throw new Error(lastError);
	}

	throw new Error(lastError || `Picker API request to ${pathAndQuery} failed`);
}

/** Create a picking session; the user opens `pickerUri` to select photos. */
export async function createSession(accessToken: string): Promise<PickerSession> {
	const res = await pickerFetch(accessToken, '/sessions', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: '{}'
	});
	return (await res.json()) as PickerSession;
}

/** Poll a session; `mediaItemsSet` flips true once the user finishes picking. */
export async function getSession(accessToken: string, id: string): Promise<PickerSession> {
	const res = await pickerFetch(accessToken, `/sessions/${encodeURIComponent(id)}`);
	return (await res.json()) as PickerSession;
}

/** Delete a session after import (avoids `RESOURCE_EXHAUSTED`). Best-effort. */
export async function deleteSession(accessToken: string, id: string): Promise<void> {
	await pickerFetch(accessToken, `/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(
		() => {}
	);
}

/** List every item the user picked in a session (paginated). */
export async function listPickedItems(
	accessToken: string,
	sessionId: string
): Promise<PickedItem[]> {
	const items: PickedItem[] = [];
	let pageToken: string | undefined;
	do {
		const q = new URLSearchParams({ sessionId, pageSize: '100' });
		if (pageToken) q.set('pageToken', pageToken);
		const res = await pickerFetch(accessToken, `/mediaItems?${q.toString()}`);
		const data = (await res.json()) as { mediaItems?: PickedItem[]; nextPageToken?: string };
		if (data.mediaItems) items.push(...data.mediaItems);
		pageToken = data.nextPageToken;
	} while (pageToken);
	return items;
}

/**
 * Download a picked item's full-resolution bytes.
 *
 * Appends `=d` to the item's `baseUrl` (full-res download) with the OAuth bearer header. Note Google
 * strips **GPS/location** EXIF on `=d`; all other EXIF is retained. `baseUrl`s expire ~60 min after
 * picking, so this must run promptly.
 */
export async function downloadPickedItem(item: PickedItem, accessToken: string): Promise<Buffer> {
	const baseUrl = item.mediaFile?.baseUrl;
	if (!baseUrl) throw new Error('Picked item has no downloadable baseUrl.');
	const res = await fetch(`${baseUrl}=d`, {
		headers: { Authorization: `Bearer ${accessToken}` }
	});
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`Download failed ${res.status}${body ? `: ${body}` : ''}`);
	}
	return Buffer.from(await res.arrayBuffer());
}
