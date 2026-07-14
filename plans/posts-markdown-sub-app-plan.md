# Plan: "Posts" — a Markdown writing sub-app

**Backlog item:** [`FUTURE_CHANGES.md` Item 14](FUTURE_CHANGES.md#14--posts--a-markdown-writing-sub-app) · **Status:** ready · **Size:** L (multi-day, design-heavy)

A fourth sub-app (peer to **Files / Records / Globals**) for authoring blog posts in Markdown that embed photos from the Files library. Structurally it mirrors the **Records** sub-app but stores `.md` files instead of JSON records, and the **reader package** — which host sites already depend on — grows a `posts()` capability that renders a post to finished HTML with every image reference resolved.

Companion visual design: the HTML plan built during the design interview (Posts sub-app wireframe, the four photo blocks source↔rendered, the reader integration). This document is the **file-grounded build plan** — real seams, real paths.

## Locked design (no open questions)

- **Storage:** `.md` edited in place at `<root>/posts/<collection>/<slug>.md` (filename = slug). Multiple named collections per workspace (like Records `json` types), registered in `posts/settings.json` (collection order + per-collection typed frontmatter hints).
- **Body — markdown-first hybrid:** prose is Markdown; layout blocks are self-contained **HTML islands** keyed by `mm-*` classes (`mm-inline`, `mm-beside` + `data-side`, `mm-pair`, `mm-bleed`); code blocks stay **native fenced Markdown**.
- **Frontmatter:** freeform key/value, typed-per-field like Globals (so `cover` gets a file picker, `date` a date field), serialized to plain YAML; file refs stored as `cover: mm://<uuid>`.
- **Editor:** Notion-style block editor on **TipTap/ProseMirror** — custom node per `mm-*` photo block wired to the existing `FilePicker`, a lowlight code block, a `/` slash menu, an Edit/Preview toggle, shared `createAutosave`.
- **Image refs:** `mm://<uuid>` everywhere (frontmatter + inline images + HTML islands), resolved by the **reader** at build time — not per-site plugins.
- **Rendering owned by the reader:** `mm.posts(collection).bySlug(slug)/.all()` → `{ meta, html }`; bundled **Shiki** highlights fenced code at build time (themeable, default sensible; nicb.at passes `catppuccin-mocha`); ships block CSS as the subpath `media-manager/reader/posts.css` + a tiny copy-button enhancer.
- **Seed:** nicb.at **Words** + **Now**; migrate `lazy_loading.md` → Words and `/now` → Now (dates → ISO). Ariel Blog + per-site prose theming deferred.

## Key seams (verified against the tree)

- **Reader** (`src/lib/reader/`) is a pure, self-contained module compiled independently via `tsconfig.reader.json` → `dist/reader/`. `MediaManager.load({data, files})` classifies two `import.meta.glob` maps by path regex in `classifyGlobs()` (`media-manager.ts`), builds a `ParsedWorkspace`, and exposes `media()/records()/globals()/file()/record()`. Subpath exports in `package.json` are `./reader` and `./reader/vite`. **No markdown / yaml / shiki / tiptap deps are declared** (only `js-yaml` resolves transitively). Assets are keyed by basename; the `files` glob targets `media/files/*`.
- **Storage** records pattern is fully mirrorable: `paths.ts` centralizes layout, `settingsFile.ts` reads/writes per-type `settings.json`, `jsonRepo.ts` is the record-CRUD factory, `recordsSettings.ts` is the collection-order store, `json.ts` already exposes `readTextFile`/`writeTextFileAtomic` (needed for `.md`), `lock.ts` gives `withFileLock`, `filenames.ts` gives `assertSafeBasename`. The Globals typed-hint pattern (`__field_kinds`/`__field_meta` in `fieldKeys.ts`, synthesized in `jsonRepo.globalsSyntheticSchema`) is the model for per-collection frontmatter hints.
- **Sub-app shell:** Globals is the closest peer (`/globals/+page.svelte` mounts `EntityRail current="globals"` + a bespoke pane). `SubAppSwitcher.svelte`, `CommandPalette.svelte`, and `EntityRail.svelte` all hardcode the union `'files' | 'records' | 'globals'` — **each must gain `'posts'`**. `+layout.svelte` needs no change. `FilePicker.svelte` (`bind:value` a `file_id` + `onSelect`) is directly reusable for `mm://` block insertion.

---

## Phase 1 — Backend spine (storage + posts settings + frontmatter seam)

On-disk `<root>/posts/<collection>/<slug>.md` CRUD, `posts/settings.json` collection registry with per-collection typed frontmatter hints, YAML frontmatter parse/serialize.

**Modify:**
- `src/lib/storage/paths.ts` — `POSTS_DIR_NAME='posts'`, `getPostsDir()`, `getPostsSettingsPath()`, `getPostCollectionDir(collection)`, `getPostFilePath(collection, slug)`, `listPostCollectionIds()`, `listPostSlugs(collection)`. Mirror `getMediaTypeBaseDir`/`listMediaTypeIds`.
- `src/lib/storage/mediaTypes.ts` — add `'posts'` to `RESERVED_TYPE_FOLDER_NAMES` (no `json` type may collide with the structural `posts/` dir).

**Create:**
- `src/lib/storage/postsRepo.ts` — `createPostsRepoForCollection(collection)`: `listPosts()` (slug + parsed frontmatter title/date), `readPost(slug)`, `writePost(slug, {frontmatter, body})` (serialize under `withFileLock` + `writeTextFileAtomic`), `createPost`, `renamePost` (rename the `.md` — filename IS the slug), `deletePost`.
- `src/lib/storage/postsSettings.ts` — `<root>/posts/settings.json`: `{ collectionOrder: string[], collections: Record<id, { displayName, icon?, fieldHints: Record<key,{kind, meta?}> }> }`. Mirror `recordsSettings.ts`; `fieldHints` is the per-collection analog of Globals `__field_kinds`/`__field_meta`.
- `src/lib/storage/frontmatter.ts` — `parseFrontmatter(raw)` / `serializeFrontmatter(frontmatter, body)`. **Needs a YAML dep.** File refs round-trip as `cover: mm://<uuid>` verbatim.
- `src/lib/storage/postsRepo.test.ts`, `src/lib/storage/frontmatter.test.ts`.

**Risk:** slug-as-filename rename races / collisions — per-collection `withFileLock` + `assertSafeBasename(slug + '.md')`, reuse `createMediaType`'s `-n` suffix loop.

## Phase 2 — API routes + sub-app shell

`/api/posts/...` surface + a `/posts` route listing collections/posts, opening an editor via `?collection=&post=`.

**Modify:**
- `src/lib/components/rail/SubAppSwitcher.svelte` — add `{ id:'posts', label:'Posts', href:'/posts', icon }` and widen `current`.
- `src/lib/components/rail/EntityRail.svelte` — widen `current?` union with `'posts'`.
- `src/lib/components/CommandPalette.svelte` — Posts sub-app item + a "Collections" group → `/posts?collection=` (mirror the Record-types group).
- `src/lib/api/client.ts` — `apiListPostCollections`, `apiCreate/Rename/DeletePostCollection`, `apiListPosts`, `apiGet/Write/Create/Rename/DeletePost`, `apiGet/UpdatePostCollectionSettings`.

**Create:**
- `src/routes/api/posts/+server.ts` (list collections / create), `.../[collection]/+server.ts` (get/rename/delete), `.../[collection]/settings/+server.ts`, `.../[collection]/posts/+server.ts` (list/create), `.../[collection]/posts/[slug]/+server.ts` (read/write/rename/delete).
- `src/routes/posts/+page.svelte` — `EntityRail current="posts"` + collection/post list body; reads `?collection=&post=`; hosts the editor. Model deep-link handling on `media/[typeId]/+page.ts`'s `?type=`.
- `src/lib/components/PostsEditorPane.svelte` — editor host: frontmatter panel + body editor + `createAutosave` + Edit/Preview toggle. Reuses `FieldInput` for typed frontmatter rows exactly as `GlobalsEditorPane` builds a synthetic def from field hints.
- `src/lib/components/posts/PostsFrontmatterPanel.svelte` — Globals-style typed key/value table (`cover`→FilePicker via `FieldInput` `file`, `date`→`DateField`).

**Risk:** two-level rail nav (collection selector + post list) vs. Records' single level — reuse `?collection=` exactly like `?type=`; collection switch is a rail dropdown.

## Phase 3 — TipTap block editor (HIGHEST RISK — spike first)

Notion-style editor with `mm-*` photo blocks, lowlight code block, `/` slash menu, and markdown-first serialization.

**Modify:** `src/lib/components/PostsEditorPane.svelte` — mount the editor; wire `getMarkdown()`/`setMarkdown()` to autosave + the Edit/Preview toggle.

**Create:**
- `src/lib/components/posts/PostBodyEditor.svelte` — the TipTap `Editor` host (mount/destroy, content in/out).
- `src/lib/components/posts/tiptap/serialize.ts` — **the load-bearing seam:** ProseMirror doc ↔ markdown for prose; `mm-*` custom nodes ↔ verbatim HTML islands; code nodes ↔ fenced blocks.
- `src/lib/components/posts/tiptap/nodes/MmPhotoBlock.ts` (+ variants) — custom nodes whose `renderHTML` emits the exact islands and whose node view wires "pick photo" to `FilePicker.svelte`, storing `mm://<uuid>`.
- `src/lib/components/posts/tiptap/SlashMenu.ts` + `SlashMenu.svelte`, `.../CodeBlock.ts` (lowlight → fenced), and `.../*.test.ts` round-trip tests.

**Risk (was the project-wide riskiest unknown — now DE-RISKED; see "Riskiest unknown" below):** round-trip fidelity of `md → doc → md`. A spike (2026-07-08) proved it byte-stable **and** idempotent for all three shapes; **bridge decided: `prosemirror-markdown`** with a custom serializer + an `html_island` atom node. Build the editor against that recipe; honor the one constraint (island children carry no internal blank lines).

## Phase 4 — Reader `posts()` + `posts.css` + Shiki

`mm.posts(collection).bySlug(slug)/.all()` → `{ meta, html }` with every `mm://` resolved; fenced code highlighted at build time; block CSS shipped as a subpath.

**Modify:**
- `src/lib/reader/media-manager.ts` — extend `WorkspaceGlobs`/`ParsedWorkspace` with `posts?`; extend `classifyGlobs` to match `posts/<collection>/<slug>.md` + `posts/settings.json`; accept the `?raw` posts glob in `load()`; add `posts(collection)` + a `PostCollection` reader (`.all()`/`.bySlug()`).
- `src/lib/reader/index.ts` + `vite.ts` — export `PostItem`/`PostCollection`/theme types + the `posts()` surface.
- `package.json` — add `exports["./reader/posts.css"]`; add `shiki` + a markdown parser + YAML to `dependencies`; keep `files` shipping the CSS.
- `tsconfig.reader.json` — verify Shiki (ESM) resolves under the standalone reader compile; CSS ships as a static file, not compiled.

**Create:**
- `src/lib/reader/posts.ts` — `PostCollection`/`PostItem` + the render pipeline: parse frontmatter (must match `storage/frontmatter.ts`), render markdown, resolve every `mm://<uuid>` (frontmatter values + inline `![](mm://…)` + island `src`/`data-*`) via the existing asset index, highlight fenced code with Shiki (theme from a `load` option), emit copy-button markup.
- `src/lib/reader/posts.css` — the `mm-inline`/`mm-beside`/`mm-pair`/`mm-bleed` block styles (shipped subpath).
- `src/lib/reader/posts-enhancer.ts` — the tiny copy-button enhancer.
- `src/lib/reader/posts.test.ts` — `fromParsed` with inline `posts` fixtures asserting `mm://` resolution + Shiki output + island passthrough.

**Risk:** Shiki init inside the reader's **sync** `load` contract + its bundle size — use Shiki's sync/bundled highlighter (or pre-create a highlighter with an eager theme set at `load` time); keep the reader "no async."

## Phase 5 — Wire + migrate nicb.at (Words + Now)

nicb.at consumes `mm.posts()`; migrate content; normalize dates to ISO. (Files live in `~/Projects/nicb.at`, out of media-manager scope but cited.)

- `~/Projects/nicb.at/src/lib/index.ts` — pass the third `posts` glob to `MediaManager.load`; expose `mm.posts('words')`/`mm.posts('now')`; retire the hand-rolled `fetchMarkdownPosts`.
- `~/Projects/nicb.at/svelte.config.js` — confirm `$assets` covers `posts/**/*.md` (`?raw`).
- nicb.at `/words` + `/now` routes — `import 'media-manager/reader/posts.css'`; render `{ html }`.
- `<workspace>/posts/settings.json` + `posts/words/lazy_loading.md` + `posts/now/<slug>.md` — migrated content, ISO dates (`'250207'` → ISO), `mm://` cover refs where applicable.

**Risk:** date normalization + non-markdown `/now` structure — one-off migration note; media-manager itself unchanged.

## Phase 6 — Docs + fixtures + upgrade-data

- `docs/FEATURES.md` — Posts sub-app row (route, API index, repo, editor, reader capability) + extend the on-disk layout block.
- `scripts/upgrade-data.mjs` — idempotent step ensuring `<root>/posts/` + `posts/settings.json` exist (mirror the `ensureGlobalsGroupExists` diagnostic; dependency-free).
- `src/lib/reader/README.md` — document the third `posts` glob + `mm.posts()` + `posts.css` subpath + Shiki theme option.
- `test-fixtures/posts/settings.json` + `posts/words/<slug>.md` + `posts/now/<slug>.md` — a minimal seed (one prose+image post referencing an existing `test-fixtures/media/manifest.json` blob via `mm://`, one code-block post) used by the repo tests + `scripts/serve-test.mjs`; `test-fixtures/README.md` updated.

**Risk:** fixture `mm://` uuids must match `test-fixtures/media/manifest.json` — reference an existing manifest id.

---

## New dependencies

| Dep | Where | Why |
| --- | --- | --- |
| `shiki` | reader | Build-time fenced-code highlighting in `posts()`; themeable; bundled once, not per-site. |
| `markdown-it` (or `marked`) | reader + storage | Markdown→HTML for post bodies. `markdown-it` preferred — pluggable renderer rules make `mm://` link/image resolution + HTML-island passthrough easier. |
| `yaml` (or declare `js-yaml`) | storage + reader | Frontmatter parse/serialize on both sides. Declare explicitly so the standalone-compiled reader has a first-class dep. |
| `@tiptap/core` + `@tiptap/pm` + `@tiptap/starter-kit` | editor only | ProseMirror-based block editor foundation. |
| `@tiptap/extension-code-block-lowlight` + `lowlight` | editor only | Native fenced code block in the editor. |
| `prosemirror-markdown` | editor only | Markdown↔ProseMirror bridge. **Spike-confirmed (2026-07-08):** byte-stable + idempotent round-trip for prose/islands/fenced code via a custom serializer + an `html_island` atom node. `tiptap-markdown` rejected — needs a DOM in Node and gives less serializer control. |

## Riskiest unknown — RESOLVED ✅ (spike, 2026-07-08)

The project-wide risk was **markdown-first round-trip fidelity**. A throwaway spike (`prosemirror-markdown` + `markdown-it` + a custom `html_island` atom node, run headless in Node) proved:

- **Byte-stable** `md → doc → md` for all three shapes: prose + inline `mm://` image (incl. `**bold**`/`*italic*`/links), a `mm-beside data-side` HTML island, and a fenced code block (language preserved).
- **Idempotent** — `rt(rt(x)) === rt(x)`: once the editor saves, a re-save is a no-op. This is the guarantee that actually matters (posts can't silently rot from being opened and saved).
- **Island opacity** — an island parses to a *single atom node*; the editor never re-flows its internals.
- **One constraint** — a blank line *inside* an island tears it into pieces (CommonMark HTML-block type 6 ends at a blank line). Mitigation is trivial: each `mm-*` node's `renderHTML` emits its children with no blank lines between them (we control it).

**Recipe locked for Phase 3:** extend the `prosemirror-markdown` schema with an `html_island` atom (`attrs: { html }`); map `html_block` tokens → `html_island`; serialize by writing `attrs.html` verbatim + `state.closeBlock(node)`; keep fenced code as the default `code_block` (`params` = language). No community markdown extension, no `tiptap-markdown`, no DOM needed for the (de)serializer.

---

# Build reference (context-free appendix)

> Everything below is the concrete detail an implementer needs **without** the original design conversation. The visual design artifact (Posts wireframe + block mockups) was a communication aid on claude.ai and is intentionally not in the repo — the load-bearing part of it (the block markup) is captured here.

## A. Canonical block markup — the single source of truth

These exact HTML shapes are the contract shared by **(1)** each TipTap node's `renderHTML`, **(2)** the reader's island passthrough, and **(3)** `posts.css`. **Rule (from the spike): no blank lines between an island's children** — write each island's inner lines contiguously, or markdown-it will tear it apart on the next open. `mm://<uuid>` stays verbatim on disk in every `src`; only the reader (build) / the live API (editor) rewrite it.

**Inline single** — one photo, optional caption:
```html
<figure class="mm-inline">
  <img src="mm://<uuid>" alt="<alt>">
  <figcaption><caption></figcaption>
</figure>
```

**Text beside image** — prose column + image column; `data-side` = which side the image sits (`right` default, `left` mirrors); stacks on mobile:
```html
<div class="mm-beside" data-side="right">
  <div class="mm-text"><p><prose…></p></div>
  <figure><img src="mm://<uuid>" alt="<alt>"></figure>
</div>
```

**Side-by-side pair** — two captioned photos in a row (stack on mobile):
```html
<div class="mm-pair">
  <figure><img src="mm://<uuid-a>" alt="<alt>"><figcaption><cap-a></figcaption></figure>
  <figure><img src="mm://<uuid-b>" alt="<alt>"><figcaption><cap-b></figcaption></figure>
</div>
```

**Full-bleed banner** — breaks out of the prose column, edge to edge; optional overlaid caption:
```html
<figure class="mm-bleed">
  <img src="mm://<uuid>" alt="<alt>">
  <figcaption><caption></figcaption>
</figure>
```

**Code** is *not* an island — it stays a native fenced block (```` ```lang ````), highlighted by the reader (Shiki).

## B. Golden sample post (`posts/words/tidepooling.md`)

The canonical fixture for `postsRepo.test.ts`, the serializer round-trip tests, and the reader `posts.test.ts`. It exercises frontmatter (incl. a `cover` file ref), prose with marks, an inline image, one `mm-beside` island, and a fenced code block.

````md
---
title: Tidepooling in California's Central Coast
date: 2026-07-07
description: Seeing the unseen at low tide.
cover: mm://82b2c224-e1e8-4960-b084-33c675e8217f
draft: false
---

## Seeing the Unseen

At first glance, outside of the giant green anemones, the rock looks **barren** — until life reveals itself.

![A coastal shrimp hiding in red algae](mm://139335c7-ef59-4331-8888-96dcc86a3c6e)

<div class="mm-beside" data-side="right">
  <div class="mm-text"><p>Every cliffside hides its own world; you just have to wait for the tide.</p></div>
  <figure><img src="mm://a1b2c3d4-0000-0000-0000-000000000001" alt="A tidepool"></figure>
</div>

A quick script I use to log finds:

```bash
tidelog() {
  echo "$(date -I) $*" >> ~/tides.txt
}
```
````

## C. Data shapes

**`posts/settings.json`** (collection registry + per-collection frontmatter hints — the Globals `__field_kinds`/`__field_meta` analog):
```jsonc
{
  "collectionOrder": ["words", "now"],
  "collections": {
    "words": {
      "displayName": "Words",
      "icon": "pen-line",                        // optional Lucide id (core/icons.ts)
      "fieldHints": {
        "title":       { "kind": "string" },
        "date":        { "kind": "date" },
        "description": { "kind": "string" },
        "cover":       { "kind": "file" },        // → FilePicker; value is mm://<uuid>
        "draft":       { "kind": "boolean" }
      }
    },
    "now": { "displayName": "Now", "fieldHints": { "date": { "kind": "date" } } }
  }
}
```
`fieldHints` drives the editor's typed inputs only; the `.md` YAML is plain. Keys with no hint fall back to a string input. A `file`-kind value is stored/round-tripped as `mm://<uuid>`.

**Reader `posts()` surface** (mirror the existing `MediaItem`/`Collection` style in `src/lib/reader/`):
```ts
MediaManager.load({ data, files, posts });          // posts: Record<path, string> (?raw glob)
// options: load(globs, { posts?: { theme?: ShikiThemeName } })

interface PostItem {
  collection: string;
  slug: string;                    // = filename without .md
  meta: Record<string, unknown>;   // frontmatter, with file-ref values resolved to URLs
  html: string;                    // rendered body; every mm:// resolved; code highlighted
}
interface PostCollection {
  all(): PostItem[];               // sorted by frontmatter `date` desc when present
  bySlug(slug: string): PostItem | undefined;
}
mm.posts(collection: string): PostCollection;
```

## D. Two `mm://` resolution paths — do not conflate

`mm://<uuid>` is the on-disk form everywhere. It is resolved differently depending on *who is rendering*:

| Context | Resolves `mm://<uuid>` to | When |
| --- | --- | --- |
| **Editor** (in-app: node-view thumbnails + the **Preview** tab) | the live blob endpoint `/api/files/<uuid>/blob` | at runtime, dev/edit server |
| **Reader** (host site build) | the hashed asset URL via the existing asset index (`file(uuid)`) | at build time |

**Preview mode is client-side and does NOT use the reader** (the reader is build-time and needs the glob maps). The editor's Preview renders the current body with a browser markdown-it pass + `posts.css`, rewriting `mm://<uuid>` → `/api/files/<uuid>/blob`. Keep one small shared client renderer for Preview; the reader owns the build-time render independently (they must produce the same HTML structure — same block markup, same `posts.css`).

## E. `posts.css` — starter (shipped as `media-manager/reader/posts.css`)

Layout only; sites theme prose/fonts themselves (per-site prose theming was deferred). Full-bleed uses a viewport-width break-out.
```css
.mm-inline { margin: 1.5rem 0; }
.mm-inline img { width: 100%; height: auto; border-radius: 6px; display: block; }
.mm-inline figcaption { font-size: 0.85em; opacity: 0.75; margin-top: 0.4rem; }

.mm-beside { display: grid; grid-template-columns: 1fr 1fr; gap: 1.25rem; align-items: center; margin: 1.5rem 0; }
.mm-beside[data-side="left"] { direction: rtl; }        /* image column first */
.mm-beside[data-side="left"] > * { direction: ltr; }
.mm-beside img { width: 100%; height: auto; border-radius: 6px; display: block; }

.mm-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; margin: 1.5rem 0; }
.mm-pair img { width: 100%; height: auto; border-radius: 6px; display: block; }
.mm-pair figcaption { font-size: 0.85em; opacity: 0.75; margin-top: 0.35rem; }

.mm-bleed { position: relative; width: 100vw; left: 50%; margin: 2rem 0 2rem -50vw; }
.mm-bleed img { width: 100%; height: auto; max-height: 70vh; object-fit: cover; display: block; }
.mm-bleed figcaption { position: absolute; left: 1rem; bottom: 1rem; color: #fff; text-shadow: 0 1px 8px rgba(0,0,0,.5); }

@media (max-width: 640px) {
  .mm-beside, .mm-pair { grid-template-columns: 1fr; }
}
```

## F. Migration specifics (Phase 5, nicb.at)

- **`lazy_loading.md`** → `posts/words/lazy-loading.md`. Its current frontmatter is `title` / `description` / `date` where **`date: '250207'`** is `YYMMDD` — normalize to ISO `2025-02-07`. Body is already Markdown (mdsvex) with fenced code + inline `<br/>` — keep as-is; no `mm://` (no images).
- **`/now`** currently is a Svelte route, not markdown — its prose must be hand-lifted into `posts/now/<slug>.md` frontmatter+body during migration (small, one-off).
- After: nicb.at's `/words` + `/now` render via `mm.posts('words')` / `mm.posts('now')`; retire `fetchMarkdownPosts`; `import 'media-manager/reader/posts.css'` once.
