-- ─────────────────────────────────────────────────────────────────────────────
-- 0006 · progress.max_scroll_position — server-side grow-only max register.
--
-- max_scroll_position is the "furthest point ever read" high-water mark. Locally it
-- is monotonic (electron/main/ipc/library.ts upserts it via
-- MAX(COALESCE(max_scroll_position,0), excluded.scroll_position)), and THREE
-- subsystems rely on that invariant: reading progress, the recommender's depth/status
-- signal (recommender/signals.ts), and stats' words-read/WPM (ipc/stats.ts).
--
-- Whole-row LWW sync (Phase 3) breaks the invariant at the sync boundary: a peer's
-- newer-but-shallower write wins the row and drags the high-water mark BACKWARD.
-- The client reconciler now folds this column as a grow-only max register
-- (max(local, incoming)) on pull/readback (sync/reconcile.ts, spec `merge`), and this
-- trigger enforces the same on the AUTHORITATIVE copy so it is order-independent —
-- even the push-before-pull ordering can't lower it (a device that pushes a shallower
-- row first has its value clamped up to the stored one, then reads it back).
--
-- GREATEST ignores NULLs (result is NULL only if every arg is NULL), so a "never
-- tracked" row stays NULL and a write that omits the column can't wipe the stored
-- mark. INSERT has no OLD → NEW passes through untouched (a genuinely new row).
--
-- Additive + idempotent (create-or-replace / drop-if-exists). Apply to prod BEFORE
-- shipping the client that relies on it; independent of the generic set_updated_at
-- trigger (different column) — trigger fire-order is irrelevant.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function progress_greatest_max() returns trigger as $$
begin
  new.max_scroll_position := greatest(new.max_scroll_position, old.max_scroll_position);
  return new;
end;
$$ language plpgsql;

drop trigger if exists progress_max_register on progress;
create trigger progress_max_register
  before update on progress
  for each row execute function progress_greatest_max();
