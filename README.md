# media-manager

Local-first media metadata manager built with SvelteKit and Svelte 5. Files share one blob store; optional classes add schema-driven metadata. JSON records, Globals, and Markdown Posts live alongside them. State is stored on disk, with no database.

## What it does

- **All Files:** upload and browse arbitrary files with stable IDs, search, class filters, and image metadata/compression tools.
- **Classes:** opt files into one or more schemas. Removing class membership leaves the original file on disk.
- **Records and Globals:** edit schema-driven JSON records or a free-form singleton, with file and record references.
- **Posts:** edit Markdown bodies and frontmatter, preview photo layouts, and consume workspace data through `media-manager/reader`.
- **Autosave:** commit on field intent with an idle safety net. See [the feature registry](docs/FEATURES.md) for exact behavior and known limits.

## Running it

The shipped app is a **Node server** (SvelteKit’s adapter-node). The easiest way to run it is the **`media-manager`** CLI, which discovers your data root, uses the **prepared editor build**, binds a **free ephemeral port** (so it never collides with another dev server), and opens the browser when ready.

### Point it at a data folder

```bash
npm install
node bin/media-manager.js /absolute/path/to/my-data
```

`npm install` prepares the editor (`build/`) and reader (`dist/reader/`). In a source checkout, a missing editor build is also built on first run (`--rebuild` forces a fresh build). Pass `--no-open` to skip the browser, or `--port N` to pin a port instead of the ephemeral default.

### Zero-config: a `media-manager.config.json`

Drop a config file at (or above) your working directory and run `media-manager` with **no arguments** — ideal for running inside another project’s repo:

```jsonc
// media-manager.config.json
{ "root": "./src/assets/media_manager" }
```

`root` is resolved **relative to the config file**. Root resolution precedence:

**explicit arg → `MEDIA_MANAGER_ROOT` env → `media-manager.config.json` (walked up from cwd) → friendly error.**

### Verbs

- `media-manager [serve]` — run the server (default).
- `media-manager init [dir]` — scaffold a **new empty** workspace + a starter `media-manager.config.json`.
- `media-manager config [dir]` — write a `media-manager.config.json` for a workspace you **already have** (no scaffolding; `--force` to overwrite an existing one).
- `media-manager build` — (re)build `build/` in a **source checkout** and exit, **without** serving (e.g. after a `git pull`).
- `media-manager doctor` — diagnose the resolved root / config / build **without** starting the server.

## Development server

For local development with hot reload:

```bash
npm install
MEDIA_MANAGER_ROOT=./my-data npm run dev
```

Create the root folder first:

```bash
mkdir -p my-data
```

Open the dashboard to browse All Files, classes, record types, Globals, and Posts. Create a class or record type from the corresponding controls.

## Data layout

```text
<root>/
  settings.json
  media/
    manifest.json        # stable file IDs and derived indexes
    files/               # originals, unless static-assets storage is configured
    classes/<id>.json    # schema, config, and per-file metadata
    derived/<preset>/    # generated compressed variants
    settings.json
  records/
    settings.json
    <typeId>/settings.json
    <typeId>/data.json
  globals/settings.json
  globals/data.json
  posts/settings.json
  posts/<collection>/<slug>.md
```

Class files are authoritative for membership; the manifest's membership index is derived. Display-name changes preserve class/type IDs. Static-assets mode can place originals and derivatives in a host site's served directory; the optional `assets` config controls that location.

For older data roots, back up the workspace and inspect the migration dry run before applying it:

```bash
npm run upgrade-data -- /absolute/path/to/data
npm run upgrade-data -- /absolute/path/to/data --apply
```

The app reads the current layout and rejects detected older layouts with migration guidance. See [docs/FILE_FIRST_CLASSES.md](docs/FILE_FIRST_CLASSES.md) and [docs/FEATURES.md](docs/FEATURES.md) for the storage model.

## CLI (`media-manager`)

```bash
media-manager [serve] [root] [--port N] [--no-open] [--rebuild] [--body-size-limit N]
media-manager init [dir]            # scaffold a new empty workspace + config
media-manager config [dir]          # write a config for a workspace you already have (--force to overwrite)
media-manager build                 # (re)build a source checkout and exit, without serving
media-manager doctor                # diagnose root / config / build, without starting
media-manager --help
```

Flags:

- `--port N` — pin a fixed port (default: an ephemeral OS-assigned port)
- `--no-open` — do not open a browser when the server starts
- `--rebuild` — force a fresh `build/` in a source checkout
- `--force` — (`init` / `config`) overwrite an existing `media-manager.config.json`
- `--body-size-limit N` — request body size limit in bytes (uploads)
- `-h`, `--help` — show usage

### Running via `npx`

Publishing to the npm registry is a later phase — until then `npx media-manager` from the registry isn’t available, but you can run it through `npx` from a local checkout or as a dependency of another project:

```bash
# A) from a clone of this repo (npm install prepares the build):
git clone git@github.com:nicbat/media-manager.git
cd media-manager && npm install
npx media-manager /path/to/my-data        # runs the package's own bin

# B) as a local dependency of another project — in that project's package.json:
#   "devDependencies": { "media-manager": "file:/path/to/media-manager" }
# then, from the project (with a media-manager.config.json present):
npm install
npx media-manager

# C) straight from GitHub, no clone — npm prepares the build before installing:
npx github:nicbat/media-manager          # if the repo is public
npx git+ssh://git@github.com/nicbat/media-manager.git   # private repo: uses your SSH key
npx github:nicbat/media-manager#v0.6.2   # pin a tag/branch/commit for reproducibility
```

Route **C** clones into npm's cache and installs the build dependencies there. The `prepare` lifecycle builds **both the editor and reader before npm applies the package's `files` allowlist**. Git dependencies (including `github:nicbat/media-manager#<ref>` in another project's `package.json`) and `npm pack` artifacts therefore contain `build/` and `dist/reader/`; starting the installed CLI requires no source tree or Vite build in the host project. Git installation requires lifecycle scripts to be enabled and takes longer while these builds run. Pin a tag or commit that includes this fix; older tags such as `v0.6.1` retain the packaging bug.

Registry/tarball consumers use those same prepared outputs. `media-manager build` and `--rebuild` are for full source checkouts with development dependencies installed. If an installed package lacks `build/index.js`, `doctor` fails and the CLI explains how to reinstall a complete package or build a full checkout. An empty `build/` directory does not count as a build.

**Warning:** default upload limits are for **local use only**. If you expose the server on a network, set a smaller limit or run behind a reverse proxy.

## Developer reference

- **Feature map** (behavior, file locations, API index, known gaps): [`docs/FEATURES.md`](docs/FEATURES.md)

## Scripts

- `npm run dev`: dev server (requires `MEDIA_MANAGER_ROOT`)
- `npm run build`: production build (output in `build/`; run with `node build` or the CLI above)
- `npm run preview`: preview build
- `npm run start`: run the production server (`node build`; set `MEDIA_MANAGER_ROOT` in the environment)
- `npm run check`: svelte check
- `npm run lint`: prettier + eslint
- `npm run test`: unit tests (vitest)
- `npm run test:package`: clean Git and tarball consumer installs, reader imports, and CLI HTTP smoke checks against disposable fixture copies (requires Git, npm, and registry access; never publishes)

- `npm run test:browser`: build and run production Chromium regressions against isolated fixture copies; install Chromium with `npx playwright install chromium` first. Use `-- --skip-build` only with a fresh build, and `-- --grep <text>` to select scenarios.
- `npm run test:contracts`: build and exercise the actual CLI/HTTP server, portable exports, invalid requests and malformed persisted data against temporary workspaces.
- `npm run check:plans`: validate backlog metadata, IDs, file pointers and the generated triage board; regenerate board data with `node scripts/check-plans.mjs --write`.

GitHub Actions runs these checks and a real-consumer packaging job on Node 24. Browser failures retain screenshots/traces for 14 days. The `.agents/skills/test-ui-feature/` workflow documents manual UI captures using the actual server readiness URL.

Durable recovery after browser/process termination is a separate, explicitly deferred feature (backlog Item 51). Pending network saves require the page to remain alive.
