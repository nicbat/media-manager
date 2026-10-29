---
name: test-ui-feature
description: Test Media Manager UI behavior in headless Chromium against the built Node server and disposable fixture data; capture PNG screenshots or WebM video when useful. Use for requests to exercise, verify, screenshot, or record this app's UI.
---

# Test a Media Manager UI feature

Use the real built app and Playwright. Read `AGENTS.md` and `test-fixtures/README.md` for the current data layout. Running the app mutates its data root; use disposable data.

## Prepare and serve

- After changing source, run `npm run build`. `test:serve` only builds when output is absent, so it can otherwise serve stale code.
- Start `npm run test:serve -- --no-open` in a background terminal. This refreshes the gitignored `test-data/` copy of `test-fixtures/`.
- Read the actual `Listening on http://…` readiness line. The CLI uses an ephemeral port; do not assume port 3000. Set `UI_BASE_URL` to that URL before starting the capture helper. A deliberately pinned `--port N` is also supported.
- Poll a cheap route on the actual URL before driving the UI.
- Install Chromium with `npx playwright install chromium` if necessary, or set `PW_CHANNEL=chrome` to use an installed Chrome.

The fixture has the All Files hub (`/files`), `images` and `documents` classes (`/files?class=images`), Notes records (`/media?type=notes`), and Globals (`/globals`). There is no reserved Files media type or linked/unlinked membership state. Read fixture IDs when a scenario needs a specific record.

## Drive and capture

Use `scripts/ui-capture.mjs` from a throwaway script under the gitignored `.screenshots/` directory. The helper reads `UI_BASE_URL` and returns `page`, `errors`, `shoot(name)`, and `close()`. Run related interactions in one browser session. Use screenshots for static states and `launchUi({ video: true })` for a meaningful sequence.

```js
import { launchUi } from '../scripts/ui-capture.mjs';

const ui = await launchUi();
try {
	await ui.page.goto('/files');
	await ui.page.getByText('sunset.png', { exact: true }).first().waitFor();
	await ui.shoot('files');
	console.log('Errors:', ui.errors);
} finally {
	await ui.close();
}
```

Prefer roles, labels, and visible text for interactions. Read controlled input values with `inputValue()`. For editing fixes, assert focus/caret and persisted data after reload; a screenshot alone does not prove saving worked.

For repeatable regression coverage, extend `scripts/test-browser.mjs` and run `npm run test:browser`. It builds by default; `-- --skip-build` requires a known-fresh build. Each scenario gets its own fixture copy and server, and failures retain screenshots and traces under `.screenshots/`.

## Finish

Close the browser in `finally` and stop only the server processes started for the test. Avoid resetting fixture data while requests are pending; restart the disposable server between independent mutation scenarios.

Report the behavior exercised, assertions, errors, and limitations. Link every saved screenshot/video/trace using its absolute filesystem path.
