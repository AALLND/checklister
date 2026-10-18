-- Checklister database setup. Run in the Supabase SQL editor; safe to re-run.
--
-- The app stores each user's lists as ONE jsonb row in `checklists`:
--   • It reads the newest row for the user (order by updated_at desc limit 1).
--   • It inserts the row on first save, and afterwards updates it only where
--     `updated_at` still equals the version it last saw (optimistic locking),
--     so two devices can't silently overwrite each other.
--
-- Reconstructed from what app.js expects. Compare it with your live schema
-- (Table editor → checklists, Authentication → Policies) before running.

create table if not exists public.checklists (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  data       jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

-- An old app version inserted a new row on every save. Keep only the newest
-- row per user — the one the app reads anyway.
delete from public.checklists c
using public.checklists newer
where c.user_id = newer.user_id
  and (c.updated_at, c.id) < (newer.updated_at, newer.id);

-- One row per user.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'checklists_user_id_key') then
    alter table public.checklists add constraint checklists_user_id_key unique (user_id);
  end if;
end $$;

-- Row Level Security: each user can only see and change their own row.
-- The publishable key in app.js is public; these policies are the real lock.
alter table public.checklists enable row level security;

drop policy if exists "checklists_select_own" on public.checklists;
create policy "checklists_select_own" on public.checklists
  for select using (auth.uid() = user_id);

drop policy if exists "checklists_insert_own" on public.checklists;
create policy "checklists_insert_own" on public.checklists
  for insert with check (auth.uid() = user_id);

drop policy if exists "checklists_update_own" on public.checklists;
create policy "checklists_update_own" on public.checklists
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "checklists_delete_own" on public.checklists;
create policy "checklists_delete_own" on public.checklists
  for delete using (auth.uid() = user_id);
