import { error } from '@sveltejs/kit';

/**
 * Parse a required JSON mutation body, reporting malformed client input as HTTP 400.
 * Call before storage writes; schema validation remains the route's responsibility.
 * Network/body stream failures other than invalid JSON retain their original error.
 */
export async function readJsonBody(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch (err) {
		if (err instanceof SyntaxError) throw error(400, 'Malformed JSON request body');
		throw err;
	}
}
