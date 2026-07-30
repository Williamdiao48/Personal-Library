-- ─────────────────────────────────────────────────────────────────────────────
-- 0003 · items — R2 object keys + the (portable) content paths, for Phase 3 sync.
--
-- The Phase-1 core schema (0001) predates the Phase-2 blob model, so its `items`
-- table lacks four columns a second device needs to actually RESOLVE a book:
--   • blob_hash  — sha256 of the item's PACKED content archive (the R2 content key)
--   • cover_hash — sha256 of the cover bytes (the R2 cover key)
--   • file_path  — the content-dir-RELATIVE, id-based path the reader opens; it
--     names the archived blob entries, so it is portable across devices (NOT a
--     device-absolute path). Pull-on-open looks the item up by file_path, fetches
--     blob_hash from R2, and unpacks to exactly these names. Also satisfies the
--     local `items.file_path NOT NULL` when a pulled row is inserted.
--   • cover_path — the relative cover path (nullable), same portability.
-- 0001 deliberately dropped file_path/cover_path as "device-local"; that was too
-- strong — the app's paths are relative + id-based, hence portable, and are the
-- reader's entry point. blob/cover are content-addressed (same bytes → same key).
--
-- All nullable server-side (a local-only, never-backed-up item has no blob_hash).
-- The set_updated_at trigger + RLS already cover items (0001).
-- ─────────────────────────────────────────────────────────────────────────────

alter table items add column if not exists blob_hash text;
alter table items add column if not exists cover_hash text;
alter table items add column if not exists file_path text;
alter table items add column if not exists cover_path text;
