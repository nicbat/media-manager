import * as fs from 'node:fs/promises';
import { getGoogleConfigPath } from './paths.js';
import { readJsonFile, writeJsonFileAtomic } from './json.js';
import { withFileLock } from './lock.js';

/**
 * Persistence for the Google Photos integration config (`<root>/media/google.json`).
 *
 * Use case:
 * - Stores the user's **bring-your-own** OAuth client id/secret and (once connected) the refresh
 *   token. This is the only secret-bearing file in a workspace, so it is written `0600` and must
 *   never be committed or seeded into `test-fixtures/` (Item 37).
 *
 * Concerns / future improvements:
 * - The client secret for a Desktop OAuth client is not truly confidential, but `0600` is cheap
 *   defense-in-depth. The secret may alternatively be supplied via `GOOGLE_CLIENT_SECRET` (see
 *   {@link readGoogleConfig}).
 */

/** On-disk shape of `media/google.json`. */
export interface GoogleConfig {
	/** OAuth 2.0 client id (`*.apps.googleusercontent.com`). */
	clientId?: string;
	/** OAuth 2.0 client secret (Desktop client). Optional — may come from `GOOGLE_CLIENT_SECRET`. */
	clientSecret?: string;
	/** Long-lived refresh token, present once the user has connected. */
	refreshToken?: string;
	/** ISO timestamp the refresh token was obtained — drives the 7-day Testing-mode expiry hint. */
	tokenObtainedAt?: string;
	/**
	 * A saved shortcut straight to this project's Google Cloud **Credentials** page, so regenerating an
	 * OAuth client is one click. Optional and user-editable; when absent the UI derives a default from
	 * the client id's project-number prefix. Must be an `https://console.cloud.google.com/…` URL.
	 */
	oauthProjectUrl?: string;
}

/** Lock file guarding concurrent reads/writes of `google.json`. */
function lockPath(): string {
	return `${getGoogleConfigPath()}.lock`;
}

/**
 * Read the Google config, folding in `GOOGLE_CLIENT_SECRET` from the environment when the on-disk
 * secret is absent.
 *
 * @returns The parsed config, or `null` when the file does not exist yet.
 */
export async function readGoogleConfig(): Promise<GoogleConfig | null> {
	let raw: GoogleConfig | null = null;
	try {
		raw = (await readJsonFile(getGoogleConfigPath())) as GoogleConfig;
	} catch (err) {
		const e = err as NodeJS.ErrnoException;
		if (e.code === 'ENOENT') return null;
		throw err;
	}
	const envSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
	if (!raw.clientSecret && envSecret) raw = { ...raw, clientSecret: envSecret };
	return raw;
}

/**
 * Overwrite the Google config atomically and re-assert `0600` perms.
 *
 * @param cfg - The full config to persist.
 */
export async function writeGoogleConfig(cfg: GoogleConfig): Promise<void> {
	const filePath = getGoogleConfigPath();
	await writeJsonFileAtomic(filePath, cfg);
	await fs.chmod(filePath, 0o600).catch(() => {
		/* best-effort on platforms without POSIX perms (e.g. Windows) */
	});
}

/**
 * Read-modify-write the Google config under the file lock (so a `credentials` write and an OAuth
 * `callback` write can't clobber each other).
 *
 * @param patch - Receives the current config (or `{}`) and returns the next one.
 */
export async function updateGoogleConfig(
	patch: (current: GoogleConfig) => GoogleConfig
): Promise<GoogleConfig> {
	return withFileLock(lockPath(), async () => {
		const current = (await readGoogleConfig()) ?? {};
		const next = patch(current);
		await writeGoogleConfig(next);
		return next;
	});
}
