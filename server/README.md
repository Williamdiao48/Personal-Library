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
    config.toml                        -- created by `supabase init` (see below)
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

## What's here vs. coming

- **Now (Phase 1):** these migrations + auth. Empty tables; nothing syncs yet.
- **Phase 2:** R2 blob sync (files) — independent of this schema.
- **Phase 3:** the client-side sync engine fills these tables (LWW on
  `updated_at`, tombstones via `deleted_at`).
- **Phase 4+:** a Node API (only for server-trusted work — processing containers,
  social brokering). Still nothing to run in `server/` until then.
