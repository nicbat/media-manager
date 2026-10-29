# 1.0 plan — reassessed 2026-10-08

**Recommendation:** retain the old feature briefs as design history, but replace their release checklist with evidence that editing is reliable, data is recoverable, and representative libraries stay responsive. This is a proposed release gate, not a decision to release 1.0 or expand scope.

The old plan was useful for shipping the file-first storage reorganization, sorting/filtering, configurable grids, masonry, and the CLI/reader. Those are implemented. Since then Posts, Google Photos import, static-assets storage, compression, responsive variants, and range selection have also landed. The previous text describing compression as blocked and Posts as future work is obsolete.

Historical October 8 baseline: package/tag **v0.6.1**, plus the September 11 editor-stability commit. The October review started with **432 passing tests in 36 files** and clean Svelte checks. A Node test pass alone does not establish browser reliability or readiness for a public release.

## What remains useful from the old scope

- **Item 5, validation/repair:** valuable, but the old “verify-and-close” framing was wrong. `repairRecords` fills missing fields; it does not remove unknown keys or coerce existing values. Define safe policy before adding destructive repair. See [the corrected brief](05-validation-repair.md).
- **Item 3, selected-record JSON export:** a convenience, not evidence of release readiness. The shipped CLI workspace export already handles a different, broader portability need. Keep selected-record export optional until its consumer and data shape are clear. See [the corrected brief](03-bulk-operations.md).
- **Shipped briefs:** retain Items 8, 9, 10, 12, 13, 18, 30–34 as historical implementation references. Do not rerun their interviews or assume their old descriptions are current behavior; use [FEATURES.md](../../FEATURES.md).
- **Previously deferred:** class triage (19), external masonry dependency (39), registry publishing (43), and a separate reader package (44) stay optional. No automatic scope promotion.

## Proposed release gates

1. **Editing survives real browser events.** Run the built Node app against disposable roots. Assert focus, caret, text, and disk persistence across idle saves, blur, quick navigation, delayed responses, and cross-tab changes. Include Files, Records, Globals, and Posts, plus failed-save recovery. Item 48 tracks the remaining matrix; an initial browser gate is part of this review.
2. **Data operations have observable, recoverable outcomes.** Test HTTP error/status contracts, CLI root/config discovery, export/reopen, migration idempotence, malformed files, and lock contention. Existing migration and storage tests are a good foundation; Item 49 fills delivery-boundary gaps. Repair policy remains Item 5.
3. **Performance has a repeatable baseline.** Measure production UI and storage operations on declared synthetic sizes, distinguish cold/warm runs, report sample count and environment, and retain a rerunnable harness. Avoid asserting universal millisecond limits from one machine. Use deterministic complexity/read-write-count regressions where possible. Decide larger-catalog pagination/windowing from these results (Item 40).
4. **Packaging works as documented.** Run build, reader build, type checks, relevant lint, Node tests, and browser tests from the checkout. Verify the supported local/git install flow. npm publishing is a separate proposal, not a prerequisite inferred from the name “1.0.”
5. **Documentation agrees with evidence.** Backlog IDs remain stable, ready items have zero unresolved questions, active file pointers exist, and the triage board matches the backlog. Host-site content/deployment verification is Item 50, not a reason to relabel shipped editor work unfinished.

No gate is considered complete merely because it appears in this document. Record commands, outcomes, limits, and remaining failures in the change that runs it.

## Suggested next work, in order

- Browser coverage and HTTP/CLI/recovery checks (48, 49) are completed by the October 28 cleanup and run in CI. Durable recovery after browser termination is explicitly deferred as Item 51.
- Settle repair policy (5) before expanding its write behavior. Unknown user keys should not be deleted based on an old checklist.
- Use measured large-library behavior to choose the next performance change (40/42). Do not switch to SQLite or implement virtualization solely because the backlog mentions them.
- For the next visible feature, prioritize file-reference previews/navigation (26), then PDF preview (21) if documents are a frequent workflow. PDF thumbnails still need a renderer decision; video (23) needs a decoder/distribution decision.
- Validate nicb.at integration separately if it is the next real consumer task (50). Defer npm packaging and selected-record export until there is a concrete need.

## How we build each feature (the working agreement)

Use the current backlog acceptance criteria and existing session authorization. Inspect code before asking questions. Resolve actual product unknowns before implementing dependent changes; routine fixes and measurement do not require a new design interview. For substantial UI or storage redesigns, make the proposal concrete before seeking a decision.

Implement in small reviewable changes, test at the boundary affected, and update the feature registry with behavior changes. Always test against disposable data. A screenshot is supporting evidence, not an assertion that data persisted. Retain failure artifacts and describe what was not verified.

## Historical briefs

- [Verbose grid](08-verbose-grid.md), [sorting](09-sorting.md), [empty-field filter](10-missing-filter.md)
- [Extensions](12-fix-extension.md), [dimensions](13-swap-dimensions.md), [masonry](34-masonry.md)
- [Records reorganization](18-records-storage-reorg.md), [class triage](19-should-be-here.md)
- [CLI and reader](npx/README.md)
- [Bulk export remainder](03-bulk-operations.md), [repair policy](05-validation-repair.md)

The [backlog](../../FUTURE_CHANGES.md) and [triage board](../../FUTURE_CHANGES_TRIAGE.html) track candidates. They are not a second source of truth for shipped behavior.

## Evidence from this review

The test suite is **strong in storage integration, thin at the application boundary**. It includes actual filesystem writes and reference cascades, an upgrade-data subprocess/idempotence check, real image encodes, and a 400-file compression/concurrent-reader load test. Calling those tests rudimentary would understate their value. However, the original suite had no committed browser regression gate, direct HTTP contract suite, or repository CI configuration. A mocked DOM-shaped object in `stableValue.test.ts` cannot prove that Svelte keeps a focused input mounted.

The new browser work reproduced a specific loss of data: while a save response was delayed, newer edits were skipped on an entity switch. Files also advanced its saved baseline from mutable state after awaiting a request, marking text that had never been sent as saved. Immutable outgoing snapshots, ordered saves, and entity-scoped completion/reload guards address these failures. These are stronger signals of useful test coverage than the raw test count. Tab/process termination still cannot be treated as guaranteed persistence; queued writes require the page to remain alive.

Measured performance improvements (same machine, serialized runs):

- **Storage, 10,000 files / 100 selected:** add median **4464.87 → 44.83 ms**; remove **4419.50 → 44.50 ms**. One manifest write per selection replaces one per file. Five timed rounds after one warmup, five classes, one-byte non-image blobs. Warm list calls were about 82 ms before; this change targets membership writes, not list caching.
- **Browser, 1,000 tiny PNGs:** initial listing requests **3 → 1**; median last tile insertion **779 → 294.7 ms**; median initial long-task total **651 → 260 ms**. Three fresh Chromium contexts against a warm production server at 1440×900. Initial load now waits for settings/URL restoration and masonry width measurement.
- **Limits:** final DOM size remains 6,173 nodes at 1,000 tiles; select-all stays about 107 ms. Network-idle timing only moved about 1540 → 1380 ms, including its 500 ms wait. This is a rendering/startup improvement, not proof of faster real-photo delivery. No virtualization or cache was introduced.

[Raw matched measurements and limitations](../../performance/2026-10-08.json) are retained. Rerun `node scripts/perf-storage.mjs`; for the UI, first `npm run build`, then `node scripts/perf-ui.mjs` (defaults 1,000 tiles / 3 runs; `PERF_UI_COUNT=100` selects the smaller case). Install Playwright Chromium first if absent. Both harnesses create disposable roots and clean up their own processes/data. Small samples are evidence for these narrow changes, not universal performance budgets.

Final verification for this pass: **434 Node tests / 36 files passed; 7 production-browser scenarios passed; Svelte check reported 0 errors and 0 warnings; full Prettier + ESLint passed; production build succeeded.** Browser scenarios use a fresh fixture and server each time and retain screenshots/traces on failure. Planning validation covers all 51 immutable IDs (26 active, 25 shipped/folded). This paragraph records the original October 8 review; the completed follow-up is recorded below. Host deployment remains Item 50.


## October 28 integration and completion

The October work is reconciled with **v0.6.2**, including the Git packaging fix. The browser suite now covers Globals and Posts in addition to Files/Records, save failure and retry, delayed-response navigation, and linked data refreshed from another tab. Records reload effects depend on explicit navigation/refresh signals; they no longer subscribe to the state they rewrite. Quiet reloads preserve locally edited fields while adopting untouched fields from the server. Posts serialize immutable outgoing snapshots on navigation.

`npm run test:contracts` exercises the real CLI and built HTTP server for root precedence, nested config discovery, malformed config, ephemeral port readiness, doctor failure, child cleanup, static export/reopen, secret exclusion, missing/invalid IDs, malformed mutation bodies, and malformed persisted JSON. Export rejects an unreadable manifest before copying; selected mutation routes map malformed JSON to HTTP 400. Storage tests cover interrupted atomic replacement, lock contention, and stale-lock recovery. Atomic-write staging files are unique and cleaned after failure; this is not a guarantee against arbitrary power loss.

`.github/workflows/verify.yml` runs type/lint/planning/Node/HTTP/browser checks plus a separate packaging job on Node 24. Browser failures retain screenshots and traces. The current commands and coverage are documented in FEATURES.md; the October 8 timing artifact stays historical evidence.

Items 48 and 49 are folded into the feature registry. Item 50 remains a separate host-repo task. Item 51 records the user's explicit decision to defer durable browser-termination recovery until draft retention and conflict policies are settled. No host-site changes or new release are part of this cleanup.

Fresh combined validation on v0.6.2 is recorded in PR verification: type/lint/planning checks, 448 Node tests, 6 CLI/HTTP contract scenarios, and 16 production-browser scenarios. The small synthetic performance harnesses are smoke-tested separately; the October 8 timings above are not relabeled as new measurements.
