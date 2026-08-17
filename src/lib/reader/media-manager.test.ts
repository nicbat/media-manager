import { describe, it, expect } from 'vitest';
import { MediaManager, type ParsedWorkspace } from './media-manager.js';
import { WorkspaceFormatError } from './manifest.js';

/**
 * Reader unit tests — driven entirely through `fromParsed` against inline parsed fixtures, so they
 * exercise the pure core with **no `fs`, no `process.env`, no network** (the read-only guarantee).
 * `classifyGlobs` (the Vite adapter's path inference) is covered separately via `MediaManager.load`.
 */

/** A representative file-first workspace: 3 blobs, 2 classes, a record type, globals, an asset map. */
function fixture(): ParsedWorkspace {
	return {
		manifest: {
			version: 2,
			files: {
				f1: {
					file_name: 'Sunset.JPEG',
					classes: ['photos'],
					missing: false,
					width: 100,
					height: 50
				},
				f2: { file_name: 'doc.pdf', classes: ['documents'], missing: false },
				f3: { file_name: 'gone.png', classes: ['photos'], missing: true, width: 10, height: 10 }
			}
		},
		classes: {
			photos: {
				config: { displayName: 'Photos', icon: 'camera' },
				records: {
					f1: {
						id: 'f1',
						last_modified: '2026-01-01',
						name: 'Sunset',
						hidden: false,
						Year: '2024',
						width: 100,
						height: 50
					},
					f3: { id: 'f3', name: 'Gone', hidden: true, Year: '2020' }
				}
			},
			documents: {
				config: { displayName: 'Documents' },
				records: { f2: { id: 'f2', name: 'Doc' } }
			}
		},
		recordTypes: {
			projects: {
				settings: { displayName: 'Projects' },
				data: {
					records: [
						{
							id: 'p1',
							last_modified: '2026-03-01',
							name: 'Beta',
							date: '2026-02-01',
							thumbnail: 'f1',
							lead: 'person1', // record-type field → people
							contributors: ['person1', 'person2', 'ghost'] // list-of-records, 'ghost' dangling
						},
						{ id: 'p2', name: 'Alpha', date: '2026-05-01', gallery: ['f1', 'f2', 'nope'] }
					]
				}
			},
			people: {
				settings: { displayName: 'People' },
				data: {
					records: [
						{ id: 'person1', name: 'Ada' },
						{ id: 'person2', name: 'Alan' }
					]
				}
			}
		},
		globals: {
			settings: { displayName: 'Globals' },
			data: {
				records: [
					{
						id: 'g1',
						last_modified: 'x',
						'my name': 'Nicholas',
						age: 21,
						resume: 'f2',
						__field_kinds: '{"resume":"file"}',
						__field_meta: '{}'
					}
				]
			}
		},
		// note: gone.png is intentionally ABSENT from the asset map; Sunset.JPEG is lowercased here.
		assets: { 'sunset.jpeg': '/assets/sunset.hash.jpeg', 'doc.pdf': '/assets/doc.hash.pdf' }
	};
}

describe('MediaManager — media (blobs)', () => {
	it('lists every blob and resolves hashed src URLs', () => {
		const mm = MediaManager.fromParsed(fixture());
		expect(mm.media().length).toBe(3);
		expect(mm.file('f1')?.src).toBe('/assets/sunset.hash.jpeg');
		expect(mm.file('f1')?.width).toBe(100);
	});

	it('resolves assets tolerant of filename extension case', () => {
		// manifest file_name is "Sunset.JPEG"; the asset key is "sunset.jpeg".
		const mm = MediaManager.fromParsed(fixture());
		expect(mm.file('f1')?.src).toBe('/assets/sunset.hash.jpeg');
	});

	it('flags a missing/unresolved blob with src:null + missing:true (never a broken img)', () => {
		const mm = MediaManager.fromParsed(fixture());
		const f3 = mm.file('f3');
		expect(f3?.src).toBeNull();
		expect(f3?.missing).toBe(true);
	});

	it('returns null for an unknown id', () => {
		const mm = MediaManager.fromParsed(fixture());
		expect(mm.file('nope')).toBeNull();
	});

	it('memoizes blob identity across lookups', () => {
		const mm = MediaManager.fromParsed(fixture());
		expect(mm.file('f1')).toBe(mm.file('f1'));
	});
});

describe('MediaManager — class members', () => {
	it('returns class-scoped members carrying that class metadata', () => {
		const mm = MediaManager.fromParsed(fixture());
		const photos = mm.media('photos');
		expect(photos.length).toBe(2);
		const sunset = photos.find((m) => m.id === 'f1')!;
		expect(sunset.field('name')).toBe('Sunset');
		expect(sunset.field('Year')).toBe('2024');
	});

	it('strips system keys (id/last_modified/width/height) from fields', () => {
		const mm = MediaManager.fromParsed(fixture());
		const sunset = mm.media('photos').find((m) => m.id === 'f1')!;
		expect('width' in sunset.fields).toBe(false);
		expect('last_modified' in sunset.fields).toBe(false);
		expect(sunset.fields.name).toBe('Sunset');
		// intrinsics still readable through field()
		expect(sunset.field('width')).toBe(100);
	});

	it('filters with where() and sorts with sortBy()', () => {
		const mm = MediaManager.fromParsed(fixture());
		const visible = mm.media('photos').where({ hidden: false });
		expect(visible.length).toBe(1);
		expect(visible.first()?.field('name')).toBe('Sunset');

		const byYearDesc = mm.media('photos').sortBy('Year', 'desc');
		expect(byYearDesc.first()?.field('Year')).toBe('2024');
	});

	it('returns an empty collection for an unknown class', () => {
		const mm = MediaManager.fromParsed(fixture());
		expect(mm.media('nope').length).toBe(0);
	});
});

describe('MediaManager — records & file references', () => {
	it('lists records of a type', () => {
		const mm = MediaManager.fromParsed(fixture());
		const projects = mm.records('projects');
		expect(projects.length).toBe(2);
		expect(projects.find((r) => r.id === 'p1')?.field('name')).toBe('Beta');
	});

	it('follows a file-type field to a MediaItem (same identity as mm.file)', () => {
		const mm = MediaManager.fromParsed(fixture());
		const p1 = mm.records('projects').find((r) => r.id === 'p1')!;
		expect(p1.field('thumbnail')).toBe('f1'); // raw stored id
		const thumb = p1.file('thumbnail');
		expect(thumb?.id).toBe('f1');
		expect(thumb?.src).toBe('/assets/sunset.hash.jpeg');
		expect(thumb).toBe(mm.file('f1'));
	});

	it('follows a list-of-files field, dropping dangling ids', () => {
		const mm = MediaManager.fromParsed(fixture());
		const p2 = mm.records('projects').find((r) => r.id === 'p2')!;
		const gallery = p2.files('gallery');
		expect(gallery.length).toBe(2); // f1, f2 — 'nope' dropped
		expect(gallery.map((m) => m.id)).toEqual(['f1', 'f2']);
	});

	it('returns null for an empty/missing file field', () => {
		const mm = MediaManager.fromParsed(fixture());
		const p2 = mm.records('projects').find((r) => r.id === 'p2')!;
		expect(p2.file('thumbnail')).toBeNull();
	});
});

describe('MediaManager — record references', () => {
	it('follows a record-type field to another record (same identity as mm.record)', () => {
		const mm = MediaManager.fromParsed(fixture());
		const p1 = mm.records('projects').find((r) => r.id === 'p1')!;
		expect(p1.field('lead')).toBe('person1'); // raw stored id
		const lead = p1.record('lead');
		expect(lead?.id).toBe('person1');
		expect(lead?.field('name')).toBe('Ada');
		expect(lead).toBe(mm.record('person1'));
	});

	it('resolves records across types by id and shares identity with records(typeId)', () => {
		const mm = MediaManager.fromParsed(fixture());
		expect(mm.record('person1')).toBe(mm.records('people').find((r) => r.id === 'person1'));
	});

	it('follows a list-of-records field, dropping dangling ids', () => {
		const mm = MediaManager.fromParsed(fixture());
		const p1 = mm.records('projects').find((r) => r.id === 'p1')!;
		const contributors = p1.records('contributors');
		expect(contributors.length).toBe(2); // person1, person2 — 'ghost' dropped
		expect(contributors.map((r) => r.field('name'))).toEqual(['Ada', 'Alan']);
	});

	it('returns null for an empty/missing record field', () => {
		const mm = MediaManager.fromParsed(fixture());
		const p2 = mm.records('projects').find((r) => r.id === 'p2')!;
		expect(p2.record('lead')).toBeNull();
		expect(mm.record('nobody')).toBeNull();
	});
});

describe('MediaManager — globals', () => {
	it('exposes the singleton with reserved meta keys stripped', () => {
		const mm = MediaManager.fromParsed(fixture());
		const g = mm.globals()!;
		expect(g.field('my name')).toBe('Nicholas');
		expect(g.field('age')).toBe(21);
		expect('__field_kinds' in g.fields).toBe(false);
		expect('__field_meta' in g.fields).toBe(false);
	});

	it('resolves a globals file field', () => {
		const mm = MediaManager.fromParsed(fixture());
		expect(mm.globals()!.file('resume')?.id).toBe('f2');
	});
});

describe('MediaManager — summaries', () => {
	it('lists classes with name, icon, and count', () => {
		const mm = MediaManager.fromParsed(fixture());
		expect(mm.classes()).toContainEqual({ id: 'photos', name: 'Photos', icon: 'camera', count: 2 });
		expect(mm.classes()).toContainEqual({
			id: 'documents',
			name: 'Documents',
			icon: undefined,
			count: 1
		});
	});

	it('lists record types with name and count', () => {
		const mm = MediaManager.fromParsed(fixture());
		expect(mm.types()).toContainEqual({ id: 'projects', name: 'Projects', count: 2 });
	});
});

describe('MediaManager — version guard', () => {
	it('throws on an unsupported manifest version', () => {
		expect(() => MediaManager.fromParsed({ manifest: { version: 1, files: {} } })).toThrow(
			WorkspaceFormatError
		);
	});

	it('throws when the manifest is absent', () => {
		expect(() => MediaManager.fromParsed({ manifest: undefined })).toThrow(WorkspaceFormatError);
	});
});

describe('MediaManager.load — Vite glob classification', () => {
	it('classifies glob maps by path and ignores non-workspace JSON', () => {
		const mm = MediaManager.load({
			data: {
				'/x/media/manifest.json': {
					version: 2,
					files: { f1: { file_name: 'a.png', classes: ['photos'], missing: false } }
				},
				'/x/media/classes/photos.json': {
					config: { displayName: 'Photos' },
					records: { f1: { id: 'f1', name: 'A' } }
				},
				'/x/records/projects/data.json': { records: [{ id: 'p1', name: 'P' }] },
				'/x/records/projects/settings.json': { displayName: 'Projects' },
				'/x/globals/data.json': { records: [{ id: 'g1', greeting: 'hi' }] },
				'/x/settings.json': { gridSize: 'large' }, // ignored
				'/x/media/settings.json': {} // ignored
			},
			files: { '/x/media/files/a.png': '/assets/a.hash.png' }
		});

		expect(mm.media('photos').first()?.src).toBe('/assets/a.hash.png');
		expect(mm.media('photos').first()?.field('name')).toBe('A');
		expect(mm.records('projects').length).toBe(1);
		expect(mm.types()).toContainEqual({ id: 'projects', name: 'Projects', count: 1 });
		expect(mm.globals()?.field('greeting')).toBe('hi');
	});
});

describe('MediaManager — static-assets baseUrl mode', () => {
	/** The fixture with the `?url` asset map removed — so baseUrl synthesis is what resolves `src`. */
	function noAssets(): ParsedWorkspace {
		const f = fixture();
		delete f.assets;
		return f;
	}

	it('synthesizes src from baseUrl + filename when no files glob is present', () => {
		const mm = MediaManager.fromParsed(noAssets(), { assets: { baseUrl: '/media' } });
		// The on-disk casing is preserved in the URL; the index lookup itself stays case-insensitive.
		expect(mm.file('f1')?.src).toBe('/media/Sunset.JPEG');
		expect(mm.file('f2')?.src).toBe('/media/doc.pdf');
		// dimensions still come off the manifest, unaffected by the URL source
		expect(mm.file('f1')?.width).toBe(100);
	});

	it('percent-encodes filenames and strips a trailing slash on baseUrl', () => {
		const f = noAssets();
		f.manifest = {
			version: 2,
			files: { x: { file_name: 'my photo#1.jpg', classes: [], missing: false } }
		};
		const mm = MediaManager.fromParsed(f, { assets: { baseUrl: '/media/' } });
		expect(mm.file('x')?.src).toBe('/media/my%20photo%231.jpg');
	});

	it('keeps manifest.missing semantics (src non-null, missing follows the manifest flag)', () => {
		const mm = MediaManager.fromParsed(noAssets(), { assets: { baseUrl: '/media' } });
		const f3 = mm.file('f3'); // flagged missing:true in the manifest
		expect(f3?.src).toBe('/media/gone.png'); // a URL is synthesized...
		expect(f3?.missing).toBe(true); // ...but it's still reported missing per the manifest
	});

	it('a files glob wins over baseUrl (baseUrl only fills an otherwise-empty index)', () => {
		const mm = MediaManager.fromParsed(fixture(), { assets: { baseUrl: '/media' } });
		expect(mm.file('f1')?.src).toBe('/assets/sunset.hash.jpeg'); // the glob URL, not /media/Sunset.JPEG
	});

	it('throws WorkspaceFormatError on a case-insensitive filename collision', () => {
		const f = noAssets();
		f.manifest = {
			version: 2,
			files: {
				a: { file_name: 'Photo.jpg', classes: [], missing: false },
				b: { file_name: 'photo.JPG', classes: [], missing: false }
			}
		};
		expect(() => MediaManager.fromParsed(f, { assets: { baseUrl: '/media' } })).toThrow(
			WorkspaceFormatError
		);
	});
});
