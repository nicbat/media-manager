/**
 * Reader-side shape + parser for the blob manifest (`media/manifest.json`).
 *
 * The editor's authoritative manifest type lives in `src/lib/storage/manifest.ts`, but that module
 * is Node-only (it does filesystem I/O + locking). The reader is **pure** — it runs inside a host's
 * build with no `fs` — so it carries its own minimal, read-only view of the manifest shape and a
 * hand-rolled guard (no `zod` at runtime, keeping the reader dependency-light for the future
 * standalone package, FUTURE_CHANGES Item 44). Keep this in sync with the writer's on-disk format;
 * the `version` constant below is the single gate that fails loudly when it drifts.
 *
 * @see src/lib/storage/manifest.ts — the writer / source of truth for the on-disk format.
 */

/** The on-disk manifest format version the reader understands (file-first layout, Item 18). */
export const SUPPORTED_MANIFEST_VERSION = 2;

/**
 * One compressed **derivative** of a blob, keyed in {@link ManifestFileEntry.derived} by preset id
 * (`web`, `thumb`, …). The file lives at `media/derived/<preset>/<file_name>` (or
 * `<assetsDir>/derived/<preset>/<file_name>` in static-assets mode).
 *
 * Two shapes share this type:
 * - **generated** — `file_name` + `size` (+ dimensions/ssim) are present and a file exists on disk;
 * - **skipped** — `skipped` + `recipe` only, no `file_name`: the editor deliberately produced nothing
 *   (unsupported input, the derivative came out larger than the original, or the encode errored).
 *
 * Therefore **an entry without `file_name` means "no derivative"** — the reader treats it exactly like
 * an absent preset (see `MediaItem.variantInfo`). Callers should never branch on `skipped` to decide
 * whether a URL exists.
 *
 * Concerns / future improvements: `width`/`height` are the **derivative's** dimensions (a 400px-wide
 * thumb has `width: 400`), never the original's — rendering a variant with the original's dimensions
 * is a layout bug. `ssim` is a 0–1 structural-similarity score against the original when the editor
 * measured one; absent for non-image or unscored derivatives.
 */
export interface DerivedEntry {
	/** Filename of the derivative within `media/derived/<preset>/`. Absent ⇒ nothing was generated. */
	file_name?: string;
	/** Byte size of the derivative file, when generated. */
	size?: number;
	/** The **derivative's** pixel width (not the original's), when known. */
	width?: number;
	/** The **derivative's** pixel height (not the original's), when known. */
	height?: number;
	/** Structural-similarity score (0–1) against the original, when the editor measured one. */
	ssim?: number;
	/** The encode recipe that produced (or would have produced) this derivative, e.g. `webp:q80`. */
	recipe?: string;
	/** Byte size of the source blob at generation time (for compression-ratio reporting). */
	source_size?: number;
	/** ISO timestamp the derivative was generated. */
	generated_at?: string;
	/** Why no derivative exists. Present only on a skipped entry (which has no `file_name`). */
	skipped?: string;
}

/** One blob's manifest entry: identity + derived class membership + intrinsic info. */
export interface ManifestFileEntry {
	/** Current filename of the blob within `media/files/`. */
	file_name: string;
	/** Derived membership index — the class ids this blob belongs to. */
	classes: string[];
	/** True when the blob's file is gone from disk but the entry is retained. */
	missing: boolean;
	/** ISO timestamp the blob was first registered. */
	created_at?: string;
	/** Byte size of the blob on disk, when known. */
	size?: number;
	/** Intrinsic pixel width (images), when known. */
	width?: number;
	/** Intrinsic pixel height (images), when known. */
	height?: number;
	/**
	 * Compressed derivatives keyed by preset id (Item 15). Optional and purely additive — a manifest
	 * written before compression shipped simply has no `derived` key, and every reader path degrades
	 * to "no variants".
	 */
	derived?: Record<string, DerivedEntry>;
}

/** The parsed `media/manifest.json`: a format version + the blob registry keyed by stable id. */
export interface Manifest {
	version: number;
	files: Record<string, ManifestFileEntry>;
}

/**
 * Error thrown when a workspace cannot be read — a missing manifest or an unsupported on-disk
 * format version. Thrown eagerly at load time (never a silent empty render) so a host sitting on a
 * stale or pre-migration export gets an actionable message instead of blank galleries.
 */
export class WorkspaceFormatError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'WorkspaceFormatError';
	}
}

/**
 * Validate + narrow a raw parsed `media/manifest.json` into a {@link Manifest}, enforcing the
 * supported format version. This is the **version guard**: anything that isn't a v2 file-first
 * manifest throws {@link WorkspaceFormatError} with a message naming the expected layout.
 *
 * @param raw - The already-parsed JSON of `media/manifest.json` (or `undefined` if it wasn't found).
 * @returns The validated manifest.
 * @throws {WorkspaceFormatError} when the manifest is absent, malformed, or a version the reader
 *   does not understand.
 */
export function parseManifest(raw: unknown): Manifest {
	if (raw == null || typeof raw !== 'object') {
		throw new WorkspaceFormatError(
			'No media-manager manifest found. Expected a file-first workspace with `media/manifest.json` ' +
				`(format version ${SUPPORTED_MANIFEST_VERSION}). Did you pass the workspace root and is it migrated?`
		);
	}
	const obj = raw as Record<string, unknown>;
	const version = obj.version;
	if (version !== SUPPORTED_MANIFEST_VERSION) {
		throw new WorkspaceFormatError(
			`Unsupported workspace format: media/manifest.json is version ${String(version)}, but this ` +
				`reader understands version ${SUPPORTED_MANIFEST_VERSION} (the file-first layout). Run ` +
				'`npm run upgrade-data` on the workspace, or upgrade the reader.'
		);
	}
	const filesRaw = obj.files;
	const files: Record<string, ManifestFileEntry> = {};
	if (filesRaw && typeof filesRaw === 'object') {
		for (const [id, entryRaw] of Object.entries(filesRaw as Record<string, unknown>)) {
			if (!entryRaw || typeof entryRaw !== 'object') continue;
			const e = entryRaw as Record<string, unknown>;
			files[id] = {
				file_name: typeof e.file_name === 'string' ? e.file_name : '',
				classes: Array.isArray(e.classes) ? (e.classes as unknown[]).filter(isString) : [],
				missing: e.missing === true,
				created_at: typeof e.created_at === 'string' ? e.created_at : undefined,
				size: typeof e.size === 'number' ? e.size : undefined,
				width: typeof e.width === 'number' ? e.width : undefined,
				height: typeof e.height === 'number' ? e.height : undefined,
				derived: parseDerived(e.derived)
			};
		}
	}
	return { version: SUPPORTED_MANIFEST_VERSION, files };
}

function isString(v: unknown): v is string {
	return typeof v === 'string';
}

/**
 * Whitelist a manifest entry's `derived` block into `presetId → {@link DerivedEntry}`, field by field —
 * the same hand-rolled, zod-free defensiveness the rest of {@link parseManifest} uses.
 *
 * This function is why `derived` survives at all: `parseManifest` **rebuilds** each entry from an
 * explicit field list, so anything not named here is silently dropped. Any field the writer adds to a
 * derivative must be added here too or it vanishes before the reader ever sees it.
 *
 * @param raw - The entry's raw `derived` value (usually an object; anything else is ignored).
 * @returns The narrowed map, or `undefined` when there is nothing usable — so a pre-Item-15 manifest
 *   keeps the key absent rather than gaining an empty object.
 *
 * Concerns / future improvements: preset ids are taken verbatim (they become a path segment on the
 * reader side), and `skipped` is kept as a plain `string` rather than a union so a writer that adds a
 * new skip reason doesn't make older readers drop the entry.
 */
function parseDerived(raw: unknown): Record<string, DerivedEntry> | undefined {
	if (!raw || typeof raw !== 'object') return undefined;
	const out: Record<string, DerivedEntry> = {};
	for (const [preset, entryRaw] of Object.entries(raw as Record<string, unknown>)) {
		if (!entryRaw || typeof entryRaw !== 'object') continue;
		const d = entryRaw as Record<string, unknown>;
		out[preset] = {
			file_name: typeof d.file_name === 'string' ? d.file_name : undefined,
			size: typeof d.size === 'number' ? d.size : undefined,
			width: typeof d.width === 'number' ? d.width : undefined,
			height: typeof d.height === 'number' ? d.height : undefined,
			ssim: typeof d.ssim === 'number' ? d.ssim : undefined,
			recipe: typeof d.recipe === 'string' ? d.recipe : undefined,
			source_size: typeof d.source_size === 'number' ? d.source_size : undefined,
			generated_at: typeof d.generated_at === 'string' ? d.generated_at : undefined,
			skipped: typeof d.skipped === 'string' ? d.skipped : undefined
		};
	}
	return Object.keys(out).length > 0 ? out : undefined;
}
