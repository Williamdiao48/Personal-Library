-- ─────────────────────────────────────────────────────────────────────────────
-- Fix: user-scope the annotation_themes primary key to (user_id, id).
--
-- BUG. annotation_themes is the one synced table whose `id` is NOT globally
-- unique: presets ship with FIXED ids ('preset-love', 'preset-identity', …) that
-- every device seeds identically (electron/main/db/index.ts migration 28). The
-- core-schema comment assumed those "converge, not collide" — true across ONE
-- user's devices (same user_id, same row), FALSE across TWO users. Under the old
-- global `id` PK the first user to sync claims `id='preset-love'` for the whole
-- table; a second user's upsert then lands on the UPDATE branch against the first
-- user's row and the RLS USING (user_id = auth.uid()) check denies it:
--   push annotation_themes failed: new row violates row-level security policy
-- Only reachable with >1 account on the project (signup is closed → normally
-- single-user), which is why it stayed latent; surfaced during L2 (account
-- deletion) two-account testing, 2026-08-28.
--
-- FIX. Scope the PK to (user_id, id) so each user owns their own preset rows and a
-- user's upsert only ever conflicts with their own row (RLS passes). The join
-- table annotation_theme_links already has user_id in its PK, so its FK to themes
-- widens to the composite (user_id, theme_id) → (user_id, id) cleanly.
--
-- Client counterpart: cloudRepo widens the upsert conflict target for this table
-- via the spec's `userScopedId` flag (conflictTargetFor) so onConflict names the
-- real (user_id, id) constraint. Local SQLite is single-user (id stays unique
-- locally) and needs no change.
--
-- Safe on existing data: within any one user, ids are already distinct, so
-- (user_id, id) has no duplicate pairs, and every existing link references a
-- same-user theme.
-- ─────────────────────────────────────────────────────────────────────────────

-- The FK references the PK we are about to drop, so it must go first.
alter table annotation_theme_links
  drop constraint annotation_theme_links_theme_id_fkey;

alter table annotation_themes
  drop constraint annotation_themes_pkey;

alter table annotation_themes
  add primary key (user_id, id);

alter table annotation_theme_links
  add constraint annotation_theme_links_theme_fkey
  foreign key (user_id, theme_id)
  references annotation_themes (user_id, id) on delete cascade;
