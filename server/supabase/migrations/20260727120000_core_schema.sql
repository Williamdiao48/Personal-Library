-- ─────────────────────────────────────────────────────────────────────────────
-- 0001 · Core library mirror schema + RLS
--
-- The Postgres MIRROR of the local SQLite library (electron/main/db). This is a
-- TRANSLATION, not a copy (see docs/internal/planning/cloud/supabase-infra.md):
--   • every synced table gains  user_id / updated_at / deleted_at
--   • ids stay the app's own TEXT ids (1:1 with local SQLite; NOT pg `uuid`,
--     because seeded rows like annotation_themes presets aren't UUIDs). Only
--     user_id is `uuid` — it must reference auth.users(id).
--   • timestamps are `bigint` unix-ms (1:1 with the local INTEGER columns)
--   • per-user uniqueness: local global-UNIQUE(name) → UNIQUE(user_id, name)
--   • device-local columns are DROPPED: items.file_path, items.cover_path
--     (the row references bytes by content_hash; files live in R2, Phase 2)
--   • NO FTS5 — search stays local, rebuilt on each device (D3)
--
-- RLS: every table is owner-only. The security model = `user_id = auth.uid()`,
-- validated by Phase 0 Spike 2. RLS-on-with-no-policy = deny-by-default, so the
-- policies below are mandatory.
--
-- This migration only CREATES the (empty) cloud schema. No rows sync yet — the
-- sync engine is Phase 3 (docs/internal/planning/cloud/phase-3-sync-design.md).
-- ─────────────────────────────────────────────────────────────────────────────

-- Server-stamped LWW clock. Every insert/update overwrites updated_at with the
-- server's wall clock (unix-ms), so the clock is trusted + monotonic regardless
-- of a device's local time (Phase 3 Decision 7 / risk #4). deleted_at is data,
-- set by the app on soft-delete; the trigger bumps updated_at alongside it.
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  return new;
end;
$$ language plpgsql;

-- ── items ────────────────────────────────────────────────────────────────────
-- file_path + cover_path deliberately OMITTED (device-local; resolved per device
-- from content_hash / covers in Phase 2).
create table items (
  id            text primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  title         text not null,
  author        text,
  source_url    text,
  content_type  text not null check (content_type in ('article', 'epub', 'pdf')),
  word_count    integer,
  description   text,
  date_saved    bigint not null,
  date_modified bigint not null,
  derived_from  text references items(id) on delete set null,
  chapter_start integer,
  chapter_end   integer,
  content_hash  text,
  rating        double precision,
  review        text,
  updated_at    bigint not null,
  deleted_at    bigint
);

-- ── progress (1:1 with items) ────────────────────────────────────────────────
create table progress (
  item_id             text primary key references items(id) on delete cascade,
  user_id             uuid not null references auth.users(id) on delete cascade,
  scroll_position     double precision default 0,
  last_read_at        bigint,
  scroll_chapter      integer,
  scroll_y            double precision default 0,
  status              text check (status is null or status in
                        ('unread', 'reading', 'finished', 'on-hold', 'dropped')),
  max_scroll_position double precision,
  updated_at          bigint not null,
  deleted_at          bigint
);

-- ── tags ─────────────────────────────────────────────────────────────────────
-- local `name UNIQUE` → per-user unique (two users may both have "sci-fi").
create table tags (
  id         text primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  name       text not null,
  color      text not null default '#6b7280',
  updated_at bigint not null,
  deleted_at bigint,
  unique (user_id, name)
);

-- ── item_tags (join) ─────────────────────────────────────────────────────────
create table item_tags (
  user_id    uuid not null references auth.users(id) on delete cascade,
  item_id    text not null references items(id) on delete cascade,
  tag_id     text not null references tags(id) on delete cascade,
  updated_at bigint not null,
  deleted_at bigint,
  primary key (user_id, item_id, tag_id)
);

-- ── collections ──────────────────────────────────────────────────────────────
create table collections (
  id           text primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  name         text not null,
  date_created bigint not null,
  updated_at   bigint not null,
  deleted_at   bigint,
  unique (user_id, name)
);

-- ── collection_items (join, ordered) ─────────────────────────────────────────
create table collection_items (
  user_id       uuid not null references auth.users(id) on delete cascade,
  collection_id text not null references collections(id) on delete cascade,
  item_id       text not null references items(id) on delete cascade,
  sort_order    integer,
  updated_at    bigint not null,
  deleted_at    bigint,
  primary key (user_id, collection_id, item_id)
);

-- ── reading_sessions (append-only events; no LWW conflict class) ──────────────
create table reading_sessions (
  id         text primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  item_id    text not null references items(id) on delete cascade,
  started_at bigint not null,
  ended_at   bigint not null,
  duration   bigint not null,
  updated_at bigint not null,
  deleted_at bigint
);

-- ── annotations (highlights / notes / bookmarks) ─────────────────────────────
create table annotations (
  id             text primary key,
  user_id        uuid not null references auth.users(id) on delete cascade,
  item_id        text not null references items(id) on delete cascade,
  type           text not null check (type in ('bookmark', 'highlight', 'note')),
  chapter_index  integer,
  position       double precision not null default 0,
  selected_text  text,
  context_before text,
  context_after  text,
  note_text      text,
  created_at     bigint not null,
  sort_order     integer,
  color          text,
  rects          text,   -- JSON array of [x,y,w,h] (PDF highlight geometry)
  book_fraction  double precision,
  updated_at     bigint not null,
  deleted_at     bigint
);

-- ── goals + goal_items ───────────────────────────────────────────────────────
create table goals (
  id             text primary key,
  user_id        uuid not null references auth.users(id) on delete cascade,
  type           text not null,
  title          text not null,
  period         text,
  target_minutes integer,
  target_count   integer,
  created_at     bigint not null,
  updated_at     bigint not null,
  deleted_at     bigint
);

create table goal_items (
  user_id    uuid not null references auth.users(id) on delete cascade,
  goal_id    text not null references goals(id) on delete cascade,
  item_id    text not null references items(id) on delete cascade,
  updated_at bigint not null,
  deleted_at bigint,
  primary key (user_id, goal_id, item_id)
);

-- ── annotation_themes + links (cross-book quote organization) ─────────────────
-- id is TEXT (not uuid) because presets ship with fixed ids ('preset-love', …);
-- those seed identically per device so they converge, not collide, on sync.
create table annotation_themes (
  id         text primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  name       text not null,
  created_at bigint not null,
  updated_at bigint not null,
  deleted_at bigint,
  unique (user_id, name)
);

create table annotation_theme_links (
  user_id       uuid not null references auth.users(id) on delete cascade,
  annotation_id text not null references annotations(id) on delete cascade,
  theme_id      text not null references annotation_themes(id) on delete cascade,
  updated_at    bigint not null,
  deleted_at    bigint,
  primary key (user_id, annotation_id, theme_id)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS + server-clock trigger, applied UNIFORMLY. Every synced table has the
-- identical owner-only shape (user_id = auth.uid()), so a loop states it once and
-- guarantees no table is missed. FK ON DELETE CASCADE only fires on HARD deletes
-- (chiefly account deletion via auth.users) — normal deletes are soft (the app
-- tombstones parent + children via deleted_at; the sync engine propagates those).
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  t text;
  synced_tables text[] := array[
    'items', 'progress', 'tags', 'item_tags', 'collections', 'collection_items',
    'reading_sessions', 'annotations', 'goals', 'goal_items',
    'annotation_themes', 'annotation_theme_links'
  ];
begin
  foreach t in array synced_tables loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I for select using (user_id = auth.uid())', t || '_sel', t);
    execute format('create policy %I on %I for insert with check (user_id = auth.uid())', t || '_ins', t);
    execute format('create policy %I on %I for update using (user_id = auth.uid()) with check (user_id = auth.uid())', t || '_upd', t);
    execute format('create policy %I on %I for delete using (user_id = auth.uid())', t || '_del', t);
    execute format('create trigger %I before insert or update on %I for each row execute function set_updated_at()', t || '_set_updated', t);
    -- Serves the Phase 3 pull query: WHERE user_id = auth.uid() AND updated_at > cursor.
    execute format('create index %I on %I (user_id, updated_at)', 'idx_' || t || '_user_updated', t);
  end loop;
end $$;
