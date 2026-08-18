import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getAccessToken, getSession } from '$lib/server/googlePhotos.js';

/** GET: poll a Picker session. `ready` flips true once the user finishes selecting photos. */
export const GET: RequestHandler = async ({ params }) => {
	try {
		const accessToken = await getAccessToken();
		const session = await getSession(accessToken, params.id);
		return json({ ready: session.mediaItemsSet === true });
	} catch (err) {
		// Log the whole error (incl. undici's nested `cause`) — the HTTP body only carries `.message`.
		console.error('[google-photos] poll failed for session', params.id, err);
		throw error(400, (err as Error).message);
	}
};
