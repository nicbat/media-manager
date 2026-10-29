/**
 * Capture only locally edited fields for a partial update, preserving untouched concurrent changes.
 * Pending keys must be resent even when reverted to the confirmed baseline: an older request can
 * still put the prior draft on disk. Clone nested values before queueing so later edits cannot
 * change the request. Unknown pending keys (removed from the schema) are excluded.
 */
export function dirtyFieldPatch(
	current: Record<string, unknown>,
	confirmed: Record<string, unknown>,
	pendingKeys: string[] = []
): Record<string, unknown> {
	const pending = new Set(pendingKeys);
	return JSON.parse(
		JSON.stringify(
			Object.fromEntries(
				Object.entries(current).filter(
					([key, value]) =>
						pending.has(key) || JSON.stringify(value) !== JSON.stringify(confirmed[key])
				)
			)
		)
	);
}
