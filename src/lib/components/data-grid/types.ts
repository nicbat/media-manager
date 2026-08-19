/**
 * Side-agnostic data model for the shared {@link DataGrid}. A host's native row shape (e.g. the
 * file-first `FileItem` or a json record) may not leak past its adapter: each host maps its native
 * rows to {@link GridItem} and feeds the grid these normalized values only. This is what lets one
 * grid serve both the files hub and the json record views without re-introducing the legacy
 * linked/unlinked/excluded model (those concepts have no representation here).
 */

export type GridSize = 'small' | 'medium' | 'large';

/** A small membership/label badge under a tile (e.g. a class name, or a muted "unclassified"). */
export interface GridChip {
	label: string;
	/** `muted` renders a low-emphasis hint (e.g. "unclassified"); defaults to a solid secondary chip. */
	tone?: 'default' | 'muted';
	/** Optional leading icon — a stored {@link IconId}; rendered via `EntityIcon` (e.g. a class icon). */
	icon?: string;
	/** Generic glyph used when `icon` is missing/unknown (required to render any icon at all). */
	iconFallback?: import('$lib/core/icons.js').IconId;
}

/** One tile in the grid. Carries only what a tile renders — no native row fields survive here. */
export interface GridItem {
	id: string;
	/** Filename / record name / id fallback — already resolved by the host adapter. */
	primaryLabel: string;
	/**
	 * Optional muted secondary line under the primary label (e.g. a record subtitle). Currently
	 * unused by the Files tiles; wired in for hosts that want a subtitle under each tile.
	 */
	secondaryLabel?: string;
	/** Blob bytes URL for an image thumbnail; omit to render the file-icon fallback. */
	thumbnailUrl?: string;
	/**
	 * Intrinsic aspect ratio (width / height) of the thumbnail, when known. Used only by the masonry
	 * layout to estimate a tile's height for column-balancing — it is never turned into a fixed pixel
	 * height, so a wrong/absent value only makes columns slightly less balanced, never clips a tile.
	 * Omit (or non-positive) for non-image rows / unmeasured blobs: the tile falls back to a square.
	 */
	aspectRatio?: number;
	chips: GridChip[];
	/** Count of chips beyond those in `chips` (renders a trailing "+N"). */
	extraChips?: number;
	/**
	 * Verbose-mode metadata rows (Item 8): a small, ordered set of `{ label, value }` pairs the host has
	 * already resolved (label-cased key + stringified value, `''` when empty). When present and non-empty
	 * the tile renders these as key/value rows under the primary label, in both grid variants; absent ⇒
	 * the compact tile is unchanged. The host caps the count (≤ `MAX_VERBOSE_FIELDS`); the grid just
	 * renders what it's given.
	 */
	fields?: { label: string; value: string }[];
	/** A warning to surface on the tile, e.g. "Missing file reference: cover". */
	warning?: string;
}

/** Presentational configuration injected by the host. */
export interface GridConfig {
	size: GridSize;
	/**
	 * Tile presentation. `thumbnail` (default) renders an image/file-icon square with a small label
	 * beneath it (the files hub). `text` is name-forward: the `primaryLabel` fills the square, with no
	 * thumbnail — used for json records, which have no blob to preview.
	 */
	variant?: 'thumbnail' | 'text';
	/**
	 * Selection mode is active. When true, clicking a tile toggles its selection (and a selected tile
	 * is marked with a primary ring) instead of opening it; when false, clicking opens the editor and
	 * tiles are never selectable. The host owns the mode (toggled by a header button).
	 */
	selectable: boolean;
	/** Highlight the tile whose item is open in an editor. */
	activeId?: string | null;
	/** Header text for a group key (host already stringified the group value into the key). */
	groupLabel?: (groupKey: string) => string;
	/** Message shown when there are no items. */
	emptyText?: string;
}

/** Interaction callbacks. The grid never mutates data or reads a host's selection store directly. */
export interface GridCallbacks {
	/** Single click on a tile when not in selection mode (open editor). */
	onOpen: (id: string) => void;
	/**
	 * Toggle the tile's selection (the click action while `config.selectable` is true). `shiftKey`
	 * reports whether Shift was held, so the host can extend a range from its anchor instead of
	 * toggling a single tile; the grid itself keeps no anchor.
	 */
	onToggleSelect?: (id: string, shiftKey?: boolean) => void;
	/** Whether a tile is currently selected. */
	isSelected?: (id: string) => boolean;
	/**
	 * Select or deselect a whole set of ids at once. Supplying this (together with `isSelected`) is
	 * what makes the grid render a tri-state checkbox in each group header while `config.selectable`
	 * is on; the master "select all" lives in the host's own bulk bar, over the same callback.
	 */
	onSetSelected?: (ids: string[], selected: boolean) => void;
}

/** Min tile column width (px) for each grid size. */
export function gridColMin(size: GridSize): number {
	return size === 'small' ? 110 : size === 'large' ? 200 : 140;
}
