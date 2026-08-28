-- ─────────────────────────────────────────────────────────────────────────────
-- 0007 · Schedule reconcile-blobs (H2b follow-up / account-lifecycle L3)
--
-- Turns the reconcile-blobs janitor from "deployed but never runs" into a real
-- backstop, WITHOUT ever deleting unattended. Two pieces:
--
--   1. reconcile_runs — a durable, service-role-only AUDIT LOG. The Edge Function
--      appends one row per invocation (see functions/reconcile-blobs, `recordRun`).
--      It answers both questions a monthly janitor raises: "did it run?" (a row each
--      month = alive) and "did it find anything?" (orphan_count > 0 = go arm it).
--      Chosen over an only-on-findings table so a silent/dead cron is distinguishable
--      from a genuinely clean sweep.
--
--   2. A MONTHLY DRY-RUN cron (pg_cron + pg_net). It POSTs the function with a bare
--      body — a dry-run that only REPORTS (deletion needs {"apply":true}, which stays
--      a deliberate manual curl). This is the "separate detection from deletion" split:
--      detection is passive/scheduled; deletion is a human action after eyeballing the
--      findings. Monthly, not weekly/nightly: orphans are vanishingly rare here and the
--      function's own 30-day age-gate means nothing is even a delete candidate until it
--      is a month old — sub-monthly polling would just churn.
--
-- SECRETS ARE NOT INLINED. The function URL and RECONCILE_SECRET are read at fire
-- time from Supabase Vault (vault.decrypted_secrets), so this migration carries no
-- secret and is safe to commit. The two Vault secrets are a one-time manual setup
-- (see server/README.md → "Scheduling"); until they exist the cron simply errors
-- (visible in cron.job_run_details) rather than leaking anything.
--
-- Idempotent: create-if-not-exists throughout, and cron.schedule() upserts by job
-- name, so a re-run (or a schedule tweak in a later migration) is safe.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── reconcile_runs: durable audit log (service_role only) ────────────────────
create table if not exists reconcile_runs (
  id             bigint generated always as identity primary key,
  ran_at         timestamptz not null default now(),
  dry_run        boolean     not null,
  scanned        integer     not null default 0,
  kept_wanted    integer     not null default 0,
  skipped_recent integer     not null default 0,
  orphan_count   integer     not null default 0,
  deleted_count  integer     not null default 0,
  min_age_ms     bigint      not null,
  -- The classified orphan keys for this run (empty on a clean sweep). Small: orphans
  -- are rare, and a run that finds many is itself the signal to go look.
  orphans        jsonb       not null default '[]'::jsonb
);

create index if not exists reconcile_runs_ran_at_idx on reconcile_runs (ran_at desc);

-- No user_id: this is a server-global operational log, not per-user data. RLS on with
-- NO policy = deny-by-default for anon/authenticated; only service_role (which bypasses
-- RLS, and is the sole writer/reader — the Edge Function) can touch it.
alter table reconcile_runs enable row level security;
revoke all on reconcile_runs from anon, authenticated;

-- ── scheduling extensions ────────────────────────────────────────────────────
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ── monthly detection sweep (dry-run only) ───────────────────────────────────
-- 03:00 UTC on the 1st of every month. Bare body ⇒ dry-run: it reports + self-logs to
-- reconcile_runs but deletes nothing. Deletion stays a manual {"apply":true} curl.
select cron.schedule(
  'reconcile-blobs-monthly',
  '0 3 1 * *',
  $cron$
  select net.http_post(
    url := (
      select decrypted_secret from vault.decrypted_secrets where name = 'project_url'
    ) || '/functions/v1/reconcile-blobs',
    headers := jsonb_build_object(
      'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'reconcile_secret'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $cron$
);
