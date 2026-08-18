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

describe('MediaManager — compressed variants (Item 15)', () => {
	/**
	 * The fixture plus `derived` blocks on the manifest: f1 has a same-size `web` re-encode **and** a
	 * downscaled `thumb` (400px wide, vs the original's 100), f2 has a *skipped* `web` entry (no
	 * `file_name` ⇒ no file exists).
	 */
	function withDerived(): ParsedWorkspace {
		const f = fixture();
		const files = (f.manifest as { files: Record<string, Record<string, unknown>> }).files;
		files.f1.derived = {
			web: {
				file_name: 'Sunset.webp',
				size: 3801,
				width: 100,
				height: 50,
				ssim: 0.987,
				recipe: 'webp:q80',
				source_size: 42138,
				generated_at: '2026-08-18T10:00:00.000Z'
			},
			thumb: {
				file_name: 'Sunset-thumb.webp',
				size: 900,
				width: 400,
				height: 200,
				recipe: 'webp:q70:w400'
			}
		};
		files.f2.derived = { web: { skipped: 'unsupported', recipe: 'webp:q80' } };
		return f;
	}

	/** The matching `derived` glob output: preset → (filename → hashed URL). */
	function derivedAssets(): Record<string, Record<string, string>> {
		return {
			web: { 'Sunset.webp': '/assets/sunset.web.hash.webp' },
			thumb: { 'Sunset-thumb.webp': '/assets/sunset.thumb.hash.webp' }
		};
	}

	it('resolves variant URLs from the derived glob', () => {
		const mm = MediaManager.fromParsed({ ...withDerived(), derivedAssets: derivedAssets() });
		const f1 = mm.file('f1')!;
		expect(f1.variant('web')).toBe('/assets/sunset.web.hash.webp');
		expect(f1.variantInfo('web')).toEqual({
			preset: 'web',
			src: '/assets/sunset.web.hash.webp',
			width: 100,
			height: 50,
			size: 3801,
			ssim: 0.987
		});
		// the original's own src is untouched
		expect(f1.src).toBe('/assets/sunset.hash.jpeg');
	});

	it('reports the DERIVATIVE dimensions, not the original blob dimensions', () => {
		const mm = MediaManager.fromParsed({ ...withDerived(), derivedAssets: derivedAssets() });
		const f1 = mm.file('f1')!;
		expect(f1.width).toBe(100); // the original
		const thumb = f1.variantInfo('thumb')!;
		expect(thumb.width).toBe(400); // the 400px-wide derivative
		expect(thumb.height).toBe(200);
		expect(thumb.ssim).toBeNull(); // unscored derivative
	});

	it('exposes the same variants through a class view', () => {
		const mm = MediaManager.fromParsed({ ...withDerived(), derivedAssets: derivedAssets() });
		const fromClass = mm.media('photos').find((m) => m.id === 'f1')!;
		expect(fromClass.variant('web')).toBe('/assets/sunset.web.hash.webp');
		expect(fromClass.variantInfo('thumb')?.width).toBe(400);
	});

	it('treats a skipped entry (no file_name) as absent', () => {
		const mm = MediaManager.fromParsed({ ...withDerived(), derivedAssets: derivedAssets() });
		const f2 = mm.file('f2')!;
		expect(f2.variant('web')).toBeNull();
		expect(f2.variantInfo('web')).toBeNull();
		expect(f2.variants.size).toBe(0);
	});

	it('returns null for an unknown preset (no nearest-preset fallback)', () => {
		const mm = MediaManager.fromParsed({ ...withDerived(), derivedAssets: derivedAssets() });
		const f1 = mm.file('f1')!;
		expect(f1.variant('nope')).toBeNull();
		expect(f1.variantInfo('nope')).toBeNull();
	});

	it('returns null when the derivative filename did not resolve to a URL', () => {
		// derived blocks present, but the host wired no derived glob at all
		const mm = MediaManager.fromParsed(withDerived());
		expect(mm.file('f1')?.variant('web')).toBeNull();
		expect(mm.file('f1')?.variants.size).toBe(0);
	});

	it('yields empty variants for a manifest with no derived key at all', () => {
		const mm = MediaManager.fromParsed(fixture());
		const f1 = mm.file('f1')!;
		expect(f1.variants.size).toBe(0);
		expect(f1.variant('web')).toBeNull();
		expect(f1.variantInfo('web')).toBeNull();
		// and the original still resolves — strictly non-breaking
		expect(f1.src).toBe('/assets/sunset.hash.jpeg');
	});

	it('classifies a derived glob by preset directory via MediaManager.load', () => {
		const mm = MediaManager.load({
			data: {
				'/x/media/manifest.json': {
					version: 2,
					files: {
						f1: {
							file_name: 'a.png',
							classes: [],
							missing: false,
							derived: {
								web: { file_name: 'a.webp', width: 800, height: 600, size: 1234 },
								thumb: { file_name: 'a.webp', width: 400, height: 300, size: 99 }
							}
						}
					}
				}
			},
			files: { '/x/media/files/a.png': '/assets/a.hash.png' },
			derived: {
				'/x/media/derived/web/a.webp': '/assets/a.web.hash.webp',
				'/x/media/derived/thumb/a.webp': '/assets/a.thumb.hash.webp'
			}
		});
		const f1 = mm.file('f1')!;
		// same basename under two presets must NOT collide
		expect(f1.variant('web')).toBe('/assets/a.web.hash.webp');
		expect(f1.variant('thumb')).toBe('/assets/a.thumb.hash.webp');
		expect(f1.variantInfo('thumb')?.width).toBe(400);
		expect(f1.src).toBe('/assets/a.hash.png');
	});
});

describe('MediaManager — variants × static-assets baseUrl mode', () => {
	function withDerivedNoAssets(): ParsedWorkspace {
		const f = fixture();
		delete f.assets;
		const files = (f.manifest as { files: Record<string, Record<string, unknown>> }).files;
		files.f1.derived = { thumb: { file_name: 'Sunset-thumb.webp', width: 400, height: 200 } };
		return f;
	}

	it('REGRESSION: no derived glob + baseUrl still resolves every original src', () => {
		// Guards the `assetIndex.size === 0` gate: derivatives must never populate the originals index.
		const mm = MediaManager.fromParsed(withDerivedNoAssets(), { assets: { baseUrl: '/media' } });
		expect(mm.file('f1')?.src).toBe('/media/Sunset.JPEG');
		expect(mm.file('f1')?.missing).toBe(false);
		expect(mm.file('f2')?.src).toBe('/media/doc.pdf');
		expect(mm.file('f2')?.missing).toBe(false);
	});

	it('REGRESSION: a derived glob does not disable baseUrl synthesis for originals', () => {
		const mm = MediaManager.fromParsed(
			{
				...withDerivedNoAssets(),
				derivedAssets: { thumb: { 'Sunset-thumb.webp': '/assets/t.hash.webp' } }
			},
			{ assets: { baseUrl: '/media' } }
		);
		expect(mm.file('f1')?.src).toBe('/media/Sunset.JPEG'); // originals still synthesized
		expect(mm.file('f1')?.missing).toBe(false);
		expect(mm.file('f1')?.variant('thumb')).toBe('/assets/t.hash.webp'); // glob wins for derivatives
	});

	it('synthesizes derived URLs with a derived/<preset>/ path segment', () => {
		const mm = MediaManager.fromParsed(withDerivedNoAssets(), { assets: { baseUrl: '/media' } });
		expect(mm.file('f1')?.variant('thumb')).toBe('/media/derived/thumb/Sunset-thumb.webp');
		expect(mm.file('f1')?.variantInfo('thumb')?.width).toBe(400);
	});

	it('percent-encodes synthesized derived filenames and honours encode:false', () => {
		const f = withDerivedNoAssets();
		const files = (f.manifest as { files: Record<string, Record<string, unknown>> }).files;
		files.f1.derived = { thumb: { file_name: 'my photo#1.webp' } };
		expect(
			MediaManager.fromParsed(f, { assets: { baseUrl: '/media/' } })
				.file('f1')
				?.variant('thumb')
		).toBe('/media/derived/thumb/my%20photo%231.webp');
		expect(
			MediaManager.fromParsed(f, { assets: { baseUrl: '/media', encode: false } })
				.file('f1')
				?.variant('thumb')
		).toBe('/media/derived/thumb/my photo#1.webp');
	});

	it('does not synthesize a URL for a skipped derived entry', () => {
		const f = withDerivedNoAssets();
		const files = (f.manifest as { files: Record<string, Record<string, unknown>> }).files;
		files.f1.derived = { thumb: { skipped: 'larger', recipe: 'webp:q70:w400' } };
		const mm = MediaManager.fromParsed(f, { assets: { baseUrl: '/media' } });
		expect(mm.file('f1')?.variant('thumb')).toBeNull();
		expect(mm.file('f1')?.src).toBe('/media/Sunset.JPEG');
	});
});

describe('MediaItem.srcset — the responsive ladder (Item 15 phase 2)', () => {
	/**
	 * A genuine multi-width ladder on f1: a 2000px original with 400/800/1600 derivatives, declared in
	 * a deliberately NON-ascending preset order so the sort is actually exercised, plus two presets
	 * that must contribute nothing — `icon` (generated but no width recorded) and `print` (skipped).
	 */
	function ladder(): ParsedWorkspace {
		const f = fixture();
		const files = (f.manifest as { files: Record<string, Record<string, unknown>> }).files;
		files.f1.width = 2000;
		files.f1.height = 1000;
		files.f1.derived = {
			web: { file_name: 'Sunset-800.webp', size: 4000, width: 800, height: 400 },
			thumb: { file_name: 'Sunset-400.webp', size: 900, width: 400, height: 200 },
			full: { file_name: 'Sunset-1600.webp', size: 9000, width: 1600, height: 800 },
			icon: { file_name: 'Sunset-icon.webp', size: 120 }, // generated, but no width → unusable
			print: { skipped: 'larger', recipe: 'webp:q90' } // never generated
		};
		return f;
	}

	/** The matching `derived` glob output for {@link ladder}. */
	function ladderAssets(): Record<string, Record<string, string>> {
		return {
			web: { 'Sunset-800.webp': '/assets/s.800.webp' },
			thumb: { 'Sunset-400.webp': '/assets/s.400.webp' },
			full: { 'Sunset-1600.webp': '/assets/s.1600.webp' },
			icon: { 'Sunset-icon.webp': '/assets/s.icon.webp' }
		};
	}

	/** The ladder wired through a `derived` glob (bundler mode). */
	function ladderMM() {
		return MediaManager.fromParsed({ ...ladder(), derivedAssets: ladderAssets() });
	}

	it('emits width-bearing variants ascending, with the original appended', () => {
		expect(ladderMM().file('f1')!.srcset()).toBe(
			'/assets/s.400.webp 400w, /assets/s.800.webp 800w, /assets/s.1600.webp 1600w, ' +
				'/assets/sunset.hash.jpeg 2000w'
		);
	});

	it('skips a variant with no usable width, and a skipped preset entirely', () => {
		const out = ladderMM().file('f1')!.srcset();
		expect(out).not.toContain('s.icon'); // width missing → no valid `w` descriptor
		expect(out).not.toContain('print');
		expect(out.split(', ')).toHaveLength(4);
	});

	it('suppresses the original with includeOriginal: false', () => {
		expect(ladderMM().file('f1')!.srcset({ includeOriginal: false })).toBe(
			'/assets/s.400.webp 400w, /assets/s.800.webp 800w, /assets/s.1600.webp 1600w'
		);
	});

	it('suppresses the original when a variant already occupies its width', () => {
		const f = ladder();
		const files = (f.manifest as { files: Record<string, Record<string, unknown>> }).files;
		// `full` is now a same-size re-encode at the original's 2000px
		(files.f1.derived as Record<string, Record<string, unknown>>).full.width = 2000;
		(files.f1.derived as Record<string, Record<string, unknown>>).full.height = 1000;
		const out = MediaManager.fromParsed({ ...f, derivedAssets: ladderAssets() })
			.file('f1')!
			.srcset();
		expect(out).toBe('/assets/s.400.webp 400w, /assets/s.800.webp 800w, /assets/s.1600.webp 2000w');
		expect(out).not.toContain('sunset.hash.jpeg'); // the derivative owns 2000w
	});

	it('omits the original when the blob has no known width (never guesses)', () => {
		const f = ladder();
		const files = (f.manifest as { files: Record<string, Record<string, unknown>> }).files;
		delete files.f1.width;
		expect(
			MediaManager.fromParsed({ ...f, derivedAssets: ladderAssets() })
				.file('f1')!
				.srcset()
		).toBe('/assets/s.400.webp 400w, /assets/s.800.webp 800w, /assets/s.1600.webp 1600w');
	});

	it('deduplicates by width, keeping the first candidate', () => {
		const f = ladder();
		const files = (f.manifest as { files: Record<string, Record<string, unknown>> }).files;
		// a second 800px preset: `web` is declared first, so it wins the 800w slot
		(files.f1.derived as Record<string, unknown>).webp2 = {
			file_name: 'Sunset-800b.webp',
			width: 800,
			height: 400
		};
		const assets = ladderAssets();
		assets.webp2 = { 'Sunset-800b.webp': '/assets/s.800b.webp' };
		const out = MediaManager.fromParsed({ ...f, derivedAssets: assets })
			.file('f1')!
			.srcset({ includeOriginal: false });
		expect(out).toBe('/assets/s.400.webp 400w, /assets/s.800.webp 800w, /assets/s.1600.webp 1600w');
		expect(out).not.toContain('s.800b');
	});

	it('restricts to `presets` but still sorts by width', () => {
		// caller order is full-then-thumb; output must still be thumb-then-full
		expect(
			ladderMM()
				.file('f1')!
				.srcset({ presets: ['full', 'thumb'], includeOriginal: false })
		).toBe('/assets/s.400.webp 400w, /assets/s.1600.webp 1600w');
	});

	it('silently ignores unknown preset ids', () => {
		expect(
			ladderMM()
				.file('f1')!
				.srcset({ presets: ['nope', 'thumb', 'print'], includeOriginal: false })
		).toBe('/assets/s.400.webp 400w');
	});

	it('returns "" when no width-bearing variant survives (a lone original is not a ladder)', () => {
		const mm = ladderMM();
		// a blob with no derivatives at all, even though it has a src and a width
		expect(MediaManager.fromParsed(fixture()).file('f1')!.srcset()).toBe('');
		// no width, no src-worthy variants
		expect(mm.file('f2')!.srcset()).toBe('');
		// filtered down to nothing
		expect(mm.file('f1')!.srcset({ presets: ['icon', 'print'] })).toBe('');
		// and the empty value is genuinely empty — no stray space, no dangling comma
		expect(mm.file('f2')!.srcset() || undefined).toBeUndefined();
	});

	it('exposes the same ladder through a class view', () => {
		const fromClass = ladderMM()
			.media('photos')
			.find((m) => m.id === 'f1')!;
		expect(fromClass.srcset({ includeOriginal: false })).toBe(
			'/assets/s.400.webp 400w, /assets/s.800.webp 800w, /assets/s.1600.webp 1600w'
		);
	});

	it('works in static-assets baseUrl mode (derived/<preset>/ URLs)', () => {
		const f = ladder();
		delete f.assets;
		const mm = MediaManager.fromParsed(f, { assets: { baseUrl: '/media' } });
		expect(mm.file('f1')!.srcset()).toBe(
			'/media/derived/thumb/Sunset-400.webp 400w, ' +
				'/media/derived/web/Sunset-800.webp 800w, ' +
				'/media/derived/full/Sunset-1600.webp 1600w, ' +
				'/media/Sunset.JPEG 2000w'
		);
	});

	it('works in baseUrl mode via MediaManager.load with no globs but `data`', () => {
		const f = ladder();
		delete f.assets;
		const mm = MediaManager.load(
			{ data: { '/x/media/manifest.json': f.manifest } },
			{ assets: { baseUrl: '/media' } }
		);
		expect(mm.file('f1')!.srcset({ includeOriginal: false })).toBe(
			'/media/derived/thumb/Sunset-400.webp 400w, ' +
				'/media/derived/web/Sunset-800.webp 800w, ' +
				'/media/derived/full/Sunset-1600.webp 1600w'
		);
	});
});

describe('MediaManager.load — `files` glob is optional (static-assets hosts)', () => {
	it('typechecks and resolves every original from baseUrl with no `files` key at all', () => {
		// The exact shape a static-assets host passes: `data` only, blobs served from /media.
		const mm = MediaManager.load(
			{ data: { '/x/media/manifest.json': fixture().manifest } },
			{ assets: { baseUrl: '/media' } }
		);
		expect(mm.file('f1')?.src).toBe('/media/Sunset.JPEG');
		expect(mm.file('f1')?.missing).toBe(false);
		expect(mm.file('f2')?.src).toBe('/media/doc.pdf');
		expect(mm.file('f2')?.missing).toBe(false);
		expect(mm.media().length).toBe(3);
	});

	it('REGRESSION: a `files` glob still wins over baseUrl when present', () => {
		const mm = MediaManager.load(
			{
				data: { '/x/media/manifest.json': fixture().manifest },
				files: { '/x/media/files/Sunset.JPEG': '/assets/sunset.hash.jpeg' }
			},
			{ assets: { baseUrl: '/media' } }
		);
		expect(mm.file('f1')?.src).toBe('/assets/sunset.hash.jpeg');
		// and the gate is index-wide: a blob absent from the glob is NOT backfilled from baseUrl
		expect(mm.file('f2')?.src).toBeNull();
		expect(mm.file('f2')?.missing).toBe(true);
	});
});
