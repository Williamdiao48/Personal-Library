# server/ — Cloud backend (Supabase)

The cloud side of the app's opt-in sync/backup/social layer. **Phase 1 = auth +
the Postgres mirror schema.** There is **no running server** here — the app talks
to Supabase directly (client-direct + RLS; the Node API is a later phase). This
dir holds the **database migrations** and (once you init the CLI) the Supabase
project config.

> Full plan: `docs/internal/planning/cloud/phase-1-auth-and-schema.md`
> (internal, not pushed). The strategy: `.../cloud/cloud-strategy-plan.md`.

## Layout

```
server/
  supabase/
    migrations/
      20260727120000_core_schema.sql   -- library mirror tables + RLS
      20260727120100_profiles.sql      -- profiles + signup trigger
    functions/
      blob-url/
        index.ts                       -- Phase 2: mint presigned R2 URLs (Deno)
    config.toml                        -- created by `supabase init` (see below)
  cloud-run/
    extract/                           -- Phase 4: untrusted-file extraction container
      src/
        extractHandler.ts              -- GET source → shared extractor → PUT cover
        server.ts                      -- minimal HTTP entrypoint ($PORT)
        extractHandler.test.ts         -- unit + loopback round-trip (fake R2)
      Dockerfile                       -- built from REPO ROOT context
      package.json / tsconfig.json
  README.md
```

## Secrets — never committed

Per the repo rule, **no env file is tracked** (not even `.env.example`). The
values you need, and where they come from (Supabase dashboard → your project):

| Value | Where | Who uses it | Secret? |
|-------|-------|-------------|---------|
| Project URL | Settings → API | app (client) | no |
| **Publishable** key (`sb_publishable_…`) | Settings → API | app (client) — ships in the bundle | no (RLS is the boundary) |
| **Secret** key (`sb_secret_…`) | Settings → API | server/CI only | **YES** |
| DB connection string | Settings → Database | migrations (CLI) | **YES** |
| Access token | `supabase login` | CLI | **YES** |
| **R2 Secret Access Key** | Cloudflare R2 → API tokens | `blob-url` function only | **YES** |
| R2 Access Key ID / Account ID / Bucket | Cloudflare R2 | `blob-url` function only | no (paired w/ the secret) |

The Secret key + DB URL + access token bypass RLS — keep them in a **gitignored**
local `.env` or your shell env only. Never in the app bundle or the repo.

## Applying the migrations

Two ways. Both target your **dev** Supabase project (stand up a separate **prod**
project before any public release that enables sync).

### Option A — Dashboard SQL Editor (no install needed)
1. Supabase dashboard → **SQL Editor** → **New query**.
2. Paste the contents of `migrations/20260727120000_core_schema.sql`, run it.
3. Repeat for `migrations/20260727120100_profiles.sql` (in order).
4. Verify: **Table Editor** should show `items`, `tags`, …, `profiles`, each with
   the 🔒 "RLS enabled" badge.

### Option B — Supabase CLI (repeatable, preferred once set up)
```bash
# one-time install (macOS)
brew install supabase/tap/supabase

cd server
supabase init                       # generates supabase/config.toml (commit it)
supabase login                      # stores your access token OUTSIDE the repo
supabase link --project-ref <ref>   # <ref> = the id in your project URL
supabase db push                    # applies migrations/*.sql in order
```
`supabase init` creates `config.toml` — **that file is committed** (it's project
config, not a secret). Migration SQL is likewise committed. Only credentials stay
out.

## Verifying RLS (Phase 1 exit gate)

The whole security model is "a signed-in user sees only their own rows." To prove
it against the **real** tables (not just the spike's throwaway table): create two
auth users, insert a row owned by each (service role, via SQL editor), then query
as each user with their JWT and confirm each sees only their own. This mirrors
Phase 0's `spikes/supabase-rls.mjs` — reuse that pattern pointed at, e.g.,
`items`.

## Edge Function: `blob-url` (Phase 2 blob sync)

`functions/blob-url/index.ts` is the **thin server component** of Phase 2. It mints
short-lived **presigned R2 URLs** so the desktop app can upload/download book
bytes to Cloudflare R2 **without ever holding an R2 credential** (Decision 7). R2
has no row-level security, so this function *is* the isolation boundary: it
verifies the caller's Supabase JWT and only ever signs a URL under that verified
user's own prefix.

### Contract

`POST /functions/v1/blob-url` — `Authorization: Bearer <supabase-jwt>` required.

Request body:
```jsonc
{ "op": "put" | "get", "kind": "content" | "cover", "hash": "<sha256 hex>" }
```
Success (`200`):
```jsonc
{ "url": "https://<acct>.r2.cloudflarestorage.com/...", // presigned, ~5 min
  "key": "users/<verified-uid>/content/<hash>",
  "expiresIn": 300 }
```
Errors: `401` (bad/absent JWT), `400` (malformed op/kind/hash), `500` (R2 secrets
not set). The **bytes never pass through the function** — the client does a plain
`PUT`/`GET` to the returned URL, direct to R2.

Key property: the `user_id` in the key comes from the **verified token**, never the
request body — a client cannot obtain a URL outside its own prefix.

### Deploy (code-only until you're ready)

```bash
cd server
# R2 credentials live ONLY as function secrets — never committed, never shipped:
supabase secrets set \
  R2_ACCOUNT_ID=<acct> R2_BUCKET=<bucket> \
  R2_ACCESS_KEY_ID=<key-id> R2_SECRET_ACCESS_KEY=<secret>
supabase functions deploy blob-url
```
`SUPABASE_URL` / `SUPABASE_ANON_KEY` are auto-injected by the platform — don't set
them. Leave the default `verify_jwt = true` (the gateway rejects tokenless calls
before our code even runs; `getUser()` inside then pins the user id) — no
`config.toml` entry is needed for that default.

### Smoke test (no vitest — it's Deno)

This function isn't in the vitest suite. Verify it manually once deployed (sign in
in the app or via `supabase` to get a JWT):
```bash
curl -sS -X POST "$SUPABASE_URL/functions/v1/blob-url" \
  -H "Authorization: Bearer $USER_JWT" -H 'content-type: application/json' \
  -d '{"op":"put","kind":"content","hash":"'"$(printf 0%.0s {1..64})"'"}'
# → { "url": "...", "key": "users/<your-uid>/content/000...", "expiresIn": 300 }
# then: curl -X PUT --data-binary @somefile "<that url>"   should 200.
```
The client side (the uploader that calls this) IS unit-tested in the app, against
a stubbed `fetch` — see Phase 2 chunk 4.

## Cloud Run: `extract` container (Phase 4 processing)

`cloud-run/extract/` runs heavy, **untrusted** file extraction (EPUB now; PDF +
scraped HTML in a later chunk) in a throwaway container instead of on the user's
machine — the security payoff — and off the main process. It wraps the **shared**
`electron/main/capture/extract` module (the exact code the local parse worker
runs), so a cloud result is byte-identical to the local one, guards and all.

> Full design: `docs/internal/planning/cloud/phase-4-cloud-processing.md`
> (internal, not pushed).

### Credential model (same trust boundary as `blob-url`)

The container holds **no long-lived credential**. Per request it receives only a
single presigned R2 **GET** (the source), minted by the `process-extract` Edge
Function (Chunk 3) after it verifies the caller's JWT. Cloud Run ingress is
**internal/authenticated only** — the Edge Function (with a Google-signed ID
token) is the sole caller; the service is never publicly invocable.

The container does **not** upload the cover. Covers are content-addressed by
`sha256(cover bytes)` — a hash only known *after* extraction — so the Edge
Function can't presign the right key up front. Instead the container returns the
(small) cover **inline** as base64; the client hashes and stores it via the same
Phase-2 path it uses for locally-extracted covers. One code path, and the
container stays a pure GET-only worker.

### Contract

`POST /extract` (body ≤ 64 KB — the multi-MB source travels via R2, not here):
```jsonc
{ "kind": "epub", "sourceUrl": "<presigned GET>" }
```
Success (`200`): the canonical result (mirrors `EpubParseResult`, cover inline):
```jsonc
{ "title": "...", "author": "...", "coverBase64": "<base64|null>",
  "coverExt": "png|jpg|gif|webp|null", "plainText": "...", "wordCount": 123 }
```
`GET /health` → `200 {ok:true}`. Errors carry an HTTP status: `400` bad
request/kind, `413` oversized source, `502` R2 fetch failure, `500` else.

### Build & test

```bash
cd server/cloud-run/extract
npm install
npm run typecheck                 # isolated tsc (repo-root typecheck scopes to electron/**)
npm run build                     # esbuild bundle → dist/server.js

# Image build uses the REPO ROOT as context (bundles the shared extractor):
docker build -f server/cloud-run/extract/Dockerfile -t extract .
```
The handler + HTTP plumbing are covered by the repo's vitest `server` project
(`npm test`) — a fake R2 plus a real loopback round-trip, no GCP needed. The
container is deployed and verified against **real** Cloud Run + dev Supabase by
the Phase 4 exit-gate spike (Chunk 5), never in CI.

### Deploy secrets (Chunk 5, never committed)

The container itself needs none. The **Edge Function** side needs the Cloud Run
service URL + a way to mint an invoker ID token (service-account), set via
`supabase secrets set` alongside the existing R2 secrets. GCP project id + the
service-account live in GCP, not the repo.

## What's here vs. coming

- **Now (Phase 1):** these migrations + auth. Empty tables; nothing syncs yet.
- **Phase 2:** R2 blob sync (files) — independent of this schema. The `blob-url`
  Edge Function (above) is the server half; the client outbox/uploader is in the
  desktop app.
- **Phase 3:** the client-side sync engine fills these tables (LWW on
  `updated_at`, tombstones via `deleted_at`).
- **Phase 4:** the `cloud-run/extract` container (above) + a `process-extract`
  Edge Function (Chunk 3) that mints its URLs. Opt-in (`enableCloudProcessing`,
  default off); local extraction stays the default and the offline fallback.
- **Phase 5:** social brokering (independent, unblocked).
