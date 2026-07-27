-- ─────────────────────────────────────────────────────────────────────────────
-- 0002 · profiles + signup trigger
--
-- One row per auth.users id: the app's own identity record (display name, avatar)
-- and the anchor for future social features (friendships / shares are Phase 5).
-- Auto-created on signup by a trigger, the standard Supabase pattern.
--
-- RLS for Phase 1 is SELF-ONLY (a user reads/writes only their own profile).
-- Phase 5 widens SELECT to friends/public when the social graph lands.
-- ─────────────────────────────────────────────────────────────────────────────

create table profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url   text,
  created_at   bigint not null default (extract(epoch from clock_timestamp()) * 1000)::bigint
);

alter table profiles enable row level security;

-- Self-only for Phase 1. (Note: keyed on `id`, not `user_id` — the profile's PK
-- IS the user id.) Phase 5 replaces the SELECT policy to allow friends/public.
create policy profiles_sel_self on profiles for select using (id = auth.uid());
create policy profiles_ins_self on profiles for insert with check (id = auth.uid());
create policy profiles_upd_self on profiles for update using (id = auth.uid()) with check (id = auth.uid());

-- Auto-create the profile row when a new auth user signs up. SECURITY DEFINER so
-- it runs as the function owner and can insert past RLS (the new user has no JWT
-- context yet at signup time). Pinned search_path is the standard hardening so a
-- malicious search_path can't hijack the definer-privileged insert.
create or replace function handle_new_user() returns trigger as $$
begin
  insert into public.profiles (id) values (new.id);
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
