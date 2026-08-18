# Future Changes

Non-committal backlog of deferred improvements identified during codebase audits. **This is not the shipped feature set** — that's [`FEATURES.md`](FEATURES.md). Items here are candidates, not commitments.

> **🚀 1.0 release plan:** a committed subset of these items is scheduled for **1.0** — see [`plans/v1.0/README.md`](plans/v1.0/README.md) (per-feature briefs + the agile interview → HTML-plan → verification process). Committed: Items **8 · 9 · 10 · 3 · 5 · 12 · 13 · 34 · 18 · 19** and the npx sub-project (**30 · 31 · 32 · 33**). When one of those ships, retire it here as usual. (Items **30 · 31 · 32** shipped 2026-06-28 — the editor run experience; **33** shipped 2026-06-29 — the read-only reader data layer; carved-out follow-ups **42** (quiet-heal perf) / **43** (editor registry publishing) / **44** (thin standalone reader package) remain. Item **19** was deferred out of 1.0.) (Item **39**'s standalone-package extraction shipped early, out-of-band — the remaining media-manager-consumes-it swap is intentionally **not** 1.0-blocking. Item **15** (image compression) was de-scoped from 1.0 — it remains a `blocked` backlog item, not release-blocking.)

> **How to read & maintain this file:** see the **"Managing FUTURE_CHANGES.md"** section in [`../CLAUDE.md`](../CLAUDE.md). The short version: items are grouped by **cluster** (not by number), every active item carries a machine-readable **frontmatter block**, item **numbers are immutable IDs** (never renumber — they're cross-referenced from `FEATURES.md` and the plan docs), and `status: ready` is a promise that an agent can pick it up with **zero open questions**.

## Frontmatter legend

Each active item opens with a fenced `yaml` block:

```yaml
status: ready # ready | blocked | discussion | shipped
size: M # S (hours) | M (a day) | L (multi-day / design-heavy)
usefulness: 3 # 1–5 — product leverage / value to the user
priority: medium # high | medium | low
files: [path, …] # current owning files (verified, not stale)
depends_on: [] # item numbers that must land first
open_questions: 0 # count of unresolved design decisions
acceptance: # what "done" looks like — the agent's definition of success
  - …
```

**The cardinal rule:** `status: ready` ⇔ `open_questions: 0`. The moment an item has an unresolved design decision it is `blocked` (engineering unknown) or `discussion` (product/scope unknown) — **never `ready`**. An agent should be safe to grab any `ready` item and finish it without coming back to ask.

## Cluster index

| Cluster                                                         | Items                                                                                             | Theme                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| [npx-package vision](#cluster-npx-package-vision)               | 42 · 43 · 44 · 7                                                                                  | Run media-manager as an npx package inside a host repo |
| [Data model & fields](#cluster-data-model--fields)              | 36 · 38 · 26 · 25 · 4 · 0                                                                         | Field types, value editors, globals parity             |
| [Media kinds & preview](#cluster-media-kinds--preview)          | 23 · 21 · 24 · 14                                                                                 | Expand beyond images — video/gif, pdf, docx, markdown  |
| [Grid & display](#cluster-grid--display)                        | 40                                                                                                | Large-catalog perf (verbose grid #8 shipped)           |
| [Asset pipeline & deps](#cluster-asset-pipeline--deps)          | 47 · 39                                                                                           | Compression follow-ups, masonry packaging              |
| [Bulk & schema utilities](#cluster-bulk--schema-utilities)      | 3 · 5                                                                                             | Mostly shipped — small remainders to close             |
| [Integrations](#cluster-integrations)                           | 37 · 11                                                                                           | External services, kept opt-in and out of core         |
| [Storage & routing — design](#cluster-storage--routing--design) | 20 · 19 · 16                                                                                      | Decisions to make before code                          |
| [Misc fixes & polish](#cluster-misc-fixes--polish)              | 17 · 41 · 29                                                                                      | Small, self-contained quality-of-life                  |
| [Shipped & folded](#shipped--folded)                            | 1 · 2 · 6 · 22 · 28 · 27 · 9 · 10 · 13 · 12 · 34 · 8 · 18 · 30 · 31 · 32 · 33 · 45 · 46 · 15 · 35 | Archive — see `FEATURES.md`                            |

> A visual triage board over this same data lives at [`FUTURE_CHANGES_TRIAGE.html`](FUTURE_CHANGES_TRIAGE.html) (open in a browser) — filter by status/size/flags and rank by usefulness. **Keep the two in sync** when you add, close, or re-score an item.

---

## Cluster: npx-package vision

Running media-manager as an **npx package inside a host repo** (e.g. `nicb.at`, workspace at `src/assets/media_manager`). Full design: [`plans/npx-package-vision.md`](plans/npx-package-vision.md) (+ diagram [`npx-package-vision.html`](npx-package-vision.html)). Decisions locked 2026-06-20: **editor-first**, distribute as a **local dep** for now (publish later). Items 30/31/32 (the "safe to open committed data" trio) **shipped 2026-06-28**; Item 33 (the read-only reader) **shipped 2026-06-29**; follow-ups 42 (perf) / 43 (editor publishing) / 44 (thin reader package) remain.

> **Items 30 · 31 · 32 shipped 2026-06-28** (the editor "easier to run" experience) and **Item 33 shipped 2026-06-29** (the read-only reader data layer) — see [Shipped & folded](#shipped--folded) + plans `plans/v1.0/npx/run-experience-plan.html` and `plans/v1.0/npx/reader-package-plan.html`. What remains in this cluster: three carved-out follow-ups below — **42** (the quiet-heal content-hash perf nicety), **43** (editor registry publishing, deferred out of 1.0), and **44** (extract the reader to a thin standalone package).

### 42 · Quiet-Heal Content-Hash Resync Trigger (perf)

```yaml
status: ready
size: S
usefulness: 2
priority: low
files: [src/lib/storage/classRepo.ts, src/lib/storage/manifest.ts, src/lib/storage/manifest.test.ts]
depends_on: []
open_questions: 0
acceptance:
  - Replace the mtime-gated resync trigger (`reconcileAndResync`) with a content-derived signal so a `git checkout` (which resets mtimes) doesn't re-parse every class file on each browse
  - No behavior change to the membership index or the `healed` report — purely avoids redundant work
```

Carved out of shipped [Item 32](#shipped--folded). The git-clean goal is **already met** (the `if (changed)` write guards make a browse a no-op, and **git tracks content, not mtime**, so the mtime-resync re-firing causes zero `git status` churn). This is the leftover **performance** nicety: after a `git checkout` resets mtimes, `reconcileAndResync` ([`classRepo.ts`](../src/lib/storage/classRepo.ts)) re-reads + re-parses every class file on each list even though nothing changed. A content-hash (or size+hash) signal stored in the manifest would skip that. Low priority — invisible to correctness; only bites on large class counts.

### 43 · npx Package Publishing (registry — later phase)

```yaml
status: discussion
size: M
usefulness: 3
priority: low
files: [package.json, bin/media-manager.js]
depends_on: [30]
open_questions: 2
acceptance:
  - npm `bin`/`files`/`engines` fields + a `prepublishOnly` build so `build/` ships in the tarball (consumers never build)
  - Scoped name `@nicbat/media-manager`; cross-platform native-dep audit of `exiftool-vendored` / `heic-convert`
  - `npx media-manager` from the published registry works on macOS / Linux / Windows
```

Folded out of shipped [Item 30](#shipped--folded) (originally former Item 27). The editor run experience (discovery + verbs + ephemeral port + build-on-demand) shipped as a **local-dep / clone** flow; this is the deferred **publish-to-registry** phase. Consumers won't build — `prepublishOnly` builds once and `build/` ships in the tarball; the real risk is **install-time** native binaries (`exiftool-vendored`/`heic-convert`) resolving cross-platform. **Open questions:** (1) scoped vs. unscoped name + npm org; (2) the native-dep cross-platform matrix — do the vendored binaries resolve on every target, or do we need `optionalDependencies` / a postinstall check?

### 44 · Reader as a Thin Standalone Package (friend-facing distribution)

```yaml
status: discussion
size: M
usefulness: 3
priority: low
files: [src/lib/reader/ (after Item 33), package.json]
depends_on: [33]
open_questions: 2
acceptance:
  - Extract the Item 33 reader to its own publishable package (e.g. @nicbat/media-manager-reader) with zero runtime deps and svelte/vite as peerDependencies — NOT the heavy editor package
  - A consumer (a friend's static site) installs only the thin reader: `npm i @nicbat/media-manager-reader`, `import { MediaManager } from '@nicbat/media-manager-reader'` — no exiftool/heic-convert/sharp/sveltekit pulled in
  - Built dist (JS + .d.ts) ships in the tarball; lift-and-shift from src/lib/reader/ (zero coupling, same discipline as the Masonry extraction)
```

The reader (Item 33) is pure functions over JSON — the opposite of the heavy editor package (SvelteKit server + `exiftool-vendored`/`heic-convert`/`sharp`). Making a **friend's static site** `npm install` the whole `media-manager` just to read JSON pulls in server-only native deps it doesn't need (bloat + the cross-platform native-binary risk of [Item 43](#43--npx-package-publishing-registry--later-phase)). So distribute the reader as its **own thin package** — sibling to Item 43, not part of it (the reader's publish has **none** of the native-dep risk). Parallels [Item 39](#shipped--folded)'s Masonry extraction. Build in-monorepo for v1 (Item 33), distribute to nicb.at via `file:`/git; this extraction is a later **packaging** lift, not a code-structure change — so structure the 33b export cleanly (zero coupling, import only what it needs) to make it trivial. **Open questions:** (1) scoped name + npm org (shared with Item 43); (2) does the reader build via `svelte-package` (if it ever ships Svelte components in a v2) or plain `tsc` (data-only stays framework-agnostic)?

### 7 · Static Site Export (no runtime API for customers)

```yaml
status: blocked
size: L
usefulness: 1
priority: medium
files: [src/lib/storage/mediaTypes.ts, src/lib/storage/classRepo.ts, src/lib/storage/jsonRepo.ts, src/lib/core/filters.ts]
depends_on: [6]
open_questions: 3
acceptance:
  - `npm run export -- <root> --out <dir>` reuses the storage read layer (no duplicated read logic)
  - Emits static JSON snapshots per type/class + globals + schema, copies referenced blobs
  - Generates a read-only browsing UI (galleries, record views, client-side filters) with no write endpoints
```

A customer shouldn't need to run a live API to **publish**: edit locally, then rebuild a static, host-anywhere site (S3/Pages/Netlify). A separate **read-only export** target, not a replacement for the editor. Item 6 (stable file IDs) **shipped**, so durable collision-free asset names are available — the dependency is satisfied.

**Open questions:** one bundle per type vs. a single combined site; how much interactivity (filters/compare) vs. pure gallery; hosting assumptions (flat host vs. clean URLs). Also needs the same root-threading refactor as Item 33. **The asset-pipeline overlap is resolved:** [Item 15](#shipped--folded) shipped the compression/resize pipeline plus a manifest-authoritative copy path (`bin/media-manager.js export` already carries derivatives), so this item calls it instead of inventing one — one of the three open questions below is correspondingly narrower.

---

## Cluster: Data model & fields

Field types, value editors, and globals feature-parity. The `relation` edge (36) is the high-leverage one — it turns the three sub-app "islands" into a graph.

### 36 · `relation` field type — record-to-record references

```yaml
status: ready
size: L
usefulness: 5
priority: medium
files: [src/lib/core/types.ts, src/lib/components/FieldInput.svelte, src/lib/storage/jsonRepo.ts, src/lib/components/GlobalsEditorPane.svelte]
depends_on: []
open_questions: 0
acceptance:
  - `relation` added to FieldTypeSchema with a `{ typeId, recordId }` value shape (single-target first)
  - Per-field config stores the target type id (like a dropdown's options)
  - FieldInput gains a relation editor: picks from the target type's records, renders a title chip, click-through deep-links to `/media?type=<t>&record=<id>`
  - Server normalizes/validates the target exists and flags dangling relations (mirrors the `_missing_files` pattern)
  - Globals parity: target-type hint stored in `__field_meta`
```

We have a `file` field (record→blob) but no way for a record to point at **another record** (a movie's `director` → a row in "People"). Today you retype "Christopher Nolan" in every movie — no typed pointer, no click-through. A `relation` field adds that edge. Deferred during the sub-app restructure (2026-06-22), which shipped the `?record=` deep links that make click-through trivial — so this is now unblocked and `ready`.

**Deliberately deferred (not open questions):** `relation[]` multi-target (ship single first), reverse "referenced by" back-references (needs a derived index — defer unless needed). A relation targeting a class member (blob) is what `file` already does — keep `relation` record→record to avoid overlap.

### 38 · Decouple field key from display label (drop the snake_case nag)

```yaml
status: discussion
size: M
usefulness: 3
priority: low
files:
  [
    src/lib/core/types.ts,
    src/lib/core/fieldKeys.ts,
    src/lib/components/schema-editor/SchemaEditorBody.svelte,
    src/lib/storage/jsonRepo.ts
  ]
depends_on: []
open_questions: 2
acceptance:
  - The schema editor lets the user type a field name verbatim (no forced snake_case); the human label persists
  - Field identity stays a stable, URL-safe slug under the hood (renames/relabels do not rewrite every record)
  - Optional: bulk JSON export (Item 3) can resolve keys → labels so exported files read naturally
```

Today field keys are slugified to snake*case ([`SchemaEditorBody.svelte:127,224`](../src/lib/components/schema-editor/SchemaEditorBody.svelte)), enforced on disk by a regex ([`types.ts:323`](../src/lib/core/types.ts)), with the label \_re-derived* from the key ([`fieldKeys.ts: fieldLabel()`](../src/lib/core/fieldKeys.ts)). Nicholas wants the field name to be "exactly how the user types it." Full design + the Option A (free-form keys — a trap) vs **Option B** (stored `label`, stable hidden key — recommended) analysis, plus a note on whether the substrate should be **SQLite** instead of JSON-on-disk, lives in [`plans/field-labels-and-storage.md`](plans/field-labels-and-storage.md). Parked 2026-06-28 during Item 3 scoping — captured so we don't re-derive it.

**Open questions:** (1) Option A vs B (recommend B). (2) Does the SQLite substrate question (see the doc) gate this, or do we ship B independently and revisit storage separately?

### 26 · File-Field UI Overhaul (preview + navigate-to-file)

```yaml
status: ready
size: M
usefulness: 4
priority: medium
files:
  [
    src/lib/components/FilePicker.svelte,
    src/lib/components/FieldInput.svelte,
    src/lib/components/FileEditorPanel.svelte
  ]
depends_on: []
open_questions: 0
acceptance:
  - Larger/expandable preview of the referenced blob (reuse the FileEditorPanel lightbox; support non-image kinds as Items 23/24 land)
  - A "go to file" affordance that opens the referenced blob in the Files hub editor
  - Applied consistently everywhere FieldInput renders a `file` field (FileEditorPanel, RecordDetailPane, GlobalsEditorPane)
```

A `file`-field value is a manifest id ref, edited via [`FilePicker.svelte`](../src/lib/components/FilePicker.svelte) inside [`FieldInput.svelte`](../src/lib/components/FieldInput.svelte). Today: small inline thumbnail (images only) + filename + open-in-new-tab + clear. Users want a richer preview and a jump-to-file. The preview half is fully `ready`; the "go to file" deep-link is cleanest with stable per-file routes (Item 20) but can ship today against `/files` with the editor opened — does **not** block this item. Overlaps Item 25 (apply once in the shared `FieldInput`).

### 25 · Globals Panel Overhaul (previews + nicer layout)

```yaml
status: ready
size: M
usefulness: 3
priority: medium
files:
  [
    src/lib/components/GlobalsEditorPane.svelte,
    src/lib/core/fieldKeys.ts,
    src/lib/components/FieldInput.svelte
  ]
depends_on: []
open_questions: 0
acceptance:
  - Rich value previews in the globals editor (image/file thumbnails, url link previews) — overlaps Item 26, design together
  - Nicer layout (grouped/sectioned fields, spacing) preserving the __field_kinds / __field_meta metadata model
  - Full parity: any field type/feature the json RecordDetailPane supports still works here
```

The reserved `globals` singleton keeps its bespoke free-form editor ([`GlobalsEditorPane.svelte`](../src/lib/components/GlobalsEditorPane.svelte)) but its presentation is plain. Per CLAUDE.md it must keep parity with `json` records. Consider converging further onto the shared `FieldInput` + panel chrome (it already feeds `FieldInput` a synthetic `FieldDefinition`) to reduce drift.

### 4 · Schema Import/Export

```yaml
status: ready
size: M
usefulness: 2
priority: low
files: [src/routes/api/media-types/[typeId]/schema, src/routes/api/classes/[id]/schema, src/lib/core/types.ts]
depends_on: []
open_questions: 0
acceptance:
  - Export a type's/class's schema as standalone JSON
  - Import a schema from JSON (merge or replace) with validation
  - Clone a schema from another media type / class
```

Media types and classes have embedded schemas; users may want to share or duplicate them. Self-contained, low priority. (Both the `json`-type and class schema endpoints already exist to build on.)

### 0 · Make URL fields editable

```yaml
status: shipped
```

**Already shipped** — [`FieldInput.svelte`](../src/lib/components/FieldInput.svelte) has a full `url` `{ display_name, url }` editor. Retained here only as a tombstone; safe to delete on the next pass.

---

## Cluster: Media kinds & preview

Expand first-class preview/handling beyond images. PDF storage + metadata already shipped (via `exiftool-vendored`); these add the previews and new kinds.

### 23 · Video & GIF Media Support

```yaml
status: ready
size: L
usefulness: 4
priority: medium
files:
  [
    src/lib/core/images.ts,
    src/lib/components/FileEditorPanel.svelte,
    src/lib/components/data-grid/DataGrid.svelte,
    src/lib/server/fileMetadata.ts
  ]
depends_on: [15]
open_questions: 0
acceptance:
  - Recognize video (.mp4/.webm/.mov/…) + animated .gif (extend images.ts or add a sibling media.ts)
  - Inline preview — <video controls> (and GIFs as images) in FileEditorPanel + the lightbox; poster/first-frame thumbnail in DataGrid tiles
  - Thumbnail generation for the grid (first frame), mirroring the image thumbnail path
  - exiftool duration/codec/dimensions in fileMetadata.ts; [id]/blob supports range requests for seeking
```

The Files grid and [`FileEditorPanel.svelte`](../src/lib/components/FileEditorPanel.svelte) gate previews on `hasAllowedImageExtension` ([`images.ts`](../src/lib/core/images.ts)), so video/GIF fall back to the generic icon. **Deliberately decided (not an open question):** large videos load lazily via range requests; GIFs are images on disk but preview like motion. **Depends on [Item 15](#shipped--folded):** the thumbnail/derivative pipeline now exists — a video poster frame is another _preset_ written into `media/derived/<preset>/` and recorded on the manifest entry's `derived` block, so this item extends `server/compression/generate.ts` with an ffmpeg branch rather than building a second pipeline. `recipe` is an opaque string and `derived` is a preset-keyed map precisely so that fits.

### 21 · Full PDF Preview

```yaml
status: ready
size: M
usefulness: 3
priority: low
files: [src/lib/components/FileEditorPanel.svelte, src/lib/core/images.ts]
depends_on: []
open_questions: 0
acceptance:
  - Render PDFs inline via native browser embed (<iframe>/<embed>, no new deps) in FileEditorPanel, replacing the icon placeholder
  - Generate/serve first-page PDF thumbnails so the Files grid shows a preview instead of the icon
```

PDFs are stored, served as `application/pdf`, and read for document metadata already (see the `MetadataButton` "Document Information" section). Only the inline preview + first-page thumbnail remain — a solid scan/browse win.

### 24 · DOCX Media Support (+ convert-to-PDF)

```yaml
status: blocked
size: L
usefulness: 3
priority: medium
files: [src/lib/server/fileMetadata.ts, src/lib/components/FileEditorPanel.svelte]
depends_on: [21]
open_questions: 1
acceptance:
  - Recognize .docx/.doc; read basic metadata (title, author, word count) via exiftool
  - A per-file "Convert to PDF" action that writes + registers a new PDF blob, optionally linking back to the source
  - Once converted, the existing PDF preview/metadata path (Item 21) applies
```

Same treatment as PDFs, for Word docs, with an easy path to PDF (which the app previews + reads metadata from). **Open question (blocks):** converter choice — LibreOffice-headless (heavy, high fidelity) vs. pure-JS (light, lower fidelity) — decide against the npx-package distribution footprint (Item 30). Also depends on Item 21's PDF preview landing.

### 14 · Posts — a Markdown writing sub-app

```yaml
status: ready
size: L
usefulness: 4
priority: medium
files:
  [
    src/lib/storage/paths.ts,
    src/lib/storage/mediaTypes.ts,
    src/lib/storage/json.ts,
    src/lib/storage/settingsFile.ts,
    src/lib/reader/media-manager.ts,
    src/lib/api/client.ts,
    src/lib/components/rail/SubAppSwitcher.svelte,
    src/lib/components/rail/EntityRail.svelte,
    src/lib/components/CommandPalette.svelte,
    src/lib/components/GlobalsEditorPane.svelte,
    src/lib/components/FilePicker.svelte,
    src/lib/components/FieldInput.svelte,
    src/lib/actions/autosave.svelte.ts,
    package.json
  ]
depends_on: []
open_questions: 0
acceptance:
  - New **Posts** sub-app at `/posts` (peer to Files/Records/Globals) — added to `SubAppSwitcher`, the `EntityRail` `current` union, and `CommandPalette`; open post deep-linked via `?collection=&post=`
  - On-disk `<root>/posts/<collection>/<slug>.md` (filename = slug); collections registered in `posts/settings.json` (order + per-collection typed frontmatter hints); `postsRepo` CRUD (list/read/write/create/rename/delete) under `withFileLock` + atomic writes; `'posts'` added to `RESERVED_TYPE_FOLDER_NAMES`
  - Markdown-first hybrid body: prose = Markdown, layout blocks = self-contained `mm-*` HTML islands (`mm-inline` · `mm-beside`+`data-side` · `mm-pair` · `mm-bleed`), code = native fenced Markdown
  - Freeform, typed-per-field frontmatter editor reusing `FieldInput` (cover→FilePicker storing `mm://<uuid>`, date→DateField), serialized to plain YAML; shared `createAutosave`; Edit/Preview toggle
  - TipTap block editor: prose WYSIWYG Markdown, the four `mm-*` photo blocks as one opaque `htmlIsland` atom inserted from `FilePicker`, a lowlight fenced code block, insertion via **both** a shadcn toolbar (Bold/Italic/Code/Link + Block ▾ + Photo ▾) **and a `/` slash menu** (`@tiptap/suggestion`); a selected island is edited in the **right metadata panel** (`IslandEditor`: change photo / caption / side / roomy prose textarea / **convert kind in place** / delete); external links **open in a new tab** (render-only); **round-trip stable + idempotent** `md → doc → md` for prose, each island, and fenced code (`prosemirror-markdown` serializer, proven by a spike + tests)
  - Reader gains `posts()`: `load({data,files,posts})` (third `?raw` glob), `mm.posts(collection).bySlug(slug)/.all()` → `{ meta, html }` with every `mm://` (frontmatter + inline + island `src`) resolved via the existing asset index; fenced code highlighted by bundled **Shiki** (themeable, default sensible; nicb.at → `catppuccin-mocha`); ships `media-manager/reader/posts.css` + a copy-button enhancer
  - nicb.at consumes it: **Words** + **Now** collections rendered via `mm.posts()`; `lazy_loading.md`→Words and `/now`→Now migrated (dates → ISO); its hand-rolled markdown loader retired
  - Docs + fixtures: `FEATURES.md` Posts row + layout block; `test-fixtures/posts/` seed (prose+image via `mm://` + a code post); `upgrade-data` ensures `posts/` exists; reader `README` documents the third glob
```

> ✅ **In-repo complete (2026-07-09) — only the out-of-repo Phase 5 (nicb.at migration) remains.** Shipped: **Phase 1** (`postsRepo`/`postsSettings`/`frontmatter` storage spine + tests), **Phase 2** (full `/api/posts/...` surface, the `/posts` sub-app — switcher + rail + CommandPalette + deep-link `?collection=&post=`, typed `PostsFrontmatterPanel` reusing `FieldInput`, Edit/Preview via client `markdown-it`, shared `createAutosave`), **Phase 3** (the **TipTap block editor** — `PostBodyEditor` + `posts/tiptap/`: the `prosemirror-markdown` serializer `serialize.ts` **byte-stable + idempotent** (round-trip tested), the single opaque `htmlIsland` atom node backing all four `mm-*` blocks, island builders/parser, inline `mm://` images resolved for display, a shadcn Block/Photo toolbar + selection-driven island edit bar, `FilePicker` extended with a controlled/triggerless mode for programmatic photo insertion), **Phase 4** (reader `mm.posts()` → `{ meta, html }` with `mm://` resolution + **bundled Shiki** sync highlighting + `posts.css` + `posts-enhancer`, `?raw` posts glob in `load()`; reader tests + real-fixture render verified), and **Phase 6** (`FEATURES.md` Posts + reader rows, `test-fixtures/posts/` golden sample, `upgrade-data` heal, reader `README`). **Converged onto shared infra (2026-07-09):** a collection's frontmatter fields are a full `SchemaDefinition` (not bespoke `fieldHints`), edited by the **shared `EntitySettingsDialog` + `SchemaEditorBody`** (General/Fields/Danger, add/edit/delete/**drag-reorder**) via a `postsSettingsAdapter`; `/api/posts/[collection]/schema` mirrors the media-types schema routes (`postsSchema.ts`); the frontmatter editor is `FieldInput`-per-schema-field like `RecordDetailPane`; explicit filename (slug) rename + `displayField` title-by; legacy `fieldHints` auto-upgrade on first edit. **Editor refinements (2026-07-13):** the editor was reshaped to the **Records layout** — a middle writing column + a right **Post details** panel (frontmatter + Saving…/Saved + Delete +, on selection, the island editor). Added: a **`/` slash menu** (`tiptap/slash.ts` over `@tiptap/suggestion`), **convert-block-kind-in-place** + a **roomy prose textarea** for "text beside photo" (both in the new `IslandEditor`), and **external links auto-open in a new tab** (render-only rule in Preview + reader, `renderPreview.ts: externalLinkTargets`). **Remaining:** **Phase 5** — nicb.at migration (out-of-repo, in `~/Projects/nicb.at`); media-manager itself is unchanged by it. New editor deps: `@tiptap/*` (incl. `@tiptap/suggestion`), `prosemirror-markdown`, `lowlight`.

> ✅ **Redesigned against the file-first model (2026-07-07); all prior open questions resolved.** The original "markdown `MediaTypeKind`" sketch is dropped — markdown posts are **not** a media kind or a class over `.md` blobs. They are a **new top-level sub-app** (peer to Files/Records/Globals), the same shape as Records but storing `.md` files instead of JSON records. Full file-grounded build plan: [`plans/posts-markdown-sub-app-plan.md`](plans/posts-markdown-sub-app-plan.md).

**Locked decisions:** `.md` edited in place at `<root>/posts/<collection>/<slug>.md`; **markdown-first hybrid** body (prose Markdown + `mm-*` HTML islands + native fenced code); freeform **typed-per-field frontmatter** (Globals-style, YAML on disk, `cover: mm://<uuid>`); **TipTap** Notion-style block editor (`/` menu, custom photo-block nodes → `FilePicker`, lowlight code, Edit/Preview); photo layouts inline / text-beside / pair / full-bleed; **image refs `mm://<uuid>` resolved by the reader**, not per-site plugins; the **reader owns rendering** (`mm.posts()` → `{ meta, html }`, bundled **Shiki**, shipped `posts.css` + copy-button enhancer). **Seed:** nicb.at Words + Now (migrate `lazy_loading.md` + `/now`, ISO dates); Ariel Blog + per-site prose theming deferred.

**Biggest risk — DE-RISKED (2026-07-08):** a spike proved markdown-first round-trip **byte-stable + idempotent** for prose / `mm-*` HTML islands / fenced code; **bridge chosen: `prosemirror-markdown`** with a custom serializer + an `html_island` atom node (`tiptap-markdown` rejected — needs a DOM, less control). One constraint: emit island children with no internal blank lines. Recipe in [`plans/posts-markdown-sub-app-plan.md`](plans/posts-markdown-sub-app-plan.md). **New deps:** `shiki` + `markdown-it` + `yaml`/`js-yaml` (reader + storage), and `@tiptap/*` + `lowlight` + `prosemirror-markdown` (editor only). Structurally a sub-app, but it stays in the _Media kinds & preview_ cluster (markdown is named in that cluster's theme).

---

## Cluster: Grid & display

What each tile shows. (Sorting — Item 9 —, the empty/missing-field filter — Item 10 —, and the **verbose grid — Item 8** — all shipped; see **Shipped & folded**.) Remaining here: large-catalog virtualization (Item 40), carved out of Item 8.

### 40 · Grid virtualization for large catalogs

```yaml
status: discussion
size: M
usefulness: 2
priority: low
files: [src/lib/components/masonry/Masonry.svelte, src/lib/components/data-grid/DataGrid.svelte]
depends_on: []
open_questions: 1
acceptance:
  - The tile grid renders only tiles near the viewport (windowing), recycling nodes on scroll
  - Scroll stays smooth in verbose mode at large member counts
  - Masonry column balance is preserved under windowing (estimated positions, no jump)
```

Carved out of **Item 8** during its interview. The grid renders **every** tile today (no windowing); verbose mode (Item 8) makes each tile heavier, so the scroll-jank threshold for big catalogs arrives sooner — but the underlying limit is tile **count**, independent of verbose. Windowing is meaningfully trickier on **masonry** specifically: knowing which tiles are in-window needs their estimated positions, which depend on the balancing pass — so `Masonry.svelte` must expose/precompute per-tile offsets. **Open question:** trigger/threshold — always-on windowing vs. only above N tiles vs. a simpler "load more"/paged fallback; decide before building so the `Masonry` API change is right once. Explicitly **not** 1.0-blocking — pull in only if real catalogs feel slow.

## Cluster: Asset pipeline & deps

Masonry layout and the remaining asset-pipeline follow-ups. **The resize pipeline is now designed and built** — [Item 15](#shipped--folded) made _compression presets_ that pipeline and adopted `sharp`, which also settled [Item 35](#shipped--folded). Items 7 and 23 call it rather than inventing their own.

### 47 · Versioned derivative URLs (cache-busting)

```yaml
status: discussion
size: S
usefulness: 2
priority: low
files:
  [
    src/lib/server/compression/generate.ts,
    src/lib/storage/derived.ts,
    src/routes/api/files/[id]/blob/+server.ts,
    src/lib/reader/media-manager.ts
  ]
depends_on: [15]
open_questions: 1
acceptance:
  - Derivative URLs carry a per-preset version segment (`/derived/web.a1b2c3/sunset.webp`) so a preset change invalidates instantly
  - Derivatives are served `immutable` with a long max-age; the 1-hour lifetime shipped in Item 15 is retired
  - Adopting it is a regenerate-and-sweep, not a migration — no manifest format change
  - `og:image` (and anything else a crawler re-fetches) still points at an **original**, never a versioned derivative
```

**Deferred by decision when Item 15 shipped, with a recorded trigger: revisit if image links ever get shared, or the site starts feeling slow.** Item 15 ships clean, shareable derivative filenames on a **1-hour** `Cache-Control`, so a preset change reaches every visitor within the hour and repeat visitors re-check a little more often than strictly necessary. Both are fine for a personal site that changes its compression settings roughly never.

**The concern, in the user's terms:** hashed filenames make image URLs unshareable — someone copying a link to an image on the site gets an opaque, expiring address. **Why deferring was judged acceptable:** only _derivatives_ would carry a version, and derivatives are the small grid thumbnails; the full-size image a visitor clicks into, right-clicks and shares is the untouched **original** at `/media/<name>`, and page URLs never contain an image filename at all. The ugly address would only surface if someone deliberately copied a grid thumbnail's link — rare, and the wrong image to share anyway.

**Preferred shape when picked up:** version the **directory**, not the filename, so the saved file keeps a clean name; a preset change invalidates every file in that preset at once, which makes per-preset the right granularity (per-file hashing is over-granular). **Rejected:** a `?v=` query string — some CDN configurations drop query strings when computing a cache key, which reintroduces the bug invisibly.

**Why this stays cheap to defer:** Item 15 already forbids reconstructing derivative filenames — every lookup reads `file_name` from the manifest — so the naming scheme is a swappable detail.

**Open question (blocks `ready`):** whether the host actually needs it, which is a question about nicb.at's traffic and how often presets change, not about this repo. Full reasoning: [`plans/image-compression.html`](../plans/image-compression.html) § "Keeping caches honest".

### 39 · Consume `@nicbat/svelte-masonry` as a GitHub dependency

```yaml
status: ready
size: S
usefulness: 3
priority: low
files: [src/lib/components/masonry/index.ts, src/lib/components/masonry/Masonry.svelte, src/lib/components/data-grid/DataGrid.svelte, package.json, ../CLAUDE.md]
depends_on: []
open_questions: 0
acceptance:
  - media-manager depends on `github:nicbat/svelte-masonry#<tag>` in package.json (npm-registry release deferred)
  - `src/lib/components/masonry/Masonry.svelte` deleted; `index.ts` re-exports `Masonry` from `@nicbat/svelte-masonry` (or DataGrid imports it directly and the folder is removed) — no behavior change to the files grid
  - CLAUDE.md's "in-house `Masonry.svelte`" notes updated to say it's an external dependency
```

> ✅ **Extraction shipped early (2026-06-28), out-of-band.** The component now lives in its own standalone repo — **[github.com/nicbat/svelte-masonry](https://github.com/nicbat/svelte-masonry)** (`@nicbat/svelte-masonry`, tagged `v0.1.0`): SvelteKit lib project, `svelte-package` build (`publint`-clean), `svelte` as a peerDep, README with a props table + MIT LICENSE, plus a live demo route. Built off the in-repo copy unchanged (it imports only `svelte`). The earlier **open question is resolved** — chose a **separate standalone repo + `@nicbat/` scope** over a monorepo workspace.

What **remains** (and is deliberately **not** 1.0-blocking, per the user): media-manager still uses its **local copy** at [`src/lib/components/masonry/`](../src/lib/components/masonry/Masonry.svelte). Swap that for the GitHub dependency so the two don't drift. The package's `prepare` script runs `svelte-package`, so a git install builds `dist/` on the consumer's machine — no pre-built artifacts needed. `npm publish --access public` to the npm registry is a later, separate step (no code change from where the package is now).

---

## Cluster: Bulk & schema utilities

Mostly shipped during the records work — small remainders to close out.

### 3 · Bulk Operations — bulk-export remainder

```yaml
status: ready
size: S
usefulness: 1
priority: low
files: [src/lib/components/RecordBulkActions.svelte, src/routes/api/media-types/[typeId]/records/bulk-update, src/routes/api/media-types/[typeId]/records/bulk-delete]
depends_on: []
open_questions: 0
acceptance:
  - Bulk-export selected records as JSON (the only remaining bulk action)
```

> ✅ **Mostly shipped.** Bulk-**update** a field and bulk-**delete** across selected records both exist ([`RecordBulkActions.svelte`](../src/lib/components/RecordBulkActions.svelte) + the `bulk-update`/`bulk-delete` endpoints). The bulk **Set field…** value widget is now the shared [`BulkSetFieldDialog.svelte`](../src/lib/components/BulkSetFieldDialog.svelte) (built on `FieldInput`, so it covers every field type incl. the `record`/`file` pickers), and the **Files single-class catalog** got the same bulk Set field… (solo-class only) via `apiBulkUpdateClassRecords` → `POST /api/classes/[id]/records/bulk-update`. Only **bulk-export to JSON** remains — demoted from a full item to this one-liner.

### 5 · Data Validation & Repair — verify coverage

```yaml
status: ready
size: S
usefulness: 2
priority: low
files: [src/routes/api/media-types/[typeId]/records/repair/+server.ts, src/lib/storage/jsonRepo.ts]
depends_on: []
open_questions: 0
acceptance:
  - Confirm the existing `repairRecords(dryRun)` covers orphan-key removal + type coercion + a report
  - Extend only the gaps; close the item otherwise
```

> ✅ **Partially shipped.** A records [`repair` endpoint](../src/routes/api/media-types/[typeId]/records/repair/+server.ts) already exists with `repairRecords(dryRun)`. This is now a **verify-and-close** task: check it removes keys not in schema, coerces values to field type, and reports — extend only if a gap is found.

---

## Cluster: Integrations

External services — kept opt-in, out of the core, and out of the way.

### 37 · Import from Google Photos (Picker API)

```yaml
status: ready
size: L
usefulness: 3
priority: medium
files: [src/routes/files/+page.svelte, src/lib/storage/classRepo.ts, src/lib/storage/manifest.ts]
depends_on: []
open_questions: 0
acceptance:
  - New googlePhotos server module (OAuth2 loopback + PKCE; Picker REST), googleConfig storage (media/google.json, chmod 600 — NEVER seed into test-fixtures/), client wrappers
  - New /api/google-photos/* routes (status, credentials, auth/start [spins a 127.0.0.1 loopback listener], session, session/[id], import)
  - GooglePhotosDialog + a "⋮ More" overflow menu next to Upload; on success call loadMeta()/loadFiles()
  - heic-convert factored into a shared helper so /upload and /import don't duplicate it
  - FEATURES.md updated (new feature row + 7 endpoints)
```

Full design: [`plans/google-photos-import.md`](plans/google-photos-import.md) + mockup [`google-photos-import.html`](google-photos-import.html). **Verdict (2026-06-22): feasible** — a picked photo collapses onto the existing upload path. **Decisions locked:** bring-your-own OAuth credentials (no Google app verification); import to All Files (unclassified); a `⋮ More` overflow menu, not a primary button (rare action). **Hard constraints** (Google 2025 API): Picker API only (no library browse/sync), can't embed (new tab + poll), ~60-min download window, ~weekly re-login.

**Open questions — all resolved by research (2026-06-29), now `ready`:**

- **Scope tier:** `photospicker.mediaitems.readonly` is a **sensitive** scope, **not restricted** (absent from Google's restricted-scopes list, which is Gmail/Drive/Photos-Ambient only) → **no CASA audit ever applies.** And BYO-credentials + **Testing** publishing status sidesteps even the lighter brand/OAuth review (Google's "Development/Testing" + "Personal use" exemptions; the user is a test user clicking through the unverified-app screen).
- **Loopback OAuth port:** loopback `127.0.0.1` + PKCE with a **dynamic ephemeral port (no port pre-registration)** is Google's _recommended_ Desktop-client pattern — the OOB deprecation doesn't touch it. Item 31's `findFreePort()` lives in `bin/media-manager.js` (separate process) and isn't reusable, but an adapter-node route handler can open its own `http`/`net` listener → add a small `findFreePort()` in `src/lib/server/`.
- **Partial-import resilience:** wrap **each item** in its own try/catch; `/import` returns `{ imported, failed, fileIds, failures[] }` (mirrors the `/api/files/missing` summary shape). Factor the HEIC step (`upload/+server.ts:52-60`) into a shared `maybeConvertHeic()` used by `/upload` + `/import`.
- **Token-expiry UX:** 7-day refresh-token expiry is real in Testing for this scope (the name/email exemption doesn't apply). **Recommend** documenting "flip the consent screen to **In production**" (no verification submission) for long-lived tokens — user clicks the unverified warning once; **persist & reuse one refresh token** (100-token cap, 6-month idle expiry). Surface "connected · expires in N days" via a `MetadataButton.svelte`-style dialog (`$effect` fetch-on-open + `$derived` state) + a Zod `apiGetGooglePhotosStatus` wrapper shaped like `apiGetMissingFiles`.

**⚠️ Plan correction:** `baseUrl=d` downloads retain full-res + all EXIF **except GPS/location** (Google strips it server-side) — the plan's "EXIF intact" claim is corrected in `plans/google-photos-import.md`.

### 11 · AI / External Field Enrichment

```yaml
status: discussion
size: L
usefulness: 2
priority: low
files: []
depends_on: []
open_questions: 0
acceptance:
  - (Downstream/app-specific — park or spin out of the core repo)
```

Ideas aimed at specific downstream uses (vision-API auto-fill, offline semantic search, a local vector DB over field values/EXIF), **not** the core local tool. Listed so they aren't lost. Keep the core provider-agnostic and local-first; gate any integration behind opt-in config and be explicit when data leaves the machine.

---

## Cluster: Storage & routing — design

Decisions to make **before** code. These unblock other items (esp. routing → 26/29) more than they deliver standalone value.

### 20 · File-Based Routing

```yaml
status: discussion
size: M
usefulness: 3
priority: medium
files: [src/routes/files/+page.svelte, src/routes/media/[typeId]/+page.svelte]
depends_on: []
open_questions: 2
acceptance:
  - (Design the route tree — deep-linkable per-file/per-class routes + shareable view/filter URLs)
```

Partly shipped already (the `?record=` deep link landed with the sub-app restructure). The fuller vision: per-file routes (`/media/file/[id]`), per-class routes, shareable filter URLs — so app state is addressable and bookmarkable. **Enabler:** unblocks the clean "go to file" affordance (Item 26) and the mobile drill-down (Item 29). **Open questions:** the route-tree shape; how much in-page state migrates to URLs.

### 19 · Per-Class "Should / Shouldn't Be Here" Review (excludedFiles successor)

```yaml
status: discussion
size: M
usefulness: 3
priority: medium
files: [src/lib/storage/classRepo.ts, src/lib/storage/manifest.ts]
depends_on: []
open_questions: 0
acceptance:
  - Per class, mark a file "dismissed / not-relevant" so it stops surfacing as a candidate (per-class, never a global hide)
  - A triage view: for a class, show candidate files (unclassified / heuristic) and quick add-to-class or dismiss
  - Dismissals stored in the class JSON (source of truth), optionally mirrored into the manifest index
```

The file-first redesign removed per-class `excludedFiles` (membership is opt-in). This reintroduces the **useful** half — triage — without the opt-out burden. `discussion` because it's a design idea (the value/shape isn't confirmed), even though the mechanics are clear. Keep distinct from delete-from-disk (global) and remove-from-class (drops membership).

**Deferred out of 1.0 (decided 2026-06-28).** The mechanics are trivial, but `dismiss-as-candidate` only pays off when there's a candidate _suggestion_ stream worth suppressing — and today the only candidate source is the existing **"Unclassified"** filter (a manual scan, no heuristic). The cheap "Unclassified-only" version is a checkmark that doesn't earn its UI; the valuable version needs a **heuristic candidate source** (extension / EXIF / name match), which is a bigger, separate suggestion-engine feature. So 1.0 ships without it. Kept at `usefulness: 3 · priority: medium` because once a heuristic candidate source exists this becomes genuinely useful; revisit then. Independent of Item 18 (records-side; `media/` internals untouched), so nothing here was unblocked by that reorg.

### 16 · Open Design Questions

```yaml
status: discussion
size: S
usefulness: 1
priority: low
files: [.cursor/rules/svelte5.mdc]
depends_on: []
open_questions: 2
acceptance:
  - Decide the defaults-storage policy (explicit defaults vs. filter-for-empty)
  - Expand the Svelte 5 do/don't guidance ($bindable when appropriate vs. confusing)
```

Meta — decisions owed before related work, captured here so they're not lost.

---

## Cluster: Misc fixes & polish

Small, self-contained quality-of-life. Several name files removed in the file-first redesign — repointed below.

### 17 · Capture Nested Folder Path on Folder Upload

```yaml
status: blocked
size: M
usefulness: 3
priority: medium
files:
  [
    src/routes/files/+page.svelte,
    src/routes/api/files/upload/+server.ts,
    src/lib/storage/classRepo.ts
  ]
depends_on: []
open_questions: 4
acceptance:
  - Folder upload preserves per-file relative paths (webkitdirectory and/or drag-drop directory traversal)
  - An upload-time "Save folder path to field" option with a field selector (existing schema fields)
  - On import, write each file's relative path into the chosen field on the created/linked record
```

> 🔧 **Stale refs repointed.** Original pointers named `ImageEditorPane.svelte` + `repo.ts` (removed). Upload now flows through [`files/+page.svelte`](../src/routes/files/+page.svelte) → [`/api/files/upload`](../src/routes/api/files/upload/+server.ts) → [`classRepo.ts`](../src/lib/storage/classRepo.ts).

User-requested; **decisions locked:** capture the relative path within the dropped folder; user picks an existing schema field per upload; relative-path-only (browser limitation). **Open questions (block):** filename collisions in the flat global store (Item 6 shipped, which helps — relative path can disambiguate); populate-only-when-empty vs. always-overwrite; remember last-used field per type; ship `webkitdirectory` input first vs. drag-drop directory support too.

### 41 · Manual ordering of classes & record types in the rails

```yaml
status: discussion
size: M
usefulness: 2
priority: low
files:
  [
    src/lib/components/rail/EntityRail.svelte,
    src/lib/components/records/RecordsRail.svelte,
    src/lib/storage/mediaSettings.ts,
    src/routes/api/classes/+server.ts
  ]
depends_on: [18]
open_questions: 1
acceptance:
  - User can reorder classes in the /files rail and record types in the /media rail; the order persists
  - classOrder (media/settings.json) and typeOrder (records/settings.json) are applied as sort-on-read in the canonical list endpoints (/api/classes GET, /api/media-types listing) so every consumer (rail, command palette, file picker) inherits the order
  - Newly created / unlisted entities append after the ordered ones, by the existing default sort
```

Today `classOrder` (in `media/settings.json`) is a **dead/latent field** — defined and preserved-on-write but never read or applied, and there's no reorder UI. Item 18 adds the symmetric dormant `typeOrder` to `records/settings.json`. **This item activates both at once** so classes and record types stay in sync by construction: build the reorder UX + server-side sort-on-read for both sides. **Decided:** persist to the existing `classOrder`/`typeOrder` fields; sort server-side at the canonical list endpoints (not per-component); unlisted entities append by the current default order. **Open question:** the reorder interaction — `⋮` **Move up / Move down** in the existing `EntityRowMenu` (lower-risk, reuses a shipped component, keyboard-accessible) vs. **drag-and-drop** (mirrors `GlobalsEditorPane`'s drag, more code) vs. both. **Split out of Item 18** deliberately — ordering is a feature, not a migration, so it was dropped from 1.0 and kept here. Not 1.0.

### 29 · Records Explorer — Mobile / Narrow Drill-Down

```yaml
status: ready
size: M
usefulness: 2
priority: low
files: [src/lib/components/records/RecordsRail.svelte, src/routes/media/[typeId]/+page.svelte, src/lib/hooks/is-mobile.svelte.ts]
depends_on: []
open_questions: 0
acceptance:
  - On narrow viewports, show one pane at a time (rail → list → detail) with back navigation, reusing the is-mobile hook
  - Decide whether the rail becomes a top type-switcher or an offcanvas drawer on mobile
```

The Records Explorer ships as a desktop three-pane layout; three columns don't fit on narrow viewports. Sequences naturally with Item 20 (per-pane URLs make back/forward fall out of routing) but doesn't strictly need it.

---

## Shipped & folded

Archive — kept as tombstones so cross-references and the triage board resolve. **Authoritative status lives in [`FEATURES.md`](FEATURES.md).** Do not re-litigate these here.

| #   | Item                                             | Disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- |
| 1   | File Field Picker UI                             | ✅ **Shipped** — `FilePicker` over the global blob store (search + thumbnails), stores the chosen blob id.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2   | Missing File Indicators (API + UI)               | ✅ **Shipped** — flagged end-to-end (`missing_file_fields` / `_missing_files`); grid badges + inline editor warnings.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 6   | Stable File IDs                                  | ✅ **Shipped (Option 3)** — manifest UUIDs, O(1) rename, lazy-heal. Foundational for Items 7/12/17. See `STABLE_FILE_IDS.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 22  | Group-by across multiple classes ("all of" view) | ✅ **Shipped** — Group-by lists one `(class, field)` per intersected class; `listAllFiles` takes `groupBy`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 28  | Per-Type / Per-Class Icon Picker                 | ✅ **Shipped** — curated Lucide set in the unified `EntitySettingsDialog`; rendered on rails, breadcrumb, palette, grid chips.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 9   | Sorting & Ordering                               | ✅ **Shipped** — shared `SortControl` + `core/sort.ts` comparator (empties-last, stable tie-break); `?sort&dir` on records `list` / `/api/files` / class `members`; persisted per-entity (type `settings.json` · class `config` · `media/settings.json`). Folded in: last-modified shown in the side panels (`core/datetime.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 10  | Filter for Missing / Empty Fields                | ✅ **Shipped** — rail "Show" group (`EmptyFieldFilter`): "Incomplete only" (any empty user field) + per-field "is empty"; on Records + single-class Files catalog. One shared empty predicate (`core/filters.ts` `isEmptyValue`/`recordHasEmptyField`); `?incomplete` on records `list` / class `members`, per-field via `?filters`. Transient (not persisted). Complements Item 2 (missing **file** references).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 13  | Swap Width/Height (orientation fix)              | ✅ **Shipped (reframed)** — became a **dimension-consistency check + fix**: surfaces only when stored manifest dims disagree with the real **orientation-corrected** image (warning badge on `MetadataButton` + in-dialog banner). Smart "Correct dimensions" + manual "Swap W↔H"; dependency-free (exiftool). Orientation rule in `core/images.ts`; `compareStoredVsImage`/`dimensionConsistency` in `fileMetadata.ts`; `setBlobDimensions` in `manifest.ts`; `GET .../dimension-check` + `POST .../dimensions`. Pixel re-encode deferred (Item 35/`sharp`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 12  | Fix / Normalize File Extension (+ rename UX)     | ✅ **Shipped** — magic-byte sniff (PNG/JPG/GIF/TIFF/WEBP/BMP/PDF/HEIC) flags a name extension that disagrees with content; shares the `MetadataButton` warning **badge** (`needsAttention = dim‖ext`) + a one-tap **"Fix to .png"** hint in the editor header. The header rename was made first-class — **split base-name + extension fields** (commit on blur/Enter), retiring the duplicate dialog rename. Pure `detectExtensionMismatch`/`extensionConsistency` in `fileMetadata.ts`; `GET .../extension-check`; reuses O(1) `renameBlobById`. No auto-fix-on-upload, no bulk fix.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 34  | Reimplement masonry grid layout                  | ✅ **Shipped** — replaced `@masonry-grid/svelte` with an in-house, dependency-free, order-preserving balanced packer (`src/lib/components/masonry/Masonry.svelte`), wired into `DataGrid`'s thumbnail variant behind the existing `GridSize` (`minColumnWidth`); images render at native aspect ratio (no fixed-height frames — height is estimated for column-balancing only, so it can't clip/misalign). Old library removed. Publishable-extraction follow-up = [Item 39](#cluster-asset-pipeline--deps).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 8   | Configurable & Verbose Grid Display              | ✅ **Shipped 2026-06-28** — opt-in **"Show"** mode: shared `VerboseFieldsMenu` (`Show ▾` popover: **Show on tiles** toggle + **grouped** scrollable 6-item-capped checkboxes w/ divider headers) renders chosen items as key/value rows under each tile/row, on **both** Files (`DataGrid` masonry card) and Records (`RecordListColumn`). Two groups: **File info** (intrinsic size/dimensions/type/date-added, namespaced `file:*`, client-side, in **every** Files view incl. catalog) + **Fields** (class/type schema, server-resolved inline as `field_values` via `?fields=`, shared `buildFieldValues` — no per-tile fetch). Catalog can mix both; All Files = File info only; Records = its fields. Persisted durable per-entity (class `config` · type `settings.json` · `media/settings.json`). Plan: `plans/v1.0/08-verbose-grid-plan.html`. Virtualization carved out → [Item 40](#cluster-grid--display).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 18  | Records Storage Reorganization                   | ✅ **Shipped 2026-06-28** — `json` record types moved under `<root>/records/<typeId>/`; app-wide prefs hoisted to `<root>/settings.json` (`media/settings.json` keeps only `classOrder`); new `records/settings.json` holds a **dormant** `typeOrder`; reserved `globals` stays top-level; dead `dataFileName` dropped (`data.json` hardcoded). Resolution via `getMediaTypeBaseDir`/`listMediaTypeIds` (scans `records/` + folds in `globals`). Explicit `upgrade-data` step 6 (idempotent); no dual-read — `hooks.server.ts` + `layoutGuard.ts` fail loudly on the old flat layout. Plan: `plans/v1.0/18-records-storage-reorg-plan.html`. Reorder UX split to [Item 41](#cluster-misc-fixes--polish).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 27  | npx Package Distribution                         | ➡️ **Folded into [Item 30](#shipped--folded), now carved out to [Item 43](#43--npx-package-publishing-registry--later-phase)** — registry publish mechanics (deferred out of 1.0).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 30  | Editor npx Setup — Zero-Config Root Discovery    | ✅ **Shipped 2026-06-28** — bare `media-manager` discovers the root via `media-manager.config.json` (walked up from cwd; `root` resolved relative to the config file); precedence `arg → MEDIA_MANAGER_ROOT → config → friendly error`; verbs `serve` (default) · `init` (scaffold new) · `config` (config for existing data, `--force`) · `build` (rebuild + exit) · `doctor` (diagnose) · `--help`/`-h`; **build-on-demand** when `build/` is absent (`--rebuild` forces). All in `bin/media-manager.js`. Registry **publishing carved out → [Item 43](#43--npx-package-publishing-registry--later-phase)**. Plan: `plans/v1.0/npx/run-experience-plan.html`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 31  | Ephemeral Server Port + Auto-Open                | ✅ **Shipped 2026-06-28** — binds an OS-assigned ephemeral port (no fixed 3000; probe `:0` → pass to child), auto-opens the actually-bound URL on the adapter's "Listening on" readiness signal (not a `setTimeout` guess); optional `--port`/`PORT` pin. `bin/media-manager.js`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 32  | Quiet Heal — Reconcile Only on Real Change       | ✅ **Shipped 2026-06-28** — the `if (changed)` write guards already make a browse a no-op, and **git tracks content not mtime**, so a committed app-native workspace browses with **zero `git status` churn** (verified). Locked by `manifest.test.ts` "quiet heal" coverage (no-change ⇒ no-write · real-change ⇒ write+report · stays-missing ⇒ no further write). Fixture made representative (`.prettierignore` app-owned data + app-native manifest). Content-hash resync trigger carved out → [Item 42](#42--quiet-heal-content-hash-resync-trigger-perf).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 33  | Reader Package — Read-Only Host Integration      | ✅ **Shipped 2026-06-29** — build-time/static **data-layer** subpath export `media-manager/reader` (+ `/reader/vite`, built to `dist/reader/` via `npm run build:reader`). Self-contained, pure (no fs/env/network/writes): `MediaManager.load({data,files})` over two `import.meta.glob` maps → `media()`/`records()`/`globals()`/`file()`/`classes()`/`types()`; flat `MediaItem`/`Record` (`field`/`file`/`files`); fluent `Collection`; ext-case asset resolution; `WorkspaceFormatError` version guard. 20 unit tests (no fs/env). **Proven** against nicb.at's real workspace (29 visible photos w/ resolved src, projects/quotes, globals file refs); nicb.at's 3 hand-rolled readers collapsed onto it on a branch. Components/runtime-mode deferred; thin standalone package → [Item 44](#44--reader-as-a-thin-standalone-package-friend-facing-distribution). Plan: `plans/v1.0/npx/reader-package-plan.html`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |     |
| 45  | Static-assets blob store + auto-detect + export  | ✅ **Shipped 2026-08-07 (media-manager side)** — opt-in `assets: { dir, baseUrl }` in `media-manager.config.json` stores blobs in the host's served static folder (CDN-served, **not** bundled into a size-capped serverless function) instead of `<root>/media/files`. Single seam: `getGlobalFilesDir()` honors `MEDIA_MANAGER_ASSETS_DIR` (+ `isStaticAssetsMode`/`getAssetsBaseUrl`), plumbed by the CLI; the `assets` block is read from config even for arg/env roots (applied only when the config root matches). `reconcile()` **gates auto-adoption off in static mode** so a shared static dir can't pull in the site's own assets. Reader **`ReaderOptions.assets.baseUrl`** synthesizes URLs from the manifest (no `files` glob; a glob wins; encodes; case-collision throws; `missing` follows the manifest). `config`/`init` **auto-detect** the folder (SvelteKit `static/`, Next/Astro `public/` → dedicated `media` subfolder; `--assets-dir`/`--assets-base-url`/`--classic`); `doctor` validates dir↔manifest (fails on missing blobs/collisions, warns on strays); **`export <dest>`** writes a canonical re-openable workspace (blobs reunited by manifest, `google.json` secret excluded). Plan: `plans/static-assets-and-export.html`. Remaining out-of-repo: nicb.at cutover (P7) + optional content-hash cache-busting.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |     |
| 46  | Storage-location UI + blob migration             | ✅ **Shipped 2026-08-17** — a **Storage** section in app Settings (`StorageSettings.svelte` in the `SettingsButton` dialog) shows where blobs live and lets you point them elsewhere — classic↔static or static→static relocate — **moving the existing blobs** with the change (**move** / **copy** / **leave**). Engine `assetsMigrate.ts` (`migrateBlobs`/`previewMigration`): manifest-authoritative (only registered blobs move; foreign static-folder files untouched), copy→verify→delete under the manifest lock, aborts on a destination name conflict or (unless forced) a blob missing at source. Server glue `server/storageConfig.ts` **persists** the choice to `media-manager.config.json`'s `assets` block — **creating the file on first save** when none exists (the CLI now always passes `MEDIA_MANAGER_CONFIG_PATH`, falling back to `<root>/media-manager.config.json`) — and **applies it live** by flipping `process.env.MEDIA_MANAGER_ASSETS_DIR`/`_BASE_URL` (no restart; `getGlobalFilesDir()` reads env per call). API: `GET`/`POST /api/settings/storage` + `POST /api/settings/storage/preview` (dry run). On success the UI fires the refresh bus so open grids re-list. Builds on Item 45's seam; makes the nicb.at cutover a one-click in-app action (git commit + the reader-code change stay manual). Plan: `plans/assets-folder-ui-and-migration.html`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |     |
| 35  | Remove (or actually use) the `sharp` dependency  | ✅ **Resolved 2026-08-18 by Item 15** — the "actually use it" branch won: `sharp` is now the encoder behind the compression pipeline (`src/lib/server/compression/generate.ts` + `ssim.ts`). No longer a dangling dependency.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |     |
| 15  | Image Compression Management                     | ✅ **Phases 1 + 2 shipped 2026-08-18** — compressed twins alongside the originals, measured and reported. **Presets are the unit; things subscribe to presets** (a blob's derivative set is the _union_, so a file in two classes with different settings has no conflict to resolve — that framing is what unblocked the item). Registry in `media/settings.json` (phase 1: a workspace-wide subscription only). Generator `server/compression/generate.ts` (`sharp`, `.rotate().keepMetadata()` so orientation + ICC survive, discard-if-larger, skips recorded **with a recipe** so they're never retried); quality measured as **SSIM** (`ssim.ts`, ~60 lines, no new dependency; uniform 8×8 window, luma-only — and blind to orientation loss, which is why that's a generator rule). Background worker `queue.ts` (bounded concurrency + **batched manifest writes**, because per-file writes would starve every grid read of the manifest lock). Manifest gained `derived` (declared on `ManifestEntrySchema` _and_ the reader's `parseManifest` — a bare `z.object` strips undeclared keys, so an unguarded block would vanish on the next unrelated write). `reconcile` now backfills `size`, fixing a pre-existing empty `file:size`. Derivatives follow the blob through rename/delete/storage-move/`export`. `/compression` page + `?preset=` on the blob route (explicit 1-hour cache lifetime). Reader: `item.variant()`/`variantInfo()` off an optional `derived` glob, on a **separate preset-keyed index** (folding it into `assetIndex` would have silently disabled baseUrl synthesis for every original). Resolved the open question — "decide the one resize pipeline before building two parallel ones" — and settled [Item 35](#shipped--folded); [Item 23](#23--video--gif-media-support) now depends on it. **Phase 2** then made the union live: per-class subscriptions (`ClassConfig.compressionPresets`, in the class settings dialog) union with the workspace one, with `pruneUnsubscribed` dropping a derivative only when _no remaining_ subscriber wants it; width-bearing presets (SSIM vs a matched-size original, so the score is codec loss not the resize); reader `srcset()`; the per-file Compression section (`GET /api/files/[id]/compression`); and `file:saved`/`file:quality`/`file:presets` + `saved`/`quality` sort keys off a compact `FileItem.compression` summary. Phase 3 (video) remains unscheduled by design; the deferred versioned-URL decision is [Item 47](#47--versioned-derivative-urls-cache-busting). Plan: `plans/image-compression.html`. |     |
