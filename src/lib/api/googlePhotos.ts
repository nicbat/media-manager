import { z } from 'zod';

/** Client wrappers for the `/api/google-photos/*` surface (Item 37). */

async function jsonOrThrow<S extends z.ZodTypeAny>(
	res: Response,
	schema: S,
	msg: string
): Promise<z.infer<S>> {
	if (!res.ok) {
		let details = '';
		try {
			details = await res.text();
		} catch {
			/* ignore */
		}
		throw new Error(`${msg} (status ${res.status})${details ? `: ${details}` : ''}`);
	}
	return schema.parse(await res.json());
}

export const GoogleStatusSchema = z.object({
	hasCreds: z.boolean(),
	connected: z.boolean(),
	tokenObtainedAt: z.string().nullable(),
	expiresInDays: z.number().nullable(),
	oauthProjectUrl: z.string().nullable()
});
export type GoogleStatus = z.infer<typeof GoogleStatusSchema>;

/** GET /api/google-photos/status — connection status for the dialog/badge. */
export async function apiGetGooglePhotosStatus(
	fetchFn: typeof fetch = fetch
): Promise<GoogleStatus> {
	const res = await fetchFn('/api/google-photos/status');
	return jsonOrThrow(res, GoogleStatusSchema, 'Failed to load Google Photos status');
}

/** POST /api/google-photos/credentials — save the bring-your-own Client ID + secret. */
export async function apiSaveGoogleCredentials(
	clientId: string,
	clientSecret: string,
	fetchFn: typeof fetch = fetch
): Promise<void> {
	const res = await fetchFn('/api/google-photos/credentials', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ clientId, clientSecret })
	});
	await jsonOrThrow(res, z.object({ success: z.literal(true) }), 'Failed to save credentials');
}

/**
 * PATCH /api/google-photos/credentials — save (or clear) the shortcut to the project's Credentials page.
 *
 * @param oauthProjectUrl - An `https://console.cloud.google.com/…` URL, or an empty string to clear it.
 */
export async function apiSaveGoogleOAuthLink(
	oauthProjectUrl: string,
	fetchFn: typeof fetch = fetch
): Promise<void> {
	const res = await fetchFn('/api/google-photos/credentials', {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ oauthProjectUrl })
	});
	await jsonOrThrow(
		res,
		z.object({ success: z.literal(true) }),
		'Failed to save the credentials link'
	);
}

/** POST /api/google-photos/auth/start — get the consent URL to open in a new tab. */
export async function apiStartGoogleAuth(fetchFn: typeof fetch = fetch): Promise<string> {
	const res = await fetchFn('/api/google-photos/auth/start', { method: 'POST' });
	const data = await jsonOrThrow(
		res,
		z.object({ authUrl: z.string() }),
		'Failed to start Google sign-in'
	);
	return data.authUrl;
}

export const PickerSessionSchema = z.object({
	sessionId: z.string(),
	pickerUri: z.string(),
	pollIntervalMs: z.number()
});
export type PickerSession = z.infer<typeof PickerSessionSchema>;

/** POST /api/google-photos/session — create a Picker session. */
export async function apiCreateGooglePhotosSession(
	fetchFn: typeof fetch = fetch
): Promise<PickerSession> {
	const res = await fetchFn('/api/google-photos/session', { method: 'POST' });
	return jsonOrThrow(res, PickerSessionSchema, 'Failed to create picker session');
}

/** GET /api/google-photos/session/[id] — poll whether the user finished picking. */
export async function apiPollGooglePhotosSession(
	sessionId: string,
	fetchFn: typeof fetch = fetch
): Promise<boolean> {
	const res = await fetchFn(`/api/google-photos/session/${encodeURIComponent(sessionId)}`);
	const data = await jsonOrThrow(res, z.object({ ready: z.boolean() }), 'Failed to poll session');
	return data.ready;
}

export const ImportResultSchema = z.object({
	imported: z.number(),
	failed: z.number(),
	fileIds: z.array(z.string()),
	failures: z.array(z.object({ filename: z.string(), reason: z.string() }))
});
export type ImportResult = z.infer<typeof ImportResultSchema>;

/** POST /api/google-photos/import — download + register the picked photos. */
export async function apiImportGooglePhotos(
	sessionId: string,
	fetchFn: typeof fetch = fetch
): Promise<ImportResult> {
	const res = await fetchFn('/api/google-photos/import', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ sessionId })
	});
	return jsonOrThrow(res, ImportResultSchema, 'Import failed');
}
