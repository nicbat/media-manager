/**
 * The two flat item types the facade hands back: {@link MediaItem} (a blob) and {@link MMRecord} (a
 * `json` record / class metadata row). Both are read-only views with a uniform value accessor
 * (`field`) and reference resolvers — `file`/`files` for `file`-type fields, `record`/`records` for
 * `record`-type (cross-record) fields — so following a reference never means juggling a raw id, and
 * the resolved value is the *same* item you'd get from `mm.file(id)` / `mm.record(id)`.
 */

import { Collection, type FieldAccessible } from './collection.js';
import { normalizeFieldValue } from './values.js';

/**
 * The minimal capability the items need from the {@link MediaManager} to resolve references,
 * without importing the facade (avoids a cycle). Implemented by `MediaManager`.
 */
export interface ReaderContext {
	/** Resolve a blob by its manifest id, or `null` if the id is unknown/dangling. */
	fileById(id: string): MediaItem | null;
	/** Resolve a record by its id (across every record type + globals), or `null` if unknown/dangling. */
	recordById(id: string): MMRecord | null;
}

/** Read the ids stored in a reference field: a single id string → `[id]`, an id array → itself. */
function refIds(value: unknown): string[] {
	if (typeof value === 'string') return value ? [value] : [];
	if (Array.isArray(value)) return value.filter((x): x is string => typeof x === 'string');
	return [];
}

/**
 * A resolved compressed **variant** of a blob (Item 15): one preset's derivative, already joined to a
 * usable URL. Handed back by {@link MediaItem.variantInfo}.
 *
 * `src` is non-nullable **by construction** — `variantInfo` returns `null` rather than a record with a
 * dead URL, so a component that got a `VariantInfo` can render it unguarded.
 *
 * Concerns / future improvements: `width`/`height` describe the **derivative** (a 400px-wide thumb
 * reports `width: 400`), so pairing `variantInfo('thumb').src` with the item's own `width`/`height` is
 * a layout bug — take both from the same object.
 */
export interface VariantInfo {
	/** The preset id this variant was generated for (`web`, `thumb`, …). */
	preset: string;
	/** Resolved URL of the derivative file. Never `null` (see above). */
	src: string;
	/** The derivative's pixel width, or `0` when unknown. */
	width: number;
	/** The derivative's pixel height, or `0` when unknown. */
	height: number;
	/** Byte size of the derivative, or `0` when unknown. */
	size: number;
	/** Structural-similarity score (0–1) against the original, or `null` when unscored. */
	ssim: number | null;
}

/** Intrinsic keys a {@link MediaItem} resolves from blob metadata (not class fields). */
const MEDIA_INTRINSICS = new Set([
	'id',
	'filename',
	'file_name',
	'width',
	'height',
	'missing',
	'src'
]);

/**
 * One blob (file) as surfaced by the reader: manifest identity + intrinsic info + the resolved,
 * bundler-hashed `src` URL. When obtained via a class view (`mm.media('photos')`) it also carries
 * that class's per-blob metadata in `fields`; at the blob level (`mm.media()`, `mm.file(id)`,
 * a resolved `file` reference) `fields` is empty because a blob can belong to several classes with
 * differing metadata.
 */
export class MediaItem implements FieldAccessible {
	/** Stable workspace-scoped id (the manifest key). */
	readonly id: string;
	/** Resolved asset URL (hashed by the host's bundler), or `null` when the blob is missing/unresolved. */
	readonly src: string | null;
	/** Current filename within `media/files/`. */
	readonly filename: string;
	/** Intrinsic pixel width, or `0` when unknown. */
	readonly width: number;
	/** Intrinsic pixel height, or `0` when unknown. */
	readonly height: number;
	/** Class ids this blob belongs to (membership index). */
	readonly classes: string[];
	/** True when the blob is missing from disk, or its id is dangling / its asset didn't resolve. */
	readonly missing: boolean;
	/** Class-scoped per-blob metadata (empty at the blob level). */
	readonly fields: Record<string, unknown>;
	/**
	 * Resolved compressed variants by preset id (Item 15) — only presets that actually produced a file
	 * **and** resolved to a URL appear. Empty when the workspace has no derivatives, or when the host
	 * wired neither a `derived` glob nor a static-assets `baseUrl`. Prefer the {@link variant} /
	 * {@link variantInfo} accessors; read the map directly only to enumerate available presets.
	 */
	readonly variants: ReadonlyMap<string, VariantInfo>;

	private readonly ctx: ReaderContext;

	constructor(init: {
		id: string;
		src: string | null;
		filename: string;
		width?: number;
		height?: number;
		classes?: string[];
		missing?: boolean;
		fields?: Record<string, unknown>;
		variants?: ReadonlyMap<string, VariantInfo>;
		ctx: ReaderContext;
	}) {
		this.id = init.id;
		this.src = init.src;
		this.filename = init.filename;
		this.width = init.width ?? 0;
		this.height = init.height ?? 0;
		this.classes = init.classes ?? [];
		this.missing = init.missing ?? false;
		this.fields = init.fields ?? {};
		this.variants = init.variants ?? new Map();
		this.ctx = init.ctx;
	}

	/**
	 * Read a value by key: a class field first (url-shaped values normalized), else an intrinsic
	 * (`id`/`filename`/`width`/`height`/`missing`/`src`). Returns `undefined` for unknown keys.
	 * Used directly and by `Collection.where`/`sortBy`.
	 */
	field(key: string): unknown {
		if (key in this.fields) return normalizeFieldValue(this.fields[key]);
		if (MEDIA_INTRINSICS.has(key)) {
			switch (key) {
				case 'id':
					return this.id;
				case 'filename':
				case 'file_name':
					return this.filename;
				case 'width':
					return this.width;
				case 'height':
					return this.height;
				case 'missing':
					return this.missing;
				case 'src':
					return this.src;
			}
		}
		return undefined;
	}

	/**
	 * The full record for one compressed **variant** of this blob (Item 15) — its URL plus the
	 * derivative's own dimensions, byte size, and similarity score.
	 *
	 * Use case: rendering a gallery from small `thumb` derivatives while linking the full-size original,
	 * or reporting how much a preset saved. Because a `VariantInfo`'s `src` is non-nullable, a returned
	 * record is always safe to render.
	 *
	 * Returns `null` when this blob has **no usable derivative** for `preset` — the preset was never
	 * generated, the editor skipped it (unsupported / larger-than-original / error, all of which leave a
	 * `file_name`-less manifest entry), or the derivative's URL did not resolve in the host's build. A
	 * component must never be handed a broken URL, so an unresolved variant is reported as absent.
	 *
	 * **There is deliberately no "nearest preset" fallback.** An absent preset returns `null` and the
	 * caller falls through to the original — `item.variantInfo('thumb')?.src ?? item.src`. Silently
	 * substituting a *different* preset would be worse than either outcome: the caller asked for a size
	 * budget, and quietly serving a 4000px `web` derivative where a 400px `thumb` was requested would
	 * blow that budget invisibly, with dimensions that no longer match what the caller laid out. Falling
	 * back to the original is at least a choice the caller can see and reason about in their own code.
	 *
	 * @param preset - The preset id to look up (`web`, `thumb`, … — whatever the editor was configured
	 *   with). Unknown ids are not an error; they simply yield `null`.
	 * @returns The resolved variant, or `null` when this blob has none for that preset.
	 *
	 * Concerns / future improvements: take `width`/`height` from the returned record, **not** from the
	 * item — they describe the derivative, and using `item.width` on a thumbnail is wrong by
	 * construction.
	 */
	variantInfo(preset: string): VariantInfo | null {
		return this.variants.get(preset) ?? null;
	}

	/**
	 * The URL of one compressed variant of this blob, or `null` when there is none — the one-liner form
	 * of {@link variantInfo} for the common `<img src={item.variant('web') ?? item.src}>` case.
	 *
	 * @param preset - The preset id to look up.
	 * @returns The derivative's URL, or `null` (see {@link variantInfo} for exactly when).
	 *
	 * Concerns / future improvements: this drops the variant's dimensions, so only reach for it when the
	 * derivative has the **same** aspect and you're laying out from the original's `width`/`height`
	 * (e.g. a same-size re-encode like `webp:q80`). For a resized preset use {@link variantInfo} and
	 * take the dimensions from there.
	 */
	variant(preset: string): string | null {
		return this.variants.get(preset)?.src ?? null;
	}

	/**
	 * Follow a `file`-type field to the blob it references. The stored value is a manifest id; this
	 * resolves it to a {@link MediaItem} (same identity as `mm.file(id)`), or `null` when the field
	 * is empty or the id is dangling.
	 */
	file(key: string): MediaItem | null {
		const v = this.fields[key];
		return typeof v === 'string' && v ? this.ctx.fileById(v) : null;
	}

	/**
	 * Follow a list-of-files field to its blobs, in stored order. Dangling ids are dropped (so the
	 * collection never contains `null`).
	 */
	files(key: string): Collection<MediaItem> {
		const resolved = refIds(this.fields[key])
			.map((id) => this.ctx.fileById(id))
			.filter((m): m is MediaItem => m != null);
		return new Collection(resolved);
	}

	/**
	 * Follow a `record`-type field to the record it references. The stored value is a target-type
	 * record id; this resolves it to an {@link MMRecord} (same identity as `mm.record(id)`), or `null`
	 * when the field is empty or the id is dangling. The mirror of {@link file} for cross-record links.
	 */
	record(key: string): MMRecord | null {
		const v = this.fields[key];
		return typeof v === 'string' && v ? this.ctx.recordById(v) : null;
	}

	/**
	 * Follow a list-of-records field to its records, in stored order. Dangling ids are dropped. The
	 * mirror of {@link files} for cross-record links.
	 */
	records(key: string): Collection<MMRecord> {
		const resolved = refIds(this.fields[key])
			.map((id) => this.ctx.recordById(id))
			.filter((r): r is MMRecord => r != null);
		return new Collection(resolved);
	}
}

/** Intrinsic keys an {@link MMRecord} resolves outside its `fields` bag. */
const RECORD_INTRINSICS = new Set(['id', 'last_modified', 'lastModified']);

/**
 * One `json` record (a record-type row, or the globals singleton). `fields` holds the user-facing
 * field values (system + reserved meta keys stripped). `file`/`files` resolve `file`-type fields to
 * blobs, and `record`/`records` resolve `record`-type fields to other records — exactly like
 * {@link MediaItem}.
 *
 * Named `MMRecord` (not `Record`) so it never shadows TypeScript's built-in `Record<K, V>` utility
 * type at an import site.
 */
export class MMRecord implements FieldAccessible {
	/** Stable record id (UUID). */
	readonly id: string;
	/** ISO last-modified timestamp, or `null` if absent. */
	readonly lastModified: string | null;
	/** User-facing field values (system + reserved meta keys removed). */
	readonly fields: Record<string, unknown>;

	private readonly ctx: ReaderContext;

	constructor(init: {
		id: string;
		lastModified?: string | null;
		fields: Record<string, unknown>;
		ctx: ReaderContext;
	}) {
		this.id = init.id;
		this.lastModified = init.lastModified ?? null;
		this.fields = init.fields;
		this.ctx = init.ctx;
	}

	/**
	 * Read a value by key: a field first (url-shaped values normalized), else `id`/`lastModified`.
	 * Returns `undefined` for unknown keys.
	 */
	field(key: string): unknown {
		if (key in this.fields) return normalizeFieldValue(this.fields[key]);
		if (RECORD_INTRINSICS.has(key)) {
			if (key === 'id') return this.id;
			return this.lastModified ?? undefined;
		}
		return undefined;
	}

	/** Follow a `file`-type field to its blob (`null` when empty/dangling). See {@link MediaItem.file}. */
	file(key: string): MediaItem | null {
		const v = this.fields[key];
		return typeof v === 'string' && v ? this.ctx.fileById(v) : null;
	}

	/** Follow a list-of-files field to its blobs, in order. See {@link MediaItem.files}. */
	files(key: string): Collection<MediaItem> {
		const resolved = refIds(this.fields[key])
			.map((id) => this.ctx.fileById(id))
			.filter((m): m is MediaItem => m != null);
		return new Collection(resolved);
	}

	/** Follow a `record`-type field to its record (`null` when empty/dangling). See {@link MediaItem.record}. */
	record(key: string): MMRecord | null {
		const v = this.fields[key];
		return typeof v === 'string' && v ? this.ctx.recordById(v) : null;
	}

	/** Follow a list-of-records field to its records, in order. See {@link MediaItem.records}. */
	records(key: string): Collection<MMRecord> {
		const resolved = refIds(this.fields[key])
			.map((id) => this.ctx.recordById(id))
			.filter((r): r is MMRecord => r != null);
		return new Collection(resolved);
	}
}
