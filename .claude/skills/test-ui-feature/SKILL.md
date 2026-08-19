---
name: Test a UI feature (Playwright)
description: Manually test a UI feature of this media-manager app end-to-end by building it, serving the in-repo test fixture, and driving the running app with Playwright (headless Chromium). Captures screenshots (PNG) of static states and/or video (WebM) of multi-step flows to the gitignored .screenshots/ folder and reports the file paths. Use when asked to test, verify, try out, screenshot, record, or "see working in the browser" a UI feature, route, or change in this project.
argument-hint: [feature or route to test, e.g. "image linking" or "/media/notes"]
allowed-tools: Bash, Read, Write
---

# Test a UI feature (Playwright)

Drive the **real running app** with Playwright against the committed test fixture, screenshot
the states worth showing, and report what you observed with **clickable screenshot paths**. The
feature to test is: **$ARGUMENTS** (if empty, ask the user what to test).

Why Playwright and not the Claude-in-Chrome extension: the extension only returns screenshots
_inline_ (its `save_to_disk` persists nothing reachable here), and this app keeps UI state out
of the URL, so a one-shot headless URL capture can't reproduce an open editor / applied filters.
Playwright drives **and** screenshots any state in one session, writing real PNGs to disk.

Harness background: `test-fixtures/README.md` and the "Testing features in the built app"
section of `CLAUDE.md`. The capture helper is `scripts/ui-capture.mjs`.

## 1. Prerequisite (one-time)

A browser must be provisioned for Playwright:

```bash
npx playwright install chromium     # bundled browser (recommended)
```

If that download is unavailable, set `PW_CHANNEL=chrome` when running the capture script to
reuse the system `google-chrome-stable` instead.

## 2. Build (only if you changed code)

`npm run test:serve` **only builds when `build/` is missing**. If you (or the user) edited
anything under `src/`, the stale build is served and you'll test old code. So:

- Testing a code change you just made → `npm run build` first (or `rm -rf build`).
- Testing existing/unchanged behavior → skip; `test:serve` builds if needed.

## 3. Start the server (background) and wait for ready

```bash
npm run test:serve -- --no-open      # run_in_background: true
```

This copies `test-fixtures/` → the gitignored `test-data/` working copy (fresh every run) and
serves on **http://localhost:3000**. Poll until it answers:

```bash
for i in $(seq 1 90); do curl -sf -o /dev/null http://localhost:3000/api/media-types && { echo UP; break; }; sleep 1; done
```

The seed has one media type of every kind: `Images` (3 linked images), `Documents` (generic,
1 linked file), `Notes` (json, 2 records), `Files` (blob_store, browse-only), `Globals`
(singleton). Overview at `/`, each editor at `/media/<typeId>`.

## 4. Drive + capture with Playwright

**Pick the artifact that fits the feature — screenshots, video, or both:**

- **Screenshots (PNG)** — for features whose evidence is a _state_: a rendered grid, an open
  editor with the right fields, a populated form, a validation/error message, an empty state.
  Cheaper, easier to eyeball, and you can take several per run. Use `shoot(name)`.
- **Video (WebM)** — for features whose evidence is _motion or a sequence_: drag-to-reorder,
  the masonry relayout on resize, upload/link/unlink flows, navigation sequences, transitions
  or anything where the in-between frames matter. Enable with `launchUi({ video: true })`; the
  recording is finalized and named on `close()`.
- You can do **both** in one run (record video _and_ `shoot()` key frames).

Write a short throwaway script to **`.screenshots/_run.mjs`** (the whole folder is gitignored),
importing the helper, then run it with `node .screenshots/_run.mjs`. The helper gives you
`page` (a Playwright page scoped to the app), `errors` (console errors + page exceptions),
`shoot(name)` (→ absolute PNG path), and `close()` (→ absolute WebM path when `video` is on).

### Capture ALL states in ONE script — do not run one screenshot per script

The slow way to verify is to author a script for state A, run it, read the result, author a
script for state B, run it, and so on. Each separate `node _run.mjs` pays a fresh Chromium
launch **and** a full model round-trip, so ~12 shots fragmented into 7 scripts costs 7× what it
should. **Plan every state worth showing up front, then drive them all in a single `_run.mjs`:
one browser launch, navigate → `shoot()` → navigate → `shoot()` …** The helper accumulates
every shot in `ui.shots`, so one run prints all the paths at once.

This is about not _fragmenting states you already know you need_ — it is **not** "one shot at
verification." Iterating is expected: if a run surfaces a bug, a regression, or a state you
couldn't have foreseen, **run again** (rebuild first if you changed code). The goal is that each
run covers everything you currently know to check, so the follow-ups are driven by new findings
— not by having split a known checklist across seven scripts. Keep testing until the feature is
actually verified; batching is the floor on thoroughness, never the ceiling.

Structure the run as a list of **scenarios**, each in its own `try/catch` so one bad selector
doesn't abort the batch and throw away the other shots (a mid-script failure is the main reason
a run gets restarted from scratch). Capture what you can, log what failed, keep going, then print
a **failure summary** at the end — treat any failed scenario, or a `shots` list shorter than you
expected, as **verification not done**. A screenshot existing is not proof the state is correct:
actually open the PNGs.

**Each scenario gets a clean data root via `ui.reset()`** — it navigates to `about:blank` (so no
in-flight autosave writes into the tree), wipes `test-data/`, and re-copies the pristine fixture,
all **without restarting the server** (the app reads from disk per request). So scenarios are
genuinely independent: count assertions like `Images (3)` and empty-state checks stay true no
matter what an earlier scenario did. Steps that must build on each other (upload → it appears →
edit it) belong **inside one scenario**, between resets — not split across them. Combined with a
warm background server (§3, started once), this collapses the whole verify stage into a single drive.

Screenshot template — adapt the navigation/interaction to the feature under test:

```js
import { launchUi } from '../scripts/ui-capture.mjs';

const ui = await launchUi(); // headless; viewport 1440x900; baseURL :3000

// One entry per independent scenario: a label + a drive(page, shoot). ui.reset() runs a clean
// fixture before each, so scenarios can't contaminate each other. Cumulative steps (and multiple
// shoots) live INSIDE one scenario — that's the unit that shares state.
const scenarios = [
	[
		'images-grid',
		async (p, shoot) => {
			await p.goto('/media/images');
			await p.getByText('Images (3)').waitFor(); // wait for real content, not a fixed sleep
			await shoot('images-grid');
			// Interaction state that is NOT in the URL — exactly what needs a live driver:
			await p.getByText('Sunset', { exact: true }).first().click();
			await p.getByText('sunset.png').waitFor();
			await shoot('sunset-editor-open');
		}
	],
	[
		'notes-empty',
		async (p, shoot) => {
			await p.goto('/media/notes'); // starts from the pristine fixture again, not images' leftovers
			await shoot('notes-grid');
		}
	]
	// ...add every other scenario here; each runs in this one browser, each on fresh data.
];

const failures = [];
try {
	for (const [name, drive] of scenarios) {
		await ui.reset(); // about:blank → wipe test-data → re-copy fixture; no server restart
		try {
			await drive(ui.page, ui.shoot);
		} catch (err) {
			failures.push(name);
			console.log(`SCENARIO_FAILED: ${name} — ${err.message}`); // keep going to the next scenario
		}
	}
	console.log('CONSOLE_ERRORS:', ui.errors.length ? ui.errors : 'none');
	console.log('SHOTS:', ui.shots); // every absolute path, from the single run
	console.log(failures.length ? `VERIFY_INCOMPLETE: ${failures.join(', ')}` : 'ALL_SCENARIOS_OK');
} finally {
	await ui.close(); // always close in finally so a failed assertion can't leak the browser
}
```

Video template — records the whole session; the `.webm` path comes back from `close()`:

```js
import { launchUi } from '../scripts/ui-capture.mjs';

const ui = await launchUi({ video: true, videoName: 'images-flow' });
try {
	await ui.page.goto('/media/images');
	await ui.page.getByText('Images (3)').waitFor();
	await ui.page.getByText('Sunset', { exact: true }).first().click();
	await ui.page.getByText('sunset.png').waitFor();
	// ...continue the flow; every step is recorded...
	console.log('CONSOLE_ERRORS:', ui.errors.length ? ui.errors : 'none');
} finally {
	const videoPath = await ui.close(); // finalizes + renames the WebM, returns its absolute path
	console.log('VIDEO:', videoPath);
}
```

WebM plays in any browser/VLC; convert to GIF with `ffmpeg` if a GIF is specifically needed.

Selector tips for this app:

- Prefer `getByText` / `getByRole` over CSS. **Svelte binds input values as the DOM property,
  not the `value` attribute**, so `input[value="…"]` won't match — assert on a visible label or
  read `await locator.inputValue()` instead.
- The grid label may be truncated (e.g. `Sun…`); the **sidebar** list item is the full name
  (`getByText('Sunset', { exact: true })`).
- Headless Chromium renders the **light** theme. If you need dark, pass a `colorScheme` via the
  context (extend the helper) — cosmetic only.

## 5. Clean up

- Stop the background server. The tree is `serve-test.mjs` → `media-manager.js` → `node build`,
  and killing the top **leaves `node build` orphaned on port 3000** (next run → `EADDRINUSE`).
  Kill by port (also avoids `pkill -f` matching its own command line):
  ```bash
  PID=$(ss -ltnp 2>/dev/null | grep ':3000' | grep -oP 'pid=\K[0-9]+' | head -1)
  [ -n "$PID" ] && kill "$PID"
  (ss -ltnp 2>/dev/null | grep ':3000' && echo "STILL LISTENING") || echo "port 3000 free"
  ```
- Playwright closes its own browser via the `finally` block — nothing else to stop.
- `test-data/` and `.screenshots/` are gitignored; leave them. Keep the screenshots so the user
  can open them.

## 6. Report

Tell the user: the route/feature tested, the steps driven, and the result (pass/fail with
concrete evidence). **List every saved artifact as an absolute path** — screenshots
(`.../.screenshots/…-sunset-editor-open.png`) and/or the video (`.../.screenshots/…-images-flow.webm`) —
so they can open them. Include any console errors — but note that a lone `404 /favicon.ico` is
expected (the app ships no favicon), not a real failure. Be honest about anything you couldn't
verify.
