# `media-manager/reader`

Read a [media-manager](../../../README.md) workspace from a host build — galleries, record lists,
metadata — **without running the editor**. Pure, read-only, and layout-aware: you never hand-code a
path into the workspace that breaks when media-manager's on-disk format moves.

- **Build-time / static.** Designed for a host that bundles the workspace with Vite (`import.meta.glob`)
  and resolves image URLs through its own asset pipeline (hashed, content-addressed). No server, no
  `fs`, no `process.env`, no network — just functions over already-parsed JSON.
- **One object.** Load once, then `media()` / `records()` / `globals()` / `file()`. Items are flat;
  filtering is a tiny fluent collection. The manifest join, url normalization, extension-case asset
  matching, and missing-file handling are all hidden.

> Scope: this is the **data layer** only. It does not ship UI components — you render with your own.

> New here? The 60-second mental model, the `load()` breakdown, and the manifest×asset join are
> diagrammed in [`docs/reader-package-design.html`](../../../docs/reader-package-design.html).

## How it works, in one breath

Your bundler (Vite) reads the workspace files and hands the reader **two maps** — the parsed JSON and
a `{ filename → hashed-URL }` asset map. `MediaManager.load()` joins them once (manifest gives every
blob a stable id; the asset map turns a filename into a served URL) and hands back flat, iterable
items. Load once at module scope, query many times. That's the whole model.

## Install

While unpublished, depend on it locally (a sibling checkout) or from git:

```jsonc
// host package.json
"dependencies": { "media-manager": "file:../media-manager" }
// or: "media-manager": "github:nicbat/media-manager#v1.x"
```

The subpath ships prebuilt JS + `.d.ts` (built by `npm run build:reader`; runs automatically on
`prepublishOnly`). For a local `file:` dependency, run `npm run build:reader` in the media-manager
checkout once so `dist/reader/` exists.

## Set up your host

Two things get wired up **once**: the workspace has to live where your bundler can see it, and an
alias makes the glob paths resolve. Using SvelteKit (as [nicb.at](../../../README.md) does):

**1 · Put the workspace inside your app.** Commit it under `src/assets/` — nicb.at commits the whole
tree. Vite can only bundle files that live in the project, so a folder _outside_ the repo won't work
for a static build.

```
src/assets/media_manager/
├─ settings.json
├─ media/
│  ├─ manifest.json
│  ├─ classes/<id>.json
│  ├─ files/<blobs>          ← the ?url glob targets this dir
│  └─ derived/<preset>/<blobs>   ← compressed variants (optional; its own ?url glob)
├─ records/<typeId>/{settings.json, data.json}
└─ globals/{settings.json, data.json}
```

**2 · Add the `$assets` alias** so `import.meta.glob('$assets/…')` resolves — in `svelte.config.js`:

```js
// svelte.config.js
const config = {
	kit: {
		alias: { $assets: './src/assets' }
	}
};
```

Plain Vite (no SvelteKit): use a relative glob (`import.meta.glob('../assets/media_manager/**/*.json', …)`)
or add a `resolve.alias` in `vite.config.ts` instead.

**3 · (Recommended) Edit the same folder you bundle.** Drop a `media-manager.config.json` at your repo
root pointing the editor at that folder:

```json
{ "root": "./src/assets/media_manager" }
```

Now `npx media-manager` (the editor) reads and writes the _exact_ workspace your site bundles: edit,
commit, redeploy. One source of truth — no export step, no copy.

## A photos gallery in ~15 lines

```svelte
<script>
	import { MediaManager } from 'media-manager/reader/vite';

	const mm = MediaManager.load({
		data: import.meta.glob('$assets/media_manager/**/*.json', { eager: true, import: 'default' }),
		files: import.meta.glob('$assets/media_manager/media/files/*', {
			eager: true,
			query: '?url',
			import: 'default'
		})
	});

	const photos = mm.media('photos').where({ hidden: false });
</script>

{#each photos as photo (photo.id)}
	<img src={photo.src} width={photo.width} height={photo.height} alt={photo.field('name')} />
{/each}
```

That's the only glue you write. `MediaManager.load` takes **two** globs — one for the JSON (parsed),
one for the asset files (`?url`, so Vite hashes + serves them). Vite requires the glob paths to be
string literals, so they live in your code; the reader figures out what each entry is (manifest /
class / record type / globals / asset) **from its path**, so this snippet is the same for every host
— only the `$assets/media_manager` prefix changes.

## Static assets — serve blobs from a CDN instead of bundling them

The `files` `?url` glob above makes Vite **bundle every blob** into your build — ideal for a small
workspace (content-hashed, immutable URLs), but on a size-capped host (e.g. a Vercel serverless
function, 250 MB) a large photo library blows the limit: the bundler copies the binaries into the
function even though nothing on the server reads their bytes.

**Static-assets mode** fixes this. Drop the `files` glob and pass a `baseUrl` instead; the reader
synthesizes each blob's URL from the manifest (`` `${baseUrl}/${encodeURIComponent(file_name)}` ``),
so you serve the binaries from a static folder / CDN and never bundle them:

```svelte
<script>
	import { MediaManager } from 'media-manager/reader/vite';

	const mm = MediaManager.load(
		{
			data: import.meta.glob('$assets/media_manager/**/*.json', { eager: true, import: 'default' })
		},
		{ assets: { baseUrl: '/media' } } // ← no `files` glob; blobs served from /media/<file>
	);
</script>
```

Put the binaries where your framework serves static files at that base URL — SvelteKit `static/media/`,
Next.js / Astro `public/media/` (both served at `/media`). The **editor can store them there directly**:
add an `assets` block to `media-manager.config.json` and it writes blobs to that folder instead of
inside the workspace (`npx media-manager config` auto-detects it; `media-manager export <dir>` reunites
everything back into one self-contained tree when you need it):

```json
{ "root": "./src/assets/media_manager", "assets": { "dir": "./static/media", "baseUrl": "/media" } }
```

- **A `files` glob always wins.** `baseUrl` only fills the asset map when no glob populated it, so the
  two modes never fight — keep the glob for small workspaces, switch to `baseUrl` when size bites.
- **Dimensions are unaffected** — they come off the manifest, not the bundler.
- **Compressed variants come along** — derivatives are synthesized one directory deeper,
  `` `${baseUrl}/derived/<preset>/<file>` ``, so `item.variant('web')` works in static mode with no extra
  wiring (see [Compressed variants](#compressed-variants--serve-a-smaller-image)). That's gated
  separately from the originals, so a `derived` glob and a `baseUrl` can coexist in either direction.
- **Cache-busting is on you — and it actually matters for derivatives.** Static URLs aren't
  content-addressed. Originals rarely hit this (camera-unique names, never replaced), but **compressed
  derivatives are regenerated in place under the same filename** whenever you change a preset's quality,
  so their bytes change at an address a browser or CDN already believes it knows. The editor serves them
  with `Cache-Control: public, max-age=3600`; in static mode nothing does that for you, so **set an
  explicit, bounded lifetime on `<baseUrl>/derived/` yourself** — an hour is plenty, and it means a
  preset change reaches every visitor within the hour. On Vercel that's a few lines:

  ```json
  {
  	"headers": [
  		{
  			"source": "/media/derived/(.*)",
  			"headers": [{ "key": "Cache-Control", "value": "public, max-age=3600" }]
  		}
  	]
  }
  ```

  Clean filenames with an _uncontrolled_ lifetime is the one genuinely broken combination — a changed
  image that never reaches anyone. Versioned URLs (`/derived/web.a1b2c3/…`, cacheable forever) are a
  deliberate deferral, not an oversight: see `docs/FUTURE_CHANGES.md` Item 47 for the reasoning and the
  trigger to revisit.

- **Missing blobs become runtime 404s** instead of a build-time signal — run `media-manager doctor`
  (it cross-checks the static folder against the manifest) to recover that check.
- **Keep secrets out of the bundle.** If you used the editor's Google Photos import, it writes an OAuth
  secret to `media/google.json` — and your `**/*.json` data glob will bundle it. Exclude it from the
  glob (`import.meta.glob(['$assets/media_manager/**/*.json', '!**/google.json'])`) or don't commit it.
  (`media-manager export` already omits it; the reader itself ignores it.)

**Migrating an existing bundled workspace to static (classic → static):** the manifest travels with the
workspace, so the blobs just need to move. The easiest way is **in the editor** — open Settings →
**Storage** → _Change location_, set the served folder (e.g. `./static/media` + `/media`), strategy
**Move**, and it relocates every blob and writes the `assets` block to `media-manager.config.json` in one
click (creating the config if there wasn't one). Or do it by hand: add the `assets` block (or `npx
media-manager config`) and move the bytes yourself (`git mv src/assets/media_manager/media/files/*
static/media/`). Either way, **`git add` + commit the moved blobs — that's their only home now**, then on
the reader side drop the `files` glob and pass `{ assets: { baseUrl: '/media' } }`. Run `media-manager
doctor` to confirm the folder matches the manifest before you deploy.

## The object

```js
mm.media(); // every blob in the workspace        → Collection<MediaItem>
mm.media('photos'); // members of the "photos" class       → Collection<MediaItem>
mm.records('projects'); // records of a type                   → Collection<MMRecord>
mm.globals(); // the globals singleton                → MMRecord | null
mm.file(id); // one blob by manifest id              → MediaItem | null
mm.record(id); // one record by id (any type/globals)  → MMRecord | null
mm.classes(); // [{ id, name, icon?, count }]
mm.types(); // [{ id, name, count }]
mm.posts('words'); // a markdown collection               → PostCollection
mm.postCollections(); // [collectionId, …]
```

> The record class is exported as **`MMRecord`** (not `Record`) so it never shadows TypeScript's
> built-in `Record<K, V>` utility type at your import site.

## Item shapes

```ts
MediaItem {
  id: string;
  src: string | null;            // resolved hashed URL — null if the blob is missing/unresolved
  filename: string;
  width: number; height: number; // intrinsic, 0 if unknown
  classes: string[];             // membership
  missing: boolean;
  fields: Record<string, unknown>;     // class metadata (populated only in a class view)
  variants: ReadonlyMap<string, VariantInfo>;  // resolved compressed derivatives, by preset id
  field(key): unknown;                 // value by key (fields first, else intrinsics)
  variant(preset): string | null;      // a compressed variant's URL
  variantInfo(preset): VariantInfo | null;  // …plus its own width/height/size/ssim
  file(key): MediaItem | null;         // follow a file-type field
  files(key): Collection<MediaItem>;   // follow a list-of-files field
  record(key): MMRecord | null;        // follow a record-type field
  records(key): Collection<MMRecord>;  // follow a list-of-records field
}

MMRecord {
  id: string;
  lastModified: string | null;
  fields: Record<string, unknown>;
  field(key);                          // same accessors as MediaItem
  file(key); files(key);               // follow file-type fields
  record(key); records(key);           // follow record-type fields
}
```

`field()` returns the **stored** value (a `url` value is normalized to `{ display_name, url }`). In a
class view (`mm.media('photos')`) `fields` holds that class's per-blob metadata; at the blob level
(`mm.media()`, `mm.file(id)`, a resolved file reference) `fields` is empty, because one blob can
belong to several classes with different metadata.

## Filtering — the `Collection`

Five chainable helpers, plus it's iterable and has `.length` / `.all`:

```js
mm.media('photos')
	.where({ hidden: false }) // field equality (AND across keys)
	.where('Year', '2024') // single field form
	.sortBy('Year', 'desc') // nullish/empty values sort last
	.filter((m) => m.width > m.height) // landscape only
	.first(); // also .find(fn)

mm.records('projects').map((r) => ({ title: r.field('name'), date: r.field('date') })); // → plain array
```

`where` / `filter` / `sortBy` return a `Collection` (chainable, never mutating); `map` returns a plain
array (you're projecting out of the collection into your own shape).

## Following references — never juggle an id

Reference fields store a raw id on disk. `field()` gives you that id; the resolvers follow it to the
real item — the **same** object you'd get from `mm.file(id)` / `mm.record(id)` (identity is shared),
so you get `src`, dimensions, `missing`, nested fields, etc. for free.

**`file`-type fields → blobs** (`file` / `files`):

```js
const p = mm.records('projects').first();
p.field('thumbnail'); // → "8e6973f2-…"  (the stored id)
p.file('thumbnail'); // → MediaItem { id, src, width, height, … }
p.file('thumbnail')?.src;
p.files('gallery'); // → Collection<MediaItem>  (dangling ids dropped, never null)
```

**`record`-type fields → other records** (`record` / `records`) — the exact mirror, for cross-record
links (e.g. a project's `lead` pointing at a `people` record). Resolution is by id across **every**
type + globals, so you don't name the target type:

```js
p.field('lead'); // → "person1"  (the stored id)
p.record('lead'); // → MMRecord { id: 'person1', … }
p.record('lead')?.field('name'); // → "Ada"
p.records('contributors'); // → Collection<MMRecord>  (dangling ids dropped)
```

A dangling reference yields `null` (or is dropped from `files()` / `records()`), never a throw or a
broken render. Because identity is shared, you can chain hops: `p.record('lead').file('avatar')?.src`.

## Compressed variants — serve a smaller image

The editor can generate compressed **derivatives** of each blob under named **presets** (`web`, `thumb`,
…), stored at `media/derived/<preset>/<file>`. The reader joins them onto the item, so you pick a
preset at the render site and fall back to the original when it isn't there.

Pass a **fourth** glob (`?url`, pointed at the preset directories):

```js
const mm = MediaManager.load({
	data: import.meta.glob('$assets/media_manager/**/*.json', { eager: true, import: 'default' }),
	files: import.meta.glob('$assets/media_manager/media/files/*', {
		eager: true,
		query: '?url',
		import: 'default'
	}),
	derived: import.meta.glob('$assets/media_manager/media/derived/*/*', {
		eager: true,
		query: '?url',
		import: 'default'
	})
});
```

Then read a variant off any `MediaItem`:

```js
photo.variant('web'); // → "/assets/sunset.web.hash.webp"  (just the URL, or null)
photo.variantInfo('thumb'); // → { preset, src, width, height, size, ssim } | null
photo.variants; // ReadonlyMap<preset, VariantInfo> — enumerate what exists
```

**Take the dimensions from the variant, not from the item.** A derivative is often _resized_, so its
`width`/`height` are its own — pairing a 400px `thumb` URL with the original's `width` is a layout bug
by construction. The canonical pattern, with the fallback baked in:

```svelte
{@const t = item.variantInfo('thumb')}
<img
	src={t?.src ?? item.src}
	width={t?.width ?? item.width}
	height={t?.height ?? item.height}
	alt=""
/>
```

- **`null` means "not there" — you fall back.** There is deliberately **no nearest-preset fallback**:
  asking for `thumb` never silently hands you the 4000px `web` file. A preset is absent when it was
  never generated, when the editor _skipped_ it (unsupported input, the derivative came out larger than
  the original, or the encode errored), or when its URL didn't resolve in your build. All three look the
  same to you, and `?? item.src` covers all three.
- **Strictly optional.** No `derived` glob and no `baseUrl` ⇒ every `variants` map is empty and
  `variant()` returns `null` everywhere; nothing else changes. A workspace whose manifest predates
  compression behaves identically.
- **Static-assets mode works too** — derivatives are synthesized as `` `${baseUrl}/derived/<preset>/<file>` ``,
  gated independently of the originals.
- **Preset ids are the workspace's**, not the reader's — enumerate with `Object.keys` over a
  representative item's `variants`, or read them off the editor's compression settings.

## Posts — rendered markdown (Item 14)

The **Posts** sub-app stores markdown at `posts/<collection>/<slug>.md`. The reader renders a post to
finished HTML with every image reference resolved and fenced code highlighted — pass a **third** glob
(`?raw`, so the `.md` arrives as a string) and, optionally, a fenced-code theme:

```svelte
<script>
	import { MediaManager } from 'media-manager/reader/vite';
	import 'media-manager/reader/posts.css'; // block + code layout (import once)

	const mm = MediaManager.load(
		{
			data: import.meta.glob('$assets/media_manager/**/*.json', { eager: true, import: 'default' }),
			files: import.meta.glob('$assets/media_manager/media/files/*', {
				eager: true,
				query: '?url',
				import: 'default'
			}),
			posts: import.meta.glob('$assets/media_manager/posts/**/*.md', {
				eager: true,
				query: '?raw',
				import: 'default'
			})
		},
		{ posts: { theme: 'catppuccin-mocha' } } // one of POSTS_THEMES; defaults to github-dark
	);

	const words = mm.posts('words').all(); // PostItem[] — date-desc
</script>

{#each words as post (post.slug)}
	<article>
		<h2>{post.meta.title}</h2>
		{#if post.meta.cover}<img src={post.meta.cover} alt="" />{/if}
		<!-- eslint-disable-next-line svelte/no-at-html-tags -->
		{@html post.html}
	</article>
{/each}
```

A `PostItem` is `{ collection, slug, meta, html }`: `meta` is the frontmatter with every `mm://<uuid>`
value (e.g. `cover`) resolved to its hashed asset URL, and `html` is the rendered body — every `mm://`
(inline `![](mm://…)` images **and** `mm-*` island `src`s) resolved, prose as markdown, the `mm-*`
HTML islands passed through verbatim, and fenced code Shiki-highlighted at build time. Links to other
sites (absolute `http(s)`) render with `target="_blank"` + `rel="noopener noreferrer"` so they open
outside your site; internal/relative links stay in-tab. Pair it with the shipped
`media-manager/reader/posts.css` (layout only — you theme prose yourself). An unresolvable `mm://` ref
is left intact rather than broken. `mm.posts(id)` returns a `PostCollection`
(`.all()` / `.bySlug(slug)`); enumerate collection ids with `mm.postCollections()`.

Bundled code themes (`POSTS_THEMES`): `github-dark` (default), `github-light`, `catppuccin-mocha`,
`catppuccin-latte`. A fenced block whose language isn't in the bundled set degrades to plaintext.

**Optional copy buttons.** A tiny progressive enhancement adds a Copy button to each code block:

```js
import { enhancePosts } from 'media-manager/reader/posts-enhancer';
onMount(() => enhancePosts()); // idempotent; no-ops server-side
```

## Missing files

The reader never produces a broken image: a blob whose asset isn't in your `files` glob (or is flagged
missing on disk) comes back with `src === null` and `missing === true`. Guard in your template:

```svelte
{#each mm.media('photos') as p (p.id)}
	{#if p.src}<img src={p.src} alt={p.field('name')} />{/if}
{/each}
```

## Version guard

`MediaManager.load` / `fromParsed` validates the workspace's `media/manifest.json` and throws a
`WorkspaceFormatError` if it's absent or an unsupported format version — a clear, actionable message
instead of a silently empty gallery. Catch it if you want a friendly fallback:

```js
import { WorkspaceFormatError } from 'media-manager/reader';
try {
	const mm = MediaManager.load({ data, files });
} catch (e) {
	if (e instanceof WorkspaceFormatError) {
		// workspace is stale / not migrated — show a message, run `npm run upgrade-data`
	} else throw e;
}
```

## Migrating a hand-rolled reader

If a host currently reads the workspace by hand (opening `data.json` files, globbing `files/*`,
lowercasing extensions, joining the manifest), the reader replaces all of it. Before/after:

```js
// before — manual: open photos/image-data.json, glob files/*, lowercase exts, filter hidden, build alt
export const fetchImageList = async () => {
	/* ~40 lines */
};

// after
const photos = mm
	.media('photos')
	.where({ hidden: false })
	.map((m) => ({
		src: m.src,
		width: m.width,
		height: m.height,
		alt: [m.field('name'), m.field('Location'), m.field('Year')].filter(Boolean).join(', ')
	}));
```

```js
// before — open projects/data.json, map fields, sort
export const fetchProjects = async () => {
	/* … */
};
// after
const projects = mm.records('projects').sortBy('date', 'desc');
```

A host that pinned the **pre-Item-18** paths (`photos/image-data.json`, `files/*`,
`projects/data.json`) will read nothing once the workspace is migrated to the file-first layout — that
silent breakage is exactly what the reader exists to prevent.

## Troubleshooting — when it renders blank

The reader is deliberately defensive: it never throws on missing data, so a wiring mistake shows up as
_silence_, not an error. The usual suspects, quickest first:

| Symptom                                                       | Likely cause                                                                                     | Fix                                                                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| **All images `src: null` / `missing: true`** — records fine   | `files` glob prefix wrong, or it's missing `query: '?url'`                                       | Point `files` at `…/media/files/*` **with `query: '?url'`**; it must share the `data` prefix         |
| **Everything empty** — `media()` / `records()` all length `0` | The `data` glob matched nothing (wrong prefix, or `$assets` alias unset)                         | Confirm the alias resolves and the prefix matches where the workspace actually lives                 |
| **`WorkspaceFormatError` at load**                            | No `media/manifest.json` under the prefix, or a pre-file-first workspace                         | Point at a migrated workspace; run `npm run upgrade-data -- <root> --apply` on an old one            |
| **One class/type empty**, others fine                         | Typo in the id (`mm.media('phtoos')`)                                                            | List real ids with `mm.classes()` / `mm.types()`                                                     |
| **`field('x')` is `undefined`**                               | Key typo, or the field only exists in a _class view_                                             | Inspect `Object.keys(item.fields)`; blob-level items (`mm.media()`, `mm.file`) have empty `fields`   |
| **`Cannot find module 'media-manager/reader/vite'`**          | `dist/reader/` not built (`file:`/git installs may skip it)                                      | Run `npm run build:reader` in the media-manager checkout                                             |
| **`file()` / `record()` returns `null`**                      | The referenced id is dangling (target was deleted)                                               | Expected — guard with `?.`; not a bug                                                                |
| **`variant('web')` always `null`**                            | No `derived` glob (or wrong prefix / missing `query: '?url'`), or the preset was never generated | Point `derived` at `…/media/derived/*/*` with `query: '?url'`; check `item.variants` for what exists |

## Guarantees

- **Pure / read-only:** no `fs`, no `process.env`, no network, no writes. Feeding it a workspace never
  mutates it.
- **Dependency-light:** plain TypeScript; your Svelte/Vite are peers. (A future release extracts this
  to its own thin package — see FUTURE_CHANGES Item 44.)
- **Single source of truth:** value normalization and reserved-key handling mirror the editor's
  `src/lib/core/` so the reader can't drift from what the editor writes.
