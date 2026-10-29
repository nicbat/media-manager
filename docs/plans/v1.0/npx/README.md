# 1.0 Sub-project — npx Package + Reader

> **Status reviewed 2026-10-08:** Items 30–33 are shipped. The motivation/sequencing below is historical, not a claim that browse churn or fixed-port setup remains broken. See the reassessed parent release plan for current proposed verification gates.

> Part of [media-manager 1.0](../README.md). The biggest piece of the release: make media-manager runnable as an **npx package inside a host repo**, plus the read-only **reader** face. Items **30 · 31 · 32 · 33**.

> **✅ Mode A shipped 2026-06-28 — Items 30 · 31 · 32** (the editor "easier to run" experience; combined [run-experience plan](run-experience-plan.html)). **✅ Mode B shipped 2026-06-29 — Item 33** (the read-only **reader** data layer; [reader plan](reader-package-plan.html)). Remaining: carved-out follow-ups **42** (quiet-heal content-hash perf), **43** (editor registry publishing), **44** (thin standalone reader package) — all post-1.0.

- **Full design (existing):** [`../../npx-package-vision.md`](../../npx-package-vision.md) + diagram [`../../npx-package-vision.html`](../../npx-package-vision.html).
- **Decisions locked (2026-06-20):** **editor-first**; distribute as a **local dep** for now (`file:../media-manager` / git URL), publish in a later phase.
- **Two modes:** **Mode A** = the editor server that *mutates* the root (Items 30/31/32). **Mode B** = the read-only reader a host build consumes (Item 33) — **build-time/static, data-layer-only**; a `MediaManager.load` facade over two Vite globs, **not** the `fs`/root-threading shape originally assumed (that stays with Item 7's export CLI).

## Why these four, and the order

`32 → 31 → 30 → 33`:

1. **32 · Quiet heal** — today *just browsing* a git-committed workspace rewrites `media/manifest.json` (lazy-heal churn) and dirties the tree. That's unacceptable for an npx tool run inside someone's repo. Foundational — do it first.
2. **31 · Ephemeral port** — a fixed `PORT=3000` collides with the host's dev server. Bind port 0, auto-open the bound URL. Needs an `adapter-node` spike (can we read back the bound port?).
3. **30 · Zero-config root discovery** — bare `npx media-manager` finds the workspace with no args; adds `serve`/`init`/`doctor` verbs; folds in the **publishing** mechanics (former Item 27) as a later phase.
4. **33 · Reader (Mode B)** ✅ — read-only host integration, **shipped 2026-06-29**. The Phase-1 interview corrected the shape: the target host (nicb.at) consumes via **Vite bundle**, not `fs`, so the reader is **pure functions over already-parsed JSON** (the `fs`/root-threading refactor stays with Item 7's export CLI, not here). Build-time/static, data-layer-only; `media-manager/reader` subpath. See [reader plan](reader-package-plan.html).

Items 30/31/32 are the "safe to open committed data" trio — they're what makes running inside a host repo non-destructive.

## Briefs

- [`30-root-discovery.md`](30-root-discovery.md) — Editor npx setup, zero-config root discovery (+ publishing)
- [`31-ephemeral-port.md`](31-ephemeral-port.md) — Ephemeral port + auto-open
- [`32-quiet-heal.md`](32-quiet-heal.md) — Persist manifest reconcile only on real change
- [`33-reader-package.md`](33-reader-package.md) — Read-only host integration (Mode B) ✅ · full [reader plan](reader-package-plan.html)

## Working agreement

Same four-phase loop as the rest of 1.0 (see the [master working agreement](../README.md#how-we-build-each-feature-the-working-agreement)). Two emphases for this sub-project:

- **Research spikes are part of Phase 1/2.** 31 (does `adapter-node` accept `PORT=0` and expose the bound port?) and 33 (library-vs-export face) have genuine engineering unknowns — resolve them in the interview/plan, not mid-build.
- **Non-destructiveness is the headline acceptance.** The whole point is running inside a real repo without dirtying it — every brief's verification includes a **`git status` stays clean while browsing committed data** check.
