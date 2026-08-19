/**
 * Shift-click range selection, as a pure function so both multiselect hosts (the files hub and the
 * records list) share one set of semantics — and so those semantics are unit-testable without a DOM.
 *
 * The model is the familiar file-manager one:
 * - A plain click sets the **anchor** (and clears any live shift-range).
 * - A shift-click selects every item between the anchor and the clicked item **inclusive**, in the
 *   host's visual order — which is the flattened group order when grouping is on, so a range can span
 *   group boundaries exactly as the eye reads it.
 * - The anchor does **not** move on a shift-click, so repeated shift-clicks re-extend from the same
 *   origin. Re-extending shorter therefore has to give the abandoned tail back: `deselect` carries the
 *   ids that were in the previous shift-range but are not in the new one, so shrinking a range works
 *   instead of leaving a stuck selection behind.
 *
 * Only the previous shift-range is ever given back — never an arbitrary earlier selection — so a
 * shift-click can't silently discard files the user picked one by one somewhere else in the list.
 */

/** Inputs describing one shift-click, in the host's current visual order. */
export interface RangeSelectionInput {
	/** Every selectable id in visual order (flattened across groups when grouped). */
	ordered: string[];
	/** The last plainly-clicked id — the range's fixed origin. */
	anchorId: string | null;
	/** The shift-clicked id. */
	targetId: string;
	/** The range produced by the previous consecutive shift-click (empty if the last click was plain). */
	previousRange: string[];
}

/** What the host should apply: select `range`, deselect `deselect`, remember `range` as the new live range. */
export interface RangeSelectionResult {
	range: string[];
	deselect: string[];
}

/**
 * Resolve a shift-click into the ids to select and the ids to give back.
 *
 * Use case: `files/+page.svelte` and `media/+page.svelte` call this from their `toggleSelect(id,
 * shiftKey)` when `shiftKey` is held and an anchor exists; an empty `range` means "not a valid range
 * click" (no anchor, anchor scrolled out of the current filter, or anchor === target) and the caller
 * should fall back to a plain toggle.
 *
 * @param input - See {@link RangeSelectionInput}.
 * @returns `{ range, deselect }`; both empty when the click can't be interpreted as a range.
 *
 * Concerns / future improvements: `ordered.indexOf` is linear, so a shift-click is O(n) over the
 * visible list — irrelevant at the current unpaginated sizes, but if the grid ever virtualizes over
 * very large catalogs this should take a precomputed index map instead.
 */
export function resolveRangeSelection(input: RangeSelectionInput): RangeSelectionResult {
	const { ordered, anchorId, targetId, previousRange } = input;
	if (!anchorId || anchorId === targetId) return { range: [], deselect: [] };

	const from = ordered.indexOf(anchorId);
	const to = ordered.indexOf(targetId);
	// A stale anchor (filtered/searched away since it was clicked) has no position to measure from.
	if (from === -1 || to === -1) return { range: [], deselect: [] };

	const range = ordered.slice(Math.min(from, to), Math.max(from, to) + 1);
	const keep = new Set(range);
	// Hand back only what this same shift-gesture selected a moment ago — never a manual selection.
	const deselect = previousRange.filter((id) => !keep.has(id));
	return { range, deselect };
}
