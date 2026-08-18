/**
 * `MediaManager` — the entire public surface of the reader.
 *
 * A host loads a media-manager workspace once (`MediaManager.load({ data, files })`, fed two
 * `import.meta.glob` maps) and then reads it through a handful of obvious methods — `media()`,
 * `records()`, `globals()`, `file()`, `record()`, `classes()`, `types()` — getting back flat
 * {@link MediaItem} / {@link MMRecord} items in fluent {@link Collection}s. Everything underneath
 * (manifest join, url normalization, ext-case asset matching, the version guard) is private.
 *
 * It is **pure**: no `fs`, no `process.env`, no network, no writes. All input is already-parsed JSON
 * + a `{ filename → url }` asset map; the host's bundler resolves the asset URLs.
 *
 * @see ./README.md for the walkthrough and recipes.
 */

import { Collection } from './collection.js';
import { MediaItem, MMRecord, type ReaderContext, type VariantInfo } from './items.js';
import {
	parseManifest,
	WorkspaceFormatError,
	type Manifest,
	type ManifestFileEntry
} from './manifest.js';
import {
	PostCollection,
	DEFAULT_POSTS_THEME,
	type PostsOptions,
	type PostsTheme,
	type PostRenderContext
} from './posts.js';

type RawRecord = Record<string, unknown>;

/**
 * System keys stripped from a record's user-facing `fields`. Mirrors `core/fieldKeys.RESERVED_FIELD_KEYS`
 * (the editor's source of truth) — inlined so the reader stays a self-contained, zero-cross-dependency
 * module that can be lifted into its own package (FUTURE_CHANGES Item 44) by moving this directory.
 */
const SYSTEM_KEYS = new Set(['id', 'last_modified', 'width', 'height']);

/**
 * Reserved keys the globals singleton uses to emulate a schema (field kinds/meta/layout). Mirrors
 * `core/fieldKeys.GLOBALS_META_KEYS`; inlined for the same self-containment reason as {@link SYSTEM_KEYS}.
 */
const GLOBALS_META_KEYS = new Set(['__field_kinds', '__field_meta', '__layout']);

/** A class summary for rails / pickers. */
export interface ClassSummary {
	id: string;
	name: string;
	icon?: string;
	count: number;
}

/** A record-type summary for rails / pickers. */
export interface TypeSummary {
	id: string;
	name: string;
	count: number;
}

/** Internal: a parsed class file's reader view. */
interface ClassData {
	displayName: string;
	icon?: string;
	records: Record<string, RawRecord>;
}

/** Internal: a parsed record type's reader view. */
interface TypeData {
	displayName: string;
	records: RawRecord[];
}

/**
 * Already-classified workspace input for {@link MediaManager.fromParsed}. Hosts normally use
 * {@link MediaManager.load} (which classifies glob maps for you) and never construct this directly;
 * it's the env-agnostic seam that tests and non-Vite adapters use.
 */
export interface ParsedWorkspace {
	/** Parsed `media/manifest.json`. */
	manifest: unknown;
	/** classId → parsed `media/classes/<id>.json`. */
	classes?: Record<string, unknown>;
	/** typeId → its parsed `settings.json` + `data.json`. */
	recordTypes?: Record<string, { settings?: unknown; data?: unknown }>;
	/** The globals singleton's parsed `settings.json` + `data.json`. */
	globals?: { settings?: unknown; data?: unknown };
	/** collection id → (slug → raw `.md` string). Posts sub-app (Item 14). */
	posts?: Record<string, Record<string, string>>;
	/** filename → resolved (bundler-hashed) asset URL. */
	assets?: Record<string, string>;
	/**
	 * preset id → (filename → resolved asset URL) for compressed derivatives (Item 15). Deliberately a
	 * **nested, preset-keyed** map rather than a flat one: two presets routinely emit the same basename
	 * (`derived/web/x.webp` and `derived/thumb/x.webp`), which would collide in a flat index — and
	 * folding derivatives into {@link assets} would also make it non-empty and thereby disable
	 * static-assets `baseUrl` synthesis for the originals.
	 */
	derivedAssets?: Record<string, Record<string, string>>;
}

/** The glob maps a Vite host passes to {@link MediaManager.load}. */
export interface WorkspaceGlobs {
	/** `import.meta.glob('<root>/**\/*.json', { eager: true, import: 'default' })` — parsed JSON by path. */
	data: Record<string, unknown>;
	/**
	 * `import.meta.glob('<root>/media/files/*', { eager: true, query: '?url', import: 'default' })` —
	 * the blobs themselves, bundled and hashed by the host's bundler.
	 *
	 * **Optional, and omitted on purpose in static-assets mode.** Leaving it out is exactly what arms
	 * `options.assets.baseUrl` synthesis: the reader only manufactures `` `${baseUrl}/<file_name>` ``
	 * URLs when the asset index came out empty, so a host serving blobs from a CDN / static folder
	 * passes `{ data }` alone and never bundles a single blob (the fix for size-capped serverless
	 * functions). Pass it and it wins — a `files` glob always beats `baseUrl`. {@link derived} is
	 * optional for the same reason, gated independently.
	 */
	files?: Record<string, unknown>;
	/** `import.meta.glob('<root>/posts/**\/*.md', { eager: true, query: '?raw', import: 'default' })` — Item 14. */
	posts?: Record<string, unknown>;
	/**
	 * `import.meta.glob('<root>/media/derived/*\/*', { eager: true, query: '?url', import: 'default' })`
	 * — the compressed derivatives (Item 15). Optional: omit it and `variant()` simply yields `null`
	 * everywhere (unless static-assets `baseUrl` synthesizes the URLs instead).
	 */
	derived?: Record<string, unknown>;
}

/** Reader options passed as the second arg to {@link MediaManager.load}/{@link MediaManager.fromParsed}. */
export interface ReaderOptions {
	/** Posts sub-app rendering options (fenced-code theme). */
	posts?: PostsOptions;
	/**
	 * **Static-assets mode.** Resolve every blob's URL from a base path instead of a bundler `?url`
	 * glob. When `baseUrl` is set *and* no `files` glob populated the asset map, the reader synthesizes
	 * `` `${baseUrl}/${encodeURIComponent(file_name)}` `` for every manifest entry — so the host serves
	 * blobs from a CDN / static folder and never bundles them into a build (the fix for size-capped
	 * serverless functions). A `files` glob, when present, always wins. See README "Static assets".
	 *
	 * Compressed derivatives (Item 15) are synthesized the same way, one directory deeper:
	 * `` `${baseUrl}/derived/${preset}/${file_name}` ``, gated independently on the derived index being
	 * empty (so a `derived` glob and a `baseUrl` for originals can coexist, and vice versa).
	 */
	assets?: {
		/** Web-address prefix the blobs are served at (e.g. `/media`). A trailing slash is optional. */
		baseUrl: string;
		/** Percent-encode each filename (default `true`). Set `false` only if names are pre-encoded. */
		encode?: boolean;
	};
}

export class MediaManager implements ReaderContext {
	private readonly manifest: Manifest;
	private readonly classData: Map<string, ClassData>;
	private readonly typeData: Map<string, TypeData>;
	private readonly globalsRecordRaw: RawRecord | null;
	/** Lowercased filename → asset URL (ext-case tolerant matching). */
	private readonly assetIndex: Map<string, string>;
	/**
	 * preset id → (lowercased derivative filename → asset URL) — the compressed-derivative index
	 * (Item 15). **Kept strictly separate from {@link assetIndex}** for two reasons, both load-bearing:
	 * (1) `baseUrl` synthesis for the originals fires only when `assetIndex.size === 0`, so folding
	 * derivatives in would silently null out every original's `src` in static-assets mode; and (2) two
	 * presets commonly emit the same basename, which a flat index would collide.
	 */
	private readonly derivedIndex: Map<string, Map<string, string>>;
	/** Memoized blob-level MediaItems by id (so resolved references share identity). */
	private readonly fileCache = new Map<string, MediaItem | null>();
	/** id → raw record, across every record type + the globals singleton (for `recordById`). */
	private readonly recordsRawById = new Map<string, RawRecord>();
	/** Memoized MMRecords by id (so resolved references share identity, like {@link fileCache}). */
	private readonly recordCache = new Map<string, MMRecord | null>();
	/** collection id → (slug → raw `.md`), from the posts glob (Item 14). */
	private readonly postsRaw: Record<string, Record<string, string>>;
	/** Fenced-code theme for `posts()` rendering. */
	private readonly postsTheme: PostsTheme;
	/** Memoized {@link PostCollection} views by collection id. */
	private readonly postCollectionCache = new Map<string, PostCollection>();

	private constructor(parsed: ParsedWorkspace, options?: ReaderOptions) {
		this.manifest = parseManifest(parsed.manifest);
		this.postsRaw = parsed.posts ?? {};
		this.postsTheme = options?.posts?.theme ?? DEFAULT_POSTS_THEME;

		this.assetIndex = new Map();
		for (const [filename, url] of Object.entries(parsed.assets ?? {})) {
			if (typeof url === 'string') this.assetIndex.set(filename.toLowerCase(), url);
		}

		// Static-assets mode: when no `?url` glob populated the index, synthesize each blob's URL from
		// the manifest + a base path (`${baseUrl}/${encodeURIComponent(file_name)}`). The index is keyed
		// on the lowercased basename, so two filenames that collide case-insensitively are ambiguous —
		// fail loudly rather than silently serve one blob for both.
		if (this.assetIndex.size === 0 && options?.assets?.baseUrl) {
			const { baseUrl, encode = true } = options.assets;
			const prefix = baseUrl.replace(/\/+$/, '');
			const originalByKey = new Map<string, string>();
			for (const entry of Object.values(this.manifest.files)) {
				const name = entry.file_name;
				if (!name) continue;
				const key = name.toLowerCase();
				const prior = originalByKey.get(key);
				if (prior !== undefined && prior !== name) {
					throw new WorkspaceFormatError(
						`Static-assets baseUrl mode: filename collision on '${key}' ('${prior}' vs '${name}'). ` +
							'The asset index is keyed on lowercased basename — rename one file so they differ ' +
							'case-insensitively, or supply a `files` map instead.'
					);
				}
				originalByKey.set(key, name);
				this.assetIndex.set(key, `${prefix}/${encode ? encodeURIComponent(name) : name}`);
			}
		}

		// Compressed derivatives (Item 15) — a SEPARATE, preset-keyed index. Populating it must never
		// touch `assetIndex`: the `assetIndex.size === 0` gate above is what enables baseUrl synthesis
		// for the originals, so a workspace with derivatives would otherwise lose every original's src.
		this.derivedIndex = new Map();
		for (const [preset, byName] of Object.entries(parsed.derivedAssets ?? {})) {
			if (!byName || typeof byName !== 'object') continue;
			for (const [filename, url] of Object.entries(byName)) {
				if (typeof url !== 'string') continue;
				let bucket = this.derivedIndex.get(preset);
				if (!bucket) this.derivedIndex.set(preset, (bucket = new Map()));
				bucket.set(filename.toLowerCase(), url);
			}
		}

		// Static-assets mode for derivatives, mirroring the originals above but keyed per preset and
		// gated on its OWN emptiness. Unlike the originals we don't fail on a case-insensitive name
		// collision — a derivative is an optimization the caller can fall back from (`?? item.src`),
		// so last-write-wins is preferable to refusing to load the whole workspace.
		if (this.derivedIndex.size === 0 && options?.assets?.baseUrl) {
			const { baseUrl, encode = true } = options.assets;
			const prefix = baseUrl.replace(/\/+$/, '');
			for (const entry of Object.values(this.manifest.files)) {
				for (const [preset, d] of Object.entries(entry.derived ?? {})) {
					const name = d.file_name;
					if (!name) continue; // skipped entry — no file exists to point at
					let bucket = this.derivedIndex.get(preset);
					if (!bucket) this.derivedIndex.set(preset, (bucket = new Map()));
					bucket.set(
						name.toLowerCase(),
						`${prefix}/derived/${preset}/${encode ? encodeURIComponent(name) : name}`
					);
				}
			}
		}

		this.classData = new Map();
		for (const [id, raw] of Object.entries(parsed.classes ?? {})) {
			const cf = (raw ?? {}) as {
				config?: { displayName?: string; icon?: string };
				records?: unknown;
			};
			this.classData.set(id, {
				displayName: cf.config?.displayName || id,
				icon: cf.config?.icon,
				records: (cf.records as Record<string, RawRecord>) ?? {}
			});
		}

		this.typeData = new Map();
		for (const [typeId, parts] of Object.entries(parsed.recordTypes ?? {})) {
			const settings = (parts.settings ?? {}) as { displayName?: string };
			const data = (parts.data ?? {}) as { records?: unknown };
			this.typeData.set(typeId, {
				displayName: settings.displayName || typeId,
				records: Array.isArray(data.records) ? (data.records as RawRecord[]) : []
			});
		}

		const globalsData = (parsed.globals?.data ?? null) as { records?: unknown } | null;
		const globalsRecords = Array.isArray(globalsData?.records)
			? (globalsData!.records as RawRecord[])
			: [];
		this.globalsRecordRaw = globalsRecords[0] ?? null;

		// Index every record by id so `record`-type field references resolve by id alone (record ids
		// are globally unique across types), mirroring how the manifest indexes blobs for `file` fields.
		for (const type of this.typeData.values()) {
			for (const raw of type.records) {
				const id = typeof raw.id === 'string' ? raw.id : '';
				if (id && !this.recordsRawById.has(id)) this.recordsRawById.set(id, raw);
			}
		}
		if (this.globalsRecordRaw) {
			const gid = typeof this.globalsRecordRaw.id === 'string' ? this.globalsRecordRaw.id : '';
			if (gid && !this.recordsRawById.has(gid)) this.recordsRawById.set(gid, this.globalsRecordRaw);
		}
	}

	/**
	 * Build a reader from an already-classified {@link ParsedWorkspace}. Env-agnostic — used by
	 * {@link load} and by tests / custom adapters. Throws {@link import('./manifest.js').WorkspaceFormatError}
	 * if the manifest is absent or an unsupported version.
	 */
	static fromParsed(parsed: ParsedWorkspace, options?: ReaderOptions): MediaManager {
		return new MediaManager(parsed, options);
	}

	/**
	 * Build a reader from two Vite glob maps. The reader infers what each entry is — manifest, class,
	 * record type, globals, or asset — **from its path**, so this is identical for every host (only
	 * the workspace path prefix changes). Non-async: pass `{ eager: true }` globs.
	 *
	 * @example
	 * const mm = MediaManager.load({
	 *   data:  import.meta.glob('$assets/mm/**\/*.json', { eager: true, import: 'default' }),
	 *   files: import.meta.glob('$assets/mm/media/files/*', { eager: true, query: '?url', import: 'default' }),
	 *   posts: import.meta.glob('$assets/mm/posts/**\/*.md', { eager: true, query: '?raw', import: 'default' }),
	 *   derived: import.meta.glob('$assets/mm/media/derived/*\/*', { eager: true, query: '?url', import: 'default' }),
	 * }, { posts: { theme: 'catppuccin-mocha' } });
	 */
	static load(globs: WorkspaceGlobs, options?: ReaderOptions): MediaManager {
		return MediaManager.fromParsed(
			classifyGlobs(globs.data ?? {}, globs.files ?? {}, globs.posts ?? {}, globs.derived ?? {}),
			options
		);
	}

	// ── ReaderContext ──────────────────────────────────────────────────────────

	/** Resolve a filename to its hashed asset URL (ext-case tolerant), or `null` if absent. */
	private assetFor(filename: string): string | null {
		if (!filename) return null;
		return this.assetIndex.get(filename.toLowerCase()) ?? null;
	}

	/**
	 * Resolve a manifest entry's `derived` block into the `preset → {@link VariantInfo}` map a
	 * {@link MediaItem} carries (Item 15).
	 *
	 * The single resolution point for variants, shared by {@link fileById} and the class-view branch of
	 * {@link media} — the two places that construct a `MediaItem` — so the blob-level and class-level
	 * views can't drift on which presets a file appears to have.
	 *
	 * Two kinds of entry are dropped, both yielding "no variant for this preset" rather than a partial
	 * record: a **skipped** entry (no `file_name`, so no file exists) and one whose filename isn't in
	 * the derived index (the host wired no `derived` glob / no `baseUrl`, or the file is absent). That
	 * guarantee is what lets {@link VariantInfo.src} be non-nullable.
	 *
	 * @param entry - The blob's manifest entry, or `undefined` for a dangling class-record id.
	 * @returns A map of resolved variants — empty (not `undefined`) when there are none.
	 *
	 * Concerns / future improvements: dimensions/size are copied from the manifest verbatim, so they
	 * describe the **derivative**, not the original. Resolution is eager per item; if huge workspaces
	 * ever make that matter it can become lazy behind the accessor without changing the public shape.
	 */
	private variantsFor(entry: ManifestFileEntry | undefined): Map<string, VariantInfo> {
		const out = new Map<string, VariantInfo>();
		if (!entry?.derived) return out;
		for (const [preset, d] of Object.entries(entry.derived)) {
			const name = d.file_name;
			if (!name) continue;
			const src = this.derivedIndex.get(preset)?.get(name.toLowerCase()) ?? null;
			if (src == null) continue;
			out.set(preset, {
				preset,
				src,
				width: d.width ?? 0,
				height: d.height ?? 0,
				size: d.size ?? 0,
				ssim: typeof d.ssim === 'number' ? d.ssim : null
			});
		}
		return out;
	}

	/**
	 * Resolve a blob by manifest id to a blob-level {@link MediaItem} (no class fields), memoized so
	 * every reference to the same id is the same object. `null` for an unknown/dangling id.
	 */
	fileById(id: string): MediaItem | null {
		if (this.fileCache.has(id)) return this.fileCache.get(id) ?? null;
		const entry = this.manifest.files[id];
		let item: MediaItem | null = null;
		if (entry) {
			const src = this.assetFor(entry.file_name);
			item = new MediaItem({
				id,
				src,
				filename: entry.file_name,
				width: entry.width,
				height: entry.height,
				classes: entry.classes,
				missing: entry.missing || src == null,
				fields: {},
				variants: this.variantsFor(entry),
				ctx: this
			});
		}
		this.fileCache.set(id, item);
		return item;
	}

	/**
	 * Resolve a record by its id (searching every record type + globals) to an {@link MMRecord},
	 * memoized so every reference to the same id is the same object. `null` for an unknown/dangling id.
	 * The record-side counterpart of {@link fileById}.
	 */
	recordById(id: string): MMRecord | null {
		if (this.recordCache.has(id)) return this.recordCache.get(id) ?? null;
		const raw = this.recordsRawById.get(id);
		const rec = raw ? new MMRecord(this.recordInit(raw)) : null;
		this.recordCache.set(id, rec);
		return rec;
	}

	// ── Public surface ───────────────────────────────────────────────────────────

	/**
	 * Every blob in the workspace (`mm.media()`), or the members of one class (`mm.media('photos')`).
	 * Class members carry that class's per-blob metadata in `fields`; the no-arg form returns
	 * blob-level items (empty `fields`). An unknown class id yields an empty Collection — use
	 * {@link classes} to enumerate valid ids.
	 */
	media(classId?: string): Collection<MediaItem> {
		if (classId == null) {
			const items = Object.keys(this.manifest.files)
				.map((id) => this.fileById(id))
				.filter((m): m is MediaItem => m != null);
			return new Collection(items);
		}
		const cls = this.classData.get(classId);
		if (!cls) return new Collection<MediaItem>([]);
		const items: MediaItem[] = [];
		for (const [fileId, rawRecord] of Object.entries(cls.records)) {
			const entry = this.manifest.files[fileId];
			const filename = entry?.file_name ?? '';
			const src = entry ? this.assetFor(filename) : null;
			items.push(
				new MediaItem({
					id: fileId,
					src,
					filename,
					width: entry?.width,
					height: entry?.height,
					classes: entry?.classes ?? [classId],
					missing: !entry || entry.missing || src == null,
					fields: stripSystemKeys(rawRecord),
					variants: this.variantsFor(entry),
					ctx: this
				})
			);
		}
		return new Collection(items);
	}

	/**
	 * The records of a `json` record type (`mm.records('projects')`). An unknown type id yields an
	 * empty Collection — use {@link types} to enumerate valid ids.
	 */
	records(typeId: string): Collection<MMRecord> {
		const type = this.typeData.get(typeId);
		if (!type) return new Collection<MMRecord>([]);
		const items = type.records.map((raw) => this.recordFor(raw));
		return new Collection(items);
	}

	/** The globals singleton as an {@link MMRecord}, or `null` if the workspace has no globals data. */
	globals(): MMRecord | null {
		return this.globalsRecordRaw ? this.recordFor(this.globalsRecordRaw) : null;
	}

	/** Look up one record by its id, across every type + globals (`null` if unknown). Same identity as {@link records}. */
	record(id: string): MMRecord | null {
		return this.recordById(id);
	}

	/** Look up one blob by its manifest id (`null` if unknown). Same item identity as {@link media}. */
	file(id: string): MediaItem | null {
		return this.fileById(id);
	}

	/** Every class with its display name, icon, and member count. */
	classes(): ClassSummary[] {
		return [...this.classData.entries()].map(([id, c]) => ({
			id,
			name: c.displayName,
			icon: c.icon,
			count: Object.keys(c.records).length
		}));
	}

	/** Every `json` record type with its display name and record count. */
	types(): TypeSummary[] {
		return [...this.typeData.entries()].map(([id, t]) => ({
			id,
			name: t.displayName,
			count: t.records.length
		}));
	}

	/**
	 * The posts of a markdown collection (`mm.posts('words')`) as a lazily-rendered
	 * {@link PostCollection} — `.all()` / `.bySlug()` yield {@link import('./posts.js').PostItem}s with
	 * every `mm://` resolved to an asset URL and fenced code Shiki-highlighted (Item 14). An unknown
	 * collection id yields an empty collection.
	 */
	posts(collection: string): PostCollection {
		const cached = this.postCollectionCache.get(collection);
		if (cached) return cached;
		const renderCtx: PostRenderContext = {
			resolveFile: (id) => this.fileById(id)?.src ?? null
		};
		const view = new PostCollection(
			collection,
			this.postsRaw[collection] ?? {},
			renderCtx,
			this.postsTheme
		);
		this.postCollectionCache.set(collection, view);
		return view;
	}

	/** Every post-collection id present in the workspace (folder names under `posts/`). */
	postCollections(): string[] {
		return Object.keys(this.postsRaw);
	}

	/** Build the constructor init for an {@link MMRecord} from a raw record (system/meta keys stripped). */
	private recordInit(raw: RawRecord) {
		return {
			id: typeof raw.id === 'string' ? raw.id : '',
			lastModified: typeof raw.last_modified === 'string' ? raw.last_modified : null,
			fields: stripSystemKeys(raw),
			ctx: this
		};
	}

	/**
	 * An {@link MMRecord} for a raw record, reusing the id-memoized instance from {@link recordById}
	 * when the record has an id — so a record surfaced via `records()`/`globals()` shares identity with
	 * the same record reached through a `record`-type reference. Id-less records get a fresh instance.
	 */
	private recordFor(raw: RawRecord): MMRecord {
		const id = typeof raw.id === 'string' ? raw.id : '';
		if (id) {
			const cached = this.recordById(id);
			if (cached) return cached;
		}
		return new MMRecord(this.recordInit(raw));
	}
}

/** Strip system keys (`id`/`last_modified`/`width`/`height`) and globals meta keys from a raw record. */
function stripSystemKeys(raw: RawRecord): RawRecord {
	const out: RawRecord = {};
	for (const [k, v] of Object.entries(raw)) {
		if (SYSTEM_KEYS.has(k)) continue;
		if (GLOBALS_META_KEYS.has(k)) continue;
		out[k] = v;
	}
	return out;
}

/**
 * Classify two Vite glob maps into a {@link ParsedWorkspace} by inspecting each path. Recognizes the
 * file-first layout (`media/manifest.json`, `media/classes/<id>.json`, `records/<typeId>/{settings,data}.json`,
 * `globals/{settings,data}.json`); other JSON (root/`media`/`records` settings) is ignored. Asset
 * entries are keyed by basename; derivative assets (`media/derived/<preset>/<file>`) are keyed by
 * preset **and** basename, since the same basename recurs across presets.
 */
function classifyGlobs(
	dataGlob: Record<string, unknown>,
	filesGlob: Record<string, unknown>,
	postsGlob: Record<string, unknown> = {},
	derivedGlob: Record<string, unknown> = {}
): ParsedWorkspace {
	const parsed: ParsedWorkspace = {
		manifest: undefined,
		classes: {},
		recordTypes: {},
		posts: {},
		assets: {},
		derivedAssets: {}
	};

	for (const [path, value] of Object.entries(dataGlob)) {
		const p = path.replace(/\\/g, '/');
		let m: RegExpMatchArray | null;
		if (/(^|\/)media\/manifest\.json$/.test(p)) {
			parsed.manifest = value;
		} else if ((m = p.match(/(^|\/)media\/classes\/([^/]+)\.json$/))) {
			parsed.classes![m[2]] = value;
		} else if ((m = p.match(/(^|\/)records\/([^/]+)\/data\.json$/))) {
			(parsed.recordTypes![m[2]] ??= {}).data = value;
		} else if ((m = p.match(/(^|\/)records\/([^/]+)\/settings\.json$/))) {
			(parsed.recordTypes![m[2]] ??= {}).settings = value;
		} else if (/(^|\/)globals\/data\.json$/.test(p)) {
			(parsed.globals ??= {}).data = value;
		} else if (/(^|\/)globals\/settings\.json$/.test(p)) {
			(parsed.globals ??= {}).settings = value;
		}
		// else: root/media/records settings.json — ignored.
	}

	for (const [path, url] of Object.entries(filesGlob)) {
		if (typeof url !== 'string') continue;
		const base = path.replace(/\\/g, '/').split('/').pop();
		if (base) parsed.assets![base] = url;
	}

	// Derivatives (`?url` glob): `media/derived/<preset>/<file>` → parsed.derivedAssets[preset][file].
	// Kept out of `parsed.assets` on purpose — see ParsedWorkspace.derivedAssets.
	for (const [path, url] of Object.entries(derivedGlob)) {
		if (typeof url !== 'string') continue;
		const m = path.replace(/\\/g, '/').match(/(^|\/)media\/derived\/([^/]+)\/([^/]+)$/);
		if (!m) continue;
		(parsed.derivedAssets![m[2]] ??= {})[m[3]] = url;
	}

	// Posts (`?raw` glob): `posts/<collection>/<slug>.md` → parsed.posts[collection][slug] = rawString.
	for (const [path, raw] of Object.entries(postsGlob)) {
		if (typeof raw !== 'string') continue;
		const m = path.replace(/\\/g, '/').match(/(^|\/)posts\/([^/]+)\/([^/]+)\.md$/);
		if (!m) continue;
		(parsed.posts![m[2]] ??= {})[m[3]] = raw;
	}

	return parsed;
}
