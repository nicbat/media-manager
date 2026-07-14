# media-manager

Local-first data manager built with SvelteKit + Svelte 5. Manages metadata for multiple media types: **images** (files + metadata), **generic / files** (loose files in a folder, optional metadata), and **pure JSON** (metadata only, e.g. projects list).

## What it does

- **Multi-media-type**: Open the app to see an overview of media types (e.g. Images, Projects). Each type lives in its own folder under a root directory.
- **Images**: Store image files and custom metadata (schema-driven fields). Upload, link/unlink, edit properties, delete.
- **Files (generic)**: Store arbitrary files in the type folder (not only images). Same UI patterns as images (linked/unlinked, upload, etc.); MIME/extension rules are relaxed for uploads compared to `images`.
- **Pure JSON**: Store records with no file attachment (e.g. a list of projects with title, description, links, tags). Same schema-driven fields and filters.
- **Schema = settings**: Each media type has one `settings.json` containing display name, kind, schema (field definitions), and app preferences (grid size, etc.). On first launch, the app may create default **`files`** (generic) and **`globals`** (json) groups under your root—see [`docs/FEATURES.md`](docs/FEATURES.md) for behavior details.

## Running it

The shipped app is a **Node server** (SvelteKit’s adapter-node). The easiest way to run it is the **`media-manager`** CLI, which discovers your data root, **builds on demand**, binds a **free ephemeral port** (so it never collides with another dev server), and opens the browser when ready.

### Point it at a data folder

```bash
npm install
node bin/media-manager.js /absolute/path/to/my-data
```

First run builds `build/` automatically (`--rebuild` forces a fresh build). Pass `--no-open` to skip the browser, or `--port N` to pin a port instead of the ephemeral default.

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
- `media-manager build` — (re)build `build/` and exit, **without** serving (e.g. after a `git pull`).
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

Open the app in the browser. You’ll see the **overview** of media types. Use **Create new** to add a media type (Images, Files, or Pure JSON). Each type gets its own subfolder under the root.

## Data layout

**Root folder** (e.g. `./my-data`) contains one **subfolder per media type**. The app scans the root for subfolders that contain a valid `settings.json` (our format). No manifest file.

### Images media type (e.g. `my-data/images/`)

- **settings.json** – display name, `kind: "images"`, `schema` (field definitions), app settings (grid size, etc.), `dataFileName`, `filesSubdir`
- **image-data.json** (or name in settings) – image records `{ id, file_name, linked, ...custom fields }`
- **files/** (or name in settings) – the image files

### Pure JSON media type (e.g. `my-data/projects/`)

- **settings.json** – display name, `kind: "json"`, `schema`, app settings, `dataFileName`
- **data.json** (or name in settings) – records `{ id, last_modified?, ...custom fields }`

### Generic / “files” media type (e.g. `my-data/files/`)

- **settings.json** – display name, `kind: "generic"`, optional `schema`, `dataFileName` (default `data.json`)
- **data.json** – image-catalog format `{ images: [] }` when created via the API (may be created on first use otherwise)
- **Files** live directly in the type folder (no separate `files/` subfolder)

## Migration from the old single-folder layout

If you previously used a single folder (e.g. `my-images/` with `settings.json`, `schema.json`, `image-data.json`, and `images/` inside):

1. Create a root folder and an `images` subfolder, e.g. `my-data/images/`.
2. Move your **image files** from `my-images/images/` into `my-data/images/files/` (or keep the name `images` and set `filesSubdir` in settings).
3. Merge **schema into settings**: create `my-data/images/settings.json` with:
   - `displayName`: e.g. `"Images"`
   - `kind`: `"images"`
   - `schema`: copy the contents of your old `schema.json` (the `schema` object).
   - `dataFileName`: `"image-data.json"`
   - `filesSubdir`: `"files"` (or `"images"` if you kept that name)
   - `gridSize`, etc. from your old `settings.json`
4. Move **image-data.json** into `my-data/images/image-data.json`.

**Optional migration script** (copies old folder into root/images/ with merged settings):

```bash
node scripts/migrate-to-media-types.mjs ./my-images ./my-data
```

The folder name (e.g. `images`) is the **media type id**; the display name is in `settings.json` and can be renamed in the UI.

## Key concepts

- **Stable identity**: Records are identified by a UUID (`id`). The UI does not put filenames in the URL.
- **Discovery**: The app scans the root folder for subfolders that contain a valid `settings.json`. No manifest.
- **Media type id** = folder name (e.g. `images`, `projects`). Renaming the display name in the UI does not change the folder name.

## CLI (`media-manager`)

```bash
media-manager [serve] [root] [--port N] [--no-open] [--rebuild] [--body-size-limit N]
media-manager init [dir]            # scaffold a new empty workspace + config
media-manager config [dir]          # write a config for a workspace you already have (--force to overwrite)
media-manager build                 # (re)build build/ and exit, without serving
media-manager doctor                # diagnose root / config / build, without starting
media-manager --help
```

Flags:

- `--port N` — pin a fixed port (default: an ephemeral OS-assigned port)
- `--no-open` — do not open a browser when the server starts
- `--rebuild` — force a fresh `build/` even if one already exists
- `--force` — (`init` / `config`) overwrite an existing `media-manager.config.json`
- `--body-size-limit N` — request body size limit in bytes (uploads)
- `-h`, `--help` — show usage

### Running via `npx`

Publishing to the npm registry is a later phase — until then `npx media-manager` from the registry isn’t available, but you can run it through `npx` from a local checkout or as a dependency of another project:

```bash
# A) from a clone of this repo (build is created on first run):
git clone git@github.com:nicbat/media-manager.git
cd media-manager && npm install
npx media-manager /path/to/my-data        # runs the package's own bin

# B) as a local dependency of another project — in that project's package.json:
#   "devDependencies": { "media-manager": "file:/path/to/media-manager" }
# then, from the project (with a media-manager.config.json present):
npm install
npx media-manager

# C) straight from GitHub, no clone — npx fetches the repo and builds on first run:
npx github:nicbat/media-manager          # if the repo is public
npx git+ssh://git@github.com/nicbat/media-manager.git   # private repo: uses your SSH key
npx github:nicbat/media-manager#v1.0.0   # pin a tag/branch/commit for reproducibility
```

Route **C** clones into npx’s cache, installs deps (incl. dev deps, so `prepare` runs), then the CLI **builds on demand** since `build/` isn’t committed — so the first run is slow, later runs reuse the cache (bump the `#ref` or `npx --ignore-existing` to refresh).

Once published, `npx media-manager` will fetch the **prebuilt** package from npm — consumers won’t build at all (the build ships in the tarball via `prepublishOnly` + `files`).

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
