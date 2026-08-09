-- ─────────────────────────────────────────────────────────────────────────────
-- 0005 · Add synced tables to the supabase_realtime publication
--
-- Enables Postgres `postgres_changes` on every synced table so a second device
-- gets a "something changed, go pull" nudge the instant another device (or another
-- session of the same account) writes a row — instead of waiting out the client's
-- 2-minute pull poll. The client subscribes schema-wide and IGNORES the payload;
-- the event is purely a signal to run a pull round, which is itself RLS-filtered.
--
-- RLS still governs delivery: realtime authorizes each row against the subscriber's
-- own JWT (the same `user_id = auth.uid()` policies as PostgREST), so a device only
-- ever receives events for its own rows. Because we never read the payload we need
-- neither `REPLICA IDENTITY FULL` (default primary-key identity is enough for
-- INSERT/UPDATE) nor any DELETE old-row data — normal deletes are soft (UPDATE
-- deleted_at) anyway.
--
-- Idempotent: guards each ADD on pg_publication_tables so a re-run (or a table
-- already published) is a no-op, and creates the managed publication if a bare
-- project somehow lacks it.
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
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;

  foreach t in array synced_tables loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
