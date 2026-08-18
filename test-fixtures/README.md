# test-fixtures

A **pristine, committed sample data root** in the **file-first layout**, so all storage/UI
code paths can be exercised:

| Path                           | What                                                                                                                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `media/files/`                 | The global blob dir: three PNGs, one `.txt`, one transposed `.jpg`, and one mis-extensioned `.jpg`                                                                                                                                   |
| `media/manifest.json`          | Blob registry (v2) with the derived `classes[]` membership index                                                                                                                                                                     |
| `media/files/rotated.jpg`      | Unclassified JPEG with EXIF Orientation 6 + intentionally **transposed** stored dims (1200×800 vs displayed 800×1200) — exercises the Item 13 dimension-mismatch warning + fix                                                       |
| `media/files/mislabeled.jpg`   | Unclassified **PNG bytes** with a `.jpg` name — the sniff detects `.png`, exercising the Item 12 extension-mismatch badge + one-tap "Fix to .png"                                                                                    |
| `media/classes/images.json`    | Class over the three PNGs; has a `related_doc` **file** field (one valid ref, one broken) + an `album` **record** field two-way **linked** to `albums.photos`; `config.icon: image`                                                  |
| `records/albums/`              | `json` type with a `photos` **file** field scoped to the `images` class and two-way **linked** to `images.album`; one record "Vacation 2026" whose `photos` = sunset + ocean (mirrors the `album` values on those two image records) |
| `media/classes/documents.json` | Class with the `.txt` as a member (any file type); `config.icon: file-text`                                                                                                                                                          |
| `settings.json`                | App-wide UI prefs (grid size, navigation) — hoisted out of `media/settings.json` (Item 18)                                                                                                                                           |
| `media/settings.json`          | Media-scoped prefs: `classOrder` (Item 18) + the `compression` preset registry (Item 15) — one `web` preset, WebP q80, applied to every image                                                                                        |
| `records/settings.json`        | Records-scoped prefs — empty `{}` (the dormant `typeOrder` home; Item 18 / Item 41)                                                                                                                                                  |
| `records/notes/`               | `json` record type; two records; `attachment` **file** field + `related` **record** field (each: one valid, one broken); `settings.json` `icon: newspaper`                                                                           |
| `globals/`                     | The reserved `json` singleton — stays **top-level** (not under `records/`)                                                                                                                                                           |
| `posts/settings.json`          | Posts collection registry (Item 14): `words` (typed frontmatter hints incl. `cover`→file, `date`) + `now`                                                                                                                            |
| `posts/words/tidepooling.md`   | Golden sample post — frontmatter `cover` = sunset blob (`mm://`), prose with marks, an inline `mm://` image, one `mm-beside` island (forest blob), and a fenced `bash` block                                                         |
| `posts/now/reading.md`         | A short code-block post (a `ts` fence) in the `now` collection                                                                                                                                                                       |

**No `media/derived/` is committed, on purpose.** Compressed derivatives (Item 15) are _generated_,
not authored — the seed carries the preset registry that describes them, and the first serve generates
the tree. That is deliberate: it means `npm run test:serve` exercises the real ingest/backfill path
from an empty state every time, rather than testing against binaries that would silently rot whenever
a fixture image changed. Delete `test-data/media/derived/` at any point and a backfill rebuilds it.

Every blob lives in `media/files/` (`getGlobalFilesDir()`) and is registered in
`media/manifest.json` with a stable id; a class is a member-keyed metadata table
(`media/classes/<id>.json`). The deliberately broken `file` references (`deadbeef-0000-…`) exercise
the global missing-files warning; the broken `related` **record** reference (`deadbeef-1111-…` on the
second note) exercises the missing-record indicator. The `images.album` ⇄ `albums.photos` pair
exercises **two-way linked relations** (edit either side and the engine mirrors it). See
`docs/FILE_FIRST_CLASSES.md` and `CLAUDE.md`.

## How to use it

```bash
npm run test:serve        # builds if needed, copies this seed to a gitignored
                          # test-data/ working copy, and serves it on :3000
npm run test:serve -- --no-open
```

**Do not point the app directly at this folder.** Running the app mutates its data root
(heals settings, writes data files, can rename/strip blob references), which would dirty
the committed seed. `test:serve` always serves a throwaway copy at `test-data/`.

## Keeping the seed current

When you change on-disk structure — `settings.json` / data-file layout, reserved-group
behavior, or media-kind semantics — **update this seed in the same change** (the same
discipline as `docs/FEATURES.md`). The reliable way to regenerate it: serve a scratch
root, recreate the classes/types via the UI/API, then copy the result back here. For a pure
on-disk format migration, running `node scripts/upgrade-data.mjs test-fixtures --apply`
against an old-layout seed is also valid (this is how the `media/` layout was generated).
