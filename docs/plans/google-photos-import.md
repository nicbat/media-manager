# Plan — Google Photos import (Picker API)

> **Status reviewed 2026-10-08:** implemented; August 17 added poll resilience and error diagnostics. This is the historical design, not an active build task. A live Google-account import has not been reverified in this review; use FEATURES.md for current implementation.

> **Status:** design complete — **`ready` to build** (not started). All four
> open questions were closed by research on **2026-06-29** (see §4). **Verdict:
> feasible.** Maps cleanly onto the existing upload → manifest path. The hard
> parts are all on Google's side (the picker-only access model + the 7-day
> Testing-mode token expiry), not ours — and BYO-credentials sidesteps Google's
> verification entirely (the Picker scope is *sensitive*, not *restricted*, so no
> CASA audit; Testing/Personal-use exemptions apply).
>
> **UI mockup:** [`docs/google-photos-import.html`](../google-photos-import.html)
> — 6-step interactive walkthrough (entry menu → setup → connect → Google picker
> → import → done). Backlog entry: **Item 37** in [`FUTURE_CHANGES.md`](../FUTURE_CHANGES.md).
>
> **Decisions locked (2026-06-22):**
> - **Credentials:** bring-your-own — each user supplies their own Google Cloud
>   OAuth client. No app-wide verification.
> - **Import target:** All Files (unclassified) — imported blobs are plain files,
>   classified later like any upload.
> - **Constraints:** documented prominently (see §0).

---

## 0. Constraints you are buying into (read first)

These come from Google's 2025 API changes and are **not** things we can engineer
around — they shape the whole UX:

1. **No library browsing or syncing.** The old Library API was removed
   2025-03-31. The **Picker API** is the only path. The user selects photos
   **inside Google's own hosted picker window**; our app only ever receives the
   items they hand-picked. There is no "import my whole library," no album
   listing, no background sync. Every import is a manual selection.
2. **The picker opens in a real browser tab.** `pickerUri` is **not**
   iframe-embeddable. We open it in a new tab/window and poll for completion.
3. **~60-minute download window.** Picked items expose a `baseUrl` that expires
   in ~1 hour and **requires the OAuth bearer header** to download. So we must
   download the bytes immediately after the user finishes picking — no deferring.
   **The `=d` download retains full resolution and all EXIF _except_ GPS/location**,
   which Google strips server-side — it cannot be recovered through the Picker path
   (`=dv` for video).
4. **7-day re-login in "Testing" mode.** Because each user runs their own
   unverified OAuth app (Testing publishing status), Google expires refresh
   tokens after **7 days**. Practically: the user re-connects ~weekly. (They can
   push their own Cloud project to "In production" to make tokens long-lived,
   but the "unverified app" warning screen persists either way.)
5. **First-run setup friction.** Bring-your-own-credentials means a one-time
   wizard: create a Cloud project, enable the Picker API, make a Desktop OAuth
   client, paste client ID + secret. Standard for self-hosted tools (rclone,
   Home Assistant, gphotos-sync) but it is real friction.

What we **get** in return: a free, official, supported API; full-resolution
downloads with EXIF intact **except GPS/location** (Google strips location on
`=d`; everything else feeds the existing EXIF tooling); and a flow that reuses
our blob/manifest plumbing almost entirely.

---

## 1. Backend workflow (the API dance)

```mermaid
sequenceDiagram
    autonumber
    actor U as User (browser UI)
    participant FE as SvelteKit UI<br/>(/files)
    participant SV as Our Node server<br/>(/api/google-photos/*)
    participant ST as Storage<br/>(manifest + media/files)
    participant G as Google OAuth +<br/>Picker API

    Note over U,G: ONE-TIME SETUP (bring-your-own credentials)
    U->>FE: Click "Import from Google Photos"
    FE->>SV: GET /api/google-photos/status
    SV-->>FE: { connected: false, hasCreds: false }
    U->>FE: Paste Client ID + Secret (setup wizard)
    FE->>SV: POST /api/google-photos/credentials
    SV->>ST: write google.json (client id/secret, mode 0600)

    Note over U,G: CONNECT (OAuth 2.0 loopback + PKCE)
    U->>FE: Click "Connect"
    FE->>SV: POST /api/google-photos/auth/start
    SV->>SV: start loopback listener (127.0.0.1:PORT)<br/>build auth URL (offline + PKCE)
    SV-->>FE: { authUrl }
    FE->>G: open authUrl in new tab
    U->>G: consent (click through "unverified app")
    G-->>SV: redirect 127.0.0.1/callback?code=...
    SV->>G: exchange code + verifier → tokens
    G-->>SV: access_token + refresh_token
    SV->>ST: persist refresh_token in google.json

    Note over U,G: PICK + IMPORT (per import)
    U->>FE: Click "Pick photos"
    FE->>SV: POST /api/google-photos/session
    SV->>G: POST /v1/sessions
    G-->>SV: { id, pickerUri, pollingConfig }
    SV-->>FE: { sessionId, pickerUri }
    FE->>G: open pickerUri in new tab
    U->>G: select photos in Google's picker
    loop poll every pollInterval until timeout
        FE->>SV: GET /api/google-photos/session/:id
        SV->>G: GET /v1/sessions/:id
        G-->>SV: { mediaItemsSet: false }
    end
    U->>G: finish selection
    FE->>SV: GET /api/google-photos/session/:id
    SV->>G: GET /v1/sessions/:id
    G-->>SV: { mediaItemsSet: true }
    SV-->>FE: { ready: true }

    Note over U,G: DOWNLOAD (within ~60 min)
    FE->>SV: POST /api/google-photos/import (sessionId)
    SV->>G: GET /v1/mediaItems?sessionId=... (paginate)
    G-->>SV: [ { baseUrl, filename, mimeType, ... } ]
    loop each item
        SV->>G: GET baseUrl + "=d"  (Bearer header)
        G-->>SV: image bytes
        SV->>ST: write media/files/<name> + registerBlob()
    end
    SV->>G: DELETE /v1/sessions/:id  (cleanup)
    SV-->>FE: { imported: N, fileIds: [...] }
    FE->>FE: reload All Files grid
```

### Endpoints we call on Google

| Step | Method + URL | Notes |
|------|--------------|-------|
| Auth | `accounts.google.com/o/oauth2/v2/auth` | offline + PKCE, scope below |
| Token | `oauth2.googleapis.com/token` | code→tokens, and refresh |
| Create session | `POST photospicker.googleapis.com/v1/sessions` | returns `pickerUri`, `pollingConfig` |
| Poll | `GET .../v1/sessions/{id}` | wait for `mediaItemsSet: true` |
| List | `GET .../v1/mediaItems?sessionId={id}` | `pageSize≤100`, paginate |
| Download | `GET {baseUrl}=d` + `Authorization: Bearer` | ~60-min expiry, full-res + EXIF |
| Cleanup | `DELETE .../v1/sessions/{id}` | avoid `RESOURCE_EXHAUSTED` |

**Scope (the only one needed):**
`https://www.googleapis.com/auth/photospicker.mediaitems.readonly`

---

## 2. Where the code goes

### New files

```
src/lib/server/googlePhotos.ts        # OAuth2 client + Picker REST calls (session/poll/list/download)
src/lib/storage/googleConfig.ts       # read/write media/google.json (client id/secret + refresh token), 0600
src/lib/api/googlePhotos.ts           # client wrappers (status, connect, session, import)

src/routes/api/google-photos/
  status/+server.ts                   # GET  → { hasCreds, connected, expiresHint }
  credentials/+server.ts              # POST → save client id/secret
  auth/start/+server.ts               # POST → { authUrl }, spins loopback listener
  auth/callback/+server.ts            # GET  → catches ?code=, exchanges, stores refresh token
  session/+server.ts                  # POST → create picking session → { sessionId, pickerUri }
  session/[id]/+server.ts             # GET  → poll status → { ready }
  import/+server.ts                   # POST → list + download + registerBlob, returns fileIds

src/lib/components/google-photos/
  GooglePhotosDialog.svelte           # the modal: setup wizard → connect → pick → progress → done
```

### Existing files we touch

| File | Change |
|------|--------|
| `src/routes/files/+page.svelte` | Add a **"⋮ More" overflow `DropdownMenu`** next to the existing Upload button (~line 759) containing **"Import from Google Photos…"** (+ "Manage connections…") — kept out of the primary toolbar since it's a rare action. Mount `GooglePhotosDialog`; on success call existing `loadMeta()` + `loadFiles()`. Compose the existing shadcn `DropdownMenu` primitive (same one `EntityRowMenu` uses). |
| `src/lib/api/files.ts` | (optional) export the new wrappers, or keep them in `api/googlePhotos.ts`. |
| `package.json` | add `google-auth-library` (OAuth2 + PKCE + auto token refresh). Skip `googleapis` — there's no first-party Picker client, so we hit the REST endpoints directly via the auth client's `.request()`. |
| `docs/FEATURES.md` | new feature row + the 7 API endpoints (required by repo rules). |
| `.gitignore` / data hygiene | `media/google.json` holds a secret — never seed it into `test-fixtures/`. |

### The import primitive already exists

The whole download side collapses into calls we already have. For each picked item:

```ts
// inside src/routes/api/google-photos/import/+server.ts
const bytes = await downloadPickedItem(item, accessToken); // GET baseUrl=d + Bearer
const safe = assertSafeBasename(item.mediaFile.filename);  // existing guard
fs.writeFileSync(path.join(getGlobalFilesDir(), safe), bytes);
const fileId = await registerBlob(safe, bytes.length);     // existing — mints id + manifest entry
```

`registerBlob()` (`classRepo.ts`) → `mintFileId()` (`manifest.ts`) is exactly what
the upload endpoint already does. HEIC from Google would need the same
`heic-convert` step the upload route uses — worth factoring that into a shared
helper so `/upload` and `/import` don't duplicate it. Because the target is "All
Files (unclassified)," we **stop here** — no `addMembers()` call; `classes[]`
stays empty and the user classifies later like any upload.

### Where secrets live

New `media/google.json` (written `0600`, never committed, never in fixtures):

```jsonc
{
  "clientId": "xxxx.apps.googleusercontent.com",
  "clientSecret": "...",        // for a Desktop client this is not truly secret, but still 0600
  "refreshToken": "...",        // present once connected
  "tokenObtainedAt": "2026-06-22T..."  // to warn before the 7-day Testing-mode expiry
}
```

This mirrors the existing `media/settings.json` pattern (atomic JSON write via
`json.ts`, resolved through `paths.ts`). Client secret can alternatively be read
from a `GOOGLE_CLIENT_SECRET` env var for users who prefer not to put it on disk.

---

## 3. Effort estimate

| Chunk | Rough size |
|-------|-----------|
| OAuth loopback + token storage (`googlePhotos.ts`, `googleConfig.ts`, auth routes) | M |
| Session create/poll/list/download + cleanup | M |
| Import route wiring to `registerBlob` (+ shared HEIC helper) | S |
| `GooglePhotosDialog.svelte` (wizard → connect → pick → progress) | M–L |
| Files page button + reload glue | S |
| Docs (`FEATURES.md`) + tests for the import primitive | S |

No DB, no schema migration, no fixture change. The dialog is the largest single
piece because of the multi-state wizard. Everything server-side is additive.

---

## 4. Resolved decisions (research 2026-06-29)

All four pre-build open questions are closed. Sources are Google's official docs
(OAuth native-app, OAuth2 expiration, restricted-scopes list, sensitive-scope
verification, Picker media-items guides).

- **CASA / scope tier — RESOLVED: sensitive, not restricted → no CASA, ever.**
  `photospicker.mediaitems.readonly` is **absent** from Google's published
  restricted-scopes list (Gmail / Drive / Photos *Ambient* only); CASA applies
  only to restricted scopes. And **BYO-credentials + Testing publishing status**
  sidesteps even the lighter sensitive-scope brand review (Google's explicit
  "Development/Testing" + "Personal use" exemptions; up to 100 test users click
  through the unverified-app screen).
- **Loopback port — RESOLVED: build as designed.** Loopback `127.0.0.1` + PKCE
  with a **dynamic ephemeral port and no port pre-registration** is Google's
  *recommended* Desktop-client pattern (the OOB deprecation doesn't touch
  loopback for Desktop clients). Add a small `findFreePort()` in
  `src/lib/server/` (the CLI's `bin/media-manager.js` copy isn't reusable — it's
  a separate process); an adapter-node route handler can open its own
  `http`/`net` listener. Bind on `127.0.0.1` (IPv4) explicitly and validate a
  strict `state`.
- **Token refresh UX — RESOLVED.** The 7-day refresh-token expiry is real in
  **Testing** for this scope (the name/email-only exemption doesn't apply).
  **Recommended setup:** the user flips their consent screen to **"In
  production"** (no verification submission) for long-lived tokens — they accept
  the unverified-app warning once at consent. **Persist and reuse a single
  refresh token** (100-tokens-per-client cap; 6-month idle expiry). Surface
  "connected · expires in N days" from `tokenObtainedAt` (model the dialog on
  `MetadataButton.svelte`; client wrapper shaped like `apiGetMissingFiles`).
- **Partial import failures — RESOLVED.** Per-item try/catch; `/import` returns
  `{ imported, failed, fileIds, failures[] }` (mirrors the `/api/files/missing`
  summary shape) so one bad/expired `baseUrl` can't abort the batch.
```
