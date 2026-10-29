# Item 15 — Image Compression Management

> **Status reviewed 2026-10-08:** compression phases 1 and 2 shipped August 18. This brief is historical and any blocked/de-scoped implementation descriptions below are superseded by FEATURES.md and `plans/image-compression.html`. Video and cache-versioning follow-ups are Items 23 and 47.

> 1.0 brief. Backlog: [Item 15](../../FUTURE_CHANGES.md#15--image-compression-management). Build process: [working agreement](README.md#how-we-build-each-feature-the-working-agreement). **Status: blocked (1 open question — the asset-pipeline decision).** Resolve the pipeline question with Items 34/35 before building.

## Backlog snapshot

```yaml
status: blocked
size: M
usefulness: 2
priority: low
files: [src/lib/server/fileMetadata.ts, src/lib/storage/settingsFile.ts]
depends_on: []
open_questions: 1
acceptance:
  - Per-media-type compression setting (quality/target size)
  - On upload/modify, generate a compressed variant and record both paths
  - UI to choose original vs. compressed per record (or per export)
```

## What & why

Manage **compressed variants** of images (via `sharp`): keep the original, generate a quality/size-targeted variant, and let the user pick original-vs-compressed per record (or per export). Useful for keeping a tidy editing copy while publishing lighter assets. Explicitly non-urgent (2/5), but Nicholas pulled it into 1.0.

**The pipeline coupling is the whole story here.** Item 15 overlaps Item 7 (static export's asset volume), Item 34 (masonry/thumbnails), and Item 35 (the `sharp` decision). Shipping compression means **adopting `sharp`** — which *resolves Item 35* (the "remove or use sharp" decision) in the "use it" direction. So sequence this with 34/35 and **design one resize/variant pipeline**, not two parallel ones.

## Open question to resolve in the interview (Phase 1) — REQUIRED before building

1. **The one resize pipeline.** Decide the single server-side image pipeline that serves compression (15), thumbnails (23/34), and export resizing (7) — before building any of them. What does `sharp` produce, where do variants live on disk, and how are they recorded? Don't build a compression-only path that a later thumbnail task has to re-do.

Plus, given the file-first model, confirm in the interview:
- **Where the setting lives.** The backlog says "per-media-type," but `settingsFile.ts` is now `json`-only — images are **classes/blobs**. So is compression a **per-class** setting, a **media/-wide** default, or both? Decide against the current model (the original "per-media-type" wording predates file-first).
- **Variant storage & recording.** Where compressed variants sit under `media/` and how the manifest/class record references both original and variant paths.
- **Scope for 1.0:** auto-generate on upload vs. on-demand; choose-per-record vs. choose-per-export only.

## Build notes (Phase 3)

- Adopt `sharp` (already a declared-but-unused dep — this closes Item 35) for variant generation; keep it server-side in/near [`fileMetadata.ts`](../../../src/lib/server/fileMetadata.ts).
- Store the compression setting per the decided scope (likely the media settings and/or per-class config, not the json-only `settingsFile.ts`).
- Record both original and variant so neither is lost; the manifest/class record is the source of truth for the reference.
- **Update `test-fixtures/`** if the on-disk layout gains variant files or settings keys (CLAUDE.md rule).

## Verification stages (Phase 4)

- [ ] HTML plan approved with the **single asset pipeline** decided (shared with 34/35, and forward-compatible with 7/23) + the setting-location decision.
- [ ] `npm run check` + `npm run lint` clean.
- [ ] `npm run test` — variant generation produces a smaller file at the target quality; both paths are recorded; setting persists at the decided scope; original is never destroyed.
- [ ] `npm run test:serve` — upload an image, confirm the compressed variant is generated + selectable; toggle original-vs-compressed; confirm `sharp` works in the built Node app (native dep).
- [ ] `npm run build` succeeds with `sharp` now actually referenced (native-dep sanity for the npx packaging work, Item 30).
- [ ] UI capture of the original/compressed choice.
- [ ] `FEATURES.md` updated (compression setting + variant behaviour); Item 15 → **Shipped & folded**, and update **Item 35**'s disposition (sharp adopted); triage HTML synced.
