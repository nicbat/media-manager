import { error } from '@sveltejs/kit';

/** Collection ids and post slugs are single path segments — reject anything with traversal potential. */
const SAFE_SEGMENT = /^[a-zA-Z0-9_-]+$/;

/**
 * Validate a collection id or post slug from a route param (Item 14). Rejects empty strings and any
 * character outside `[a-zA-Z0-9_-]` (the same guard `imageRepo` applies to typeIds), so a `.md` path
 * can never traverse outside its collection. Throws a 400 on failure.
 *
 * @param value - The raw route param.
 * @param label - What is being validated (for the error message).
 * @returns The validated value.
 */
export function assertSafeSegment(value: string, label: string): string {
	if (!value || !SAFE_SEGMENT.test(value)) throw error(400, `Invalid ${label}`);
	return value;
}
