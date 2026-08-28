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

The container itself needs none. The **Edge Function** side (`process-extract`,
below) needs the Cloud Run service URL + the service-account key to mint invoker
ID tokens, set via `supabase secrets set` alongside the existing R2 secrets. GCP
project id + the service-account live in GCP, not the repo.

## Edge Function: `process-extract` (Phase 4 orchestrator)

`functions/process-extract/` is the server half of cloud extraction — the piece
that lets the credential-light container stay credential-light. Flow:

```
client (main)                       process-extract (Edge Fn)          Cloud Run /extract
  │ upload source to R2 (Phase-2 uploader, dedupe by hash)
  │ POST {kind:'epub', content_hash} + JWT ─────────►
  │                          verify JWT → presign GET(source)
  │                          → mint Google ID token (SA) → POST ─────────►
  │                                                          GET source, extract,
  │                          ◄──────── {title,author,coverBase64,…} ──────
  │ ◄──── result JSON ───
  │ hash+store cover (same Phase-2 path), write item row + FTS
```

Same trust boundary as `blob-url`: the `user_id` in the presigned source key
comes from the **verified token**, never the body. The container is reached with
a **Google-signed ID token** (service-account, `target_audience` = the Cloud Run
URL) because the service is deployed private (`--no-allow-unauthenticated`).

### Contract

`POST /functions/v1/process-extract` — `Authorization: Bearer <supabase-jwt>`.
```jsonc
{ "kind": "epub", "content_hash": "<sha256 hex of the R2 source blob>" }
```
Success (`200`) passes the container's result straight through (see the extract
contract above). Errors: `401` (bad/absent JWT), `400` (bad kind/hash/JSON),
`502` (Cloud Run failed), `500` (server misconfigured — R2 or Cloud Run env).

### Transient source cleanup

The raw file the client uploads for extraction is a **throwaway extraction input** — its
key is the raw-bytes hash, which is _not_ the Phase-2 backup key (that's the sha256 of the
packed archive), so it's never reused. After `process-extract` returns, the client
best-effort **`DELETE`s** it (a presigned `delete` op on `blob-url`) — the primary reaper.

Since **H2a** the source lives under a dedicated **top-level `scratch/<uid>/<hash>`** prefix
(not `users/<uid>/content/…`), so a single **R2 lifecycle rule on `scratch/`** (delete after
1 day) is the backstop for the rare object left behind when the inline `DELETE` can't run
(crash/offline mid-import) — without ever touching a durable `content/`/`cover/` backup.
Objects **already stranded** under `content/` from pre-H2a crashes are swept up by
`reconcile-blobs` (**H2b**, below).

### Structure & test

Only `index.ts` is Deno glue (env + Supabase client + R2 presign + `Deno.serve`),
untested like `blob-url`. The logic worth testing is cross-runtime (Web Crypto +
fetch only) and **is** covered by the vitest `server` project:
- `handler.ts` — validation, key scoping, orchestration (9 tests, fake deps).
- `googleAuth.ts` — the service-account **JWT-bearer → ID-token** flow (3 tests:
  signs with a generated RSA key against a fake token endpoint, asserts the
  `target_audience` claim + error paths). Isolated `tsc` via the local
  `tsconfig.json` (excludes the Deno `index.ts`).

### Deploy (Chunk 5)

```bash
cd server
supabase secrets set \
  CLOUD_RUN_URL=https://extract-xxxx.run.app \
  GCP_SERVICE_ACCOUNT_KEY="$(cat sa-key.json)"    # invoker SA; never committed
  # (R2_* already set for blob-url; SUPABASE_URL/ANON_KEY auto-injected)
supabase functions deploy process-extract
```
Leave the default `verify_jwt = true` (gateway rejects tokenless calls). Smoke-
test after deploy like `blob-url` — it isn't in the vitest suite end-to-end.

## Edge Function: `reconcile-blobs` (H2b — server-side R2 orphan backstop)

`functions/reconcile-blobs/` is a **privileged janitor** that reaps R2 objects the
client-side reaper structurally can't. The client reaper (`electron/main/cloud/reaper.ts`)
only knows about blobs in some device's local `blob_sync` ledger; two orphan classes
escape it forever:

- **Lost uploader** — a device uploads a blob, then its DB dies (reinstall/wipe). No
  device holds a ledger row for the hash, so a later global purge has nothing to drive
  the `DELETE`.
- **Pre-H2a stranded scratch** — old raw extraction sources left under
  `users/<uid>/content/<sha256(raw)>` (see the H2a note above).

Because Postgres is the globally-authoritative "is this blob wanted?" oracle (every device
pushes `blob_hash`/`cover_hash`/`purged_at`, LWW-merged), a `service_role` sweep can answer
what no single client can: it `LIST`s each user's `users/` prefix, and for every
`content`/`cover` object deletes the ones **no un-purged item references**.

### Safety model (this deletes bytes across all users)

- **Admin-gated, not user-gated:** deploy `--no-verify-jwt` (there's no user context) and
  require a shared **`RECONCILE_SECRET`** bearer (constant-time compare). The service-role
  key is used only inside the function (auto-injected), never client-exposed.
- **Age-gate:** only objects **older than `RECONCILE_MIN_AGE_DAYS` (default 30)** are ever
  candidates — the server has no "I just uploaded this" knowledge, so this makes an
  in-flight/recent upload impossible to false-delete; a real orphan just lingers a few
  extra weeks. (This is why `content/` can't take a blanket lifecycle rule — content is
  addressed, never ages out — and why the age-gate is a per-run classification, not R2's.)
- **Dry-run by default:** a bare call only **reports**; deletion needs `{"apply":true}` in
  the body. `RECONCILE_DRY_RUN=1` is an env kill-switch that forces dry-run regardless.
- Predicate parity with the client reaper: **`purged_at IS NULL`** (a merely-trashed item
  keeps its bytes; only a permanent purge frees them).

### Contract

`POST /functions/v1/reconcile-blobs` — `Authorization: Bearer <RECONCILE_SECRET>`.
```jsonc
{ "apply": true,        // optional; omitted/false ⇒ dry-run (report only)
  "minAgeDays": 30 }    // optional; overrides RECONCILE_MIN_AGE_DAYS for this run
```
Success (`200`) returns a report:
```jsonc
{ "scanned": 42, "keptWanted": 40, "skippedRecent": 1,
  "orphans": ["users/<uid>/content/<hash>", …],   // classified as reclaimable
  "deleted": ["users/<uid>/content/<hash>", …],   // actually removed (empty on a dry-run)
  "dryRun": false, "minAgeMs": 2592000000 }
```
Errors: `401` (bad/absent secret), `400` (invalid JSON body), `500` (misconfigured — R2 /
service-role / secret env unset).

### Structure & test

Same split as `blob-url`/`process-extract`: only `index.ts` is Deno glue (env, R2
`AwsClient` LIST/DELETE + XML parse, the `service_role` Supabase client), untested. The
classification logic — admin gate, key parsing, age-gate, dry-run, per-owner memoization —
is in `handler.ts` and **is** covered by the vitest `server` project (`npm test`, fake
deps). Isolated `tsc` via the local `tsconfig.json` (excludes the Deno `index.ts`).

### Deploy & run

```bash
cd server
supabase secrets set RECONCILE_SECRET="$(openssl rand -hex 32)"
#   optional: RECONCILE_MIN_AGE_DAYS=30   RECONCILE_DRY_RUN=1 (kill-switch)
#   (R2_* already set for blob-url; SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY auto-injected)
supabase functions deploy reconcile-blobs --no-verify-jwt

# Dry-run first — eyeball the report, confirm `orphans` are only genuine leaks:
curl -sS -X POST "$SUPABASE_URL/functions/v1/reconcile-blobs" \
  -H "Authorization: Bearer $RECONCILE_SECRET"
# Then arm deletion:
curl -sS -X POST "$SUPABASE_URL/functions/v1/reconcile-blobs" \
  -H "Authorization: Bearer $RECONCILE_SECRET" \
  -H 'content-type: application/json' -d '{"apply":true}'
```
### Scheduling — monthly dry-run (migration `20260828120000_reconcile_schedule.sql`)

The sweep now runs **automatically once a month** as a **dry-run only** (detection), while
**deletion stays a manual** `{"apply":true}` curl. The migration:

- Creates **`reconcile_runs`** — a service-role-only audit log. The function appends one row
  per invocation (scheduled *or* manual), so `reconcile_runs` answers both "did the monthly
  sweep run?" (a row each month) and "did it find anything?" (`orphan_count > 0` → go arm
  deletion by hand). Check it with:
  ```sql
  select ran_at, dry_run, scanned, orphan_count, deleted_count, orphans
    from reconcile_runs order by ran_at desc limit 12;
  ```
- Schedules a `pg_cron` job (`reconcile-blobs-monthly`, `0 3 1 * *` = 03:00 UTC on the 1st)
  that `pg_net`-POSTs the function with a **bare body** (⇒ dry-run). Monthly, not weekly:
  orphans are vanishingly rare and the 30-day age-gate means nothing is even a delete
  candidate for a month.

**One-time manual setup** (the migration reads these at fire time from **Vault** — they are
never inlined, so the migration carries no secret). In the SQL Editor **once**:
```sql
select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
select vault.create_secret('<the RECONCILE_SECRET value>',       'reconcile_secret');
```
Then apply the migration and (re)deploy the function so audit-logging is live:
```bash
supabase db push
supabase functions deploy reconcile-blobs --no-verify-jwt
```
Verify the schedule, and (after the 1st, or a manual test-fire) the results:
```sql
select jobname, schedule, active from cron.job where jobname = 'reconcile-blobs-monthly';
select * from cron.job_run_details order by start_time desc limit 5;  -- did the cron fire OK?
select * from reconcile_runs order by ran_at desc limit 5;            -- what did it find?
```
If a run ever reports orphans, eyeball them, then arm deletion once by hand with the
`{"apply":true}` curl above.

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
