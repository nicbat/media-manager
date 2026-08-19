import { describe, it, expect } from 'vitest';
import { resolveRangeSelection } from './rangeSelect.js';

const ordered = ['a', 'b', 'c', 'd', 'e'];

describe('resolveRangeSelection', () => {
	it('selects the inclusive span between anchor and target', () => {
		const r = resolveRangeSelection({
			ordered,
			anchorId: 'b',
			targetId: 'd',
			previousRange: []
		});
		expect(r.range).toEqual(['b', 'c', 'd']);
		expect(r.deselect).toEqual([]);
	});

	it('works backwards (target above the anchor)', () => {
		const r = resolveRangeSelection({
			ordered,
			anchorId: 'd',
			targetId: 'b',
			previousRange: []
		});
		expect(r.range).toEqual(['b', 'c', 'd']);
	});

	it('gives back the abandoned tail when a range is re-extended shorter', () => {
		const first = resolveRangeSelection({
			ordered,
			anchorId: 'a',
			targetId: 'e',
			previousRange: []
		});
		expect(first.range).toEqual(['a', 'b', 'c', 'd', 'e']);

		const shrunk = resolveRangeSelection({
			ordered,
			anchorId: 'a',
			targetId: 'c',
			previousRange: first.range
		});
		expect(shrunk.range).toEqual(['a', 'b', 'c']);
		expect(shrunk.deselect).toEqual(['d', 'e']);
	});

	it('keeps everything when a range is re-extended longer', () => {
		const r = resolveRangeSelection({
			ordered,
			anchorId: 'a',
			targetId: 'e',
			previousRange: ['a', 'b']
		});
		expect(r.range).toEqual(['a', 'b', 'c', 'd', 'e']);
		expect(r.deselect).toEqual([]);
	});

	it('re-extending across the anchor gives back the old side', () => {
		const r = resolveRangeSelection({
			ordered,
			anchorId: 'c',
			targetId: 'a',
			previousRange: ['c', 'd', 'e']
		});
		expect(r.range).toEqual(['a', 'b', 'c']);
		expect(r.deselect).toEqual(['d', 'e']);
	});

	it('is a no-op without an anchor, on a self-click, or with a stale anchor', () => {
		expect(
			resolveRangeSelection({ ordered, anchorId: null, targetId: 'c', previousRange: [] }).range
		).toEqual([]);
		expect(
			resolveRangeSelection({ ordered, anchorId: 'c', targetId: 'c', previousRange: [] }).range
		).toEqual([]);
		// Anchor filtered away since it was clicked ⇒ no position to measure from.
		expect(
			resolveRangeSelection({ ordered, anchorId: 'zz', targetId: 'c', previousRange: [] }).range
		).toEqual([]);
	});
});
