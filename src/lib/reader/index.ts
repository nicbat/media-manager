/**
 * `media-manager/reader` — the read-only, build-time data layer for consuming a media-manager
 * workspace in a host build (galleries, record lists) without booting the editor.
 *
 * Pure (no `fs`/`process.env`/network/writes); reads already-parsed workspace JSON + a host-supplied
 * asset map. The Vite entry point (`media-manager/reader/vite`) re-exports this with the
 * `import.meta.glob`-friendly `MediaManager.load`. See `./README.md`.
 */

export { MediaManager } from './media-manager.js';
export type {
	ParsedWorkspace,
	WorkspaceGlobs,
	ReaderOptions,
	ClassSummary,
	TypeSummary
} from './media-manager.js';
export {
	PostCollection,
	POSTS_THEMES,
	DEFAULT_POSTS_THEME,
	type PostItem,
	type PostsOptions,
	type PostsTheme
} from './posts.js';
export { Collection, type FieldAccessible } from './collection.js';
export {
	MediaItem,
	MMRecord,
	type ReaderContext,
	type VariantInfo,
	type SrcsetOptions
} from './items.js';
export {
	parseManifest,
	WorkspaceFormatError,
	SUPPORTED_MANIFEST_VERSION,
	type Manifest,
	type ManifestFileEntry,
	type DerivedEntry
} from './manifest.js';
export { normalizeUrlValue, normalizeFieldValue, type UrlValue } from './values.js';
