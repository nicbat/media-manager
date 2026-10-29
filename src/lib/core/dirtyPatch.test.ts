import { describe, expect, it } from 'vitest';
import { dirtyFieldPatch } from './dirtyPatch.js';

describe('partial queued editor updates', () => {
	it('keeps an untouched linked reference out of a body edit, including empty/false values', () => {
		expect(
			dirtyFieldPatch(
				{ body: 'draft', photos: [], done: false },
				{ body: 'saved', photos: [], done: true }
			)
		).toEqual({ body: 'draft', done: false });
	});
	it('resends a revert while an older body write is pending without resending unrelated fields', () => {
		expect(
			dirtyFieldPatch({ body: 'saved', photos: [] }, { body: 'saved', photos: [] }, [
				'body',
				'removed'
			])
		).toEqual({ body: 'saved' });
	});
	it('captures nested values before subsequent list edits mutate the form', () => {
		const form = { links: [{ url: 'https://example.com', display_name: 'Before' }] };
		const patch = dirtyFieldPatch(form, { links: [] });
		form.links[0].display_name = 'After';
		expect(patch.links).toEqual([{ url: 'https://example.com', display_name: 'Before' }]);
	});
});
