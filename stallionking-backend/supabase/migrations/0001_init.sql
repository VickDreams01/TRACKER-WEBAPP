-- STALLIONKING TRACKER — backend schema
--
-- Design note: the front end (parcel-tracker.html) was originally built
-- against a Firestore-style document API — db.collection('x').doc(id).set(...),
-- .add(...), .collection('x').orderBy('createdAt','desc').limit(n).onSnapshot(cb),
-- etc. Rather than re-model every field of every record into relational
-- columns (which would mean rewriting most of a 2600-line app), each
-- collection below is a table of JSON documents: a stable text id, a jsonb
-- payload holding the exact document shape the app already reads and
-- writes, and real timestamp columns for ordering/indexing. The JS adapter
-- in frontend/supabase-adapter.js speaks the same collection/doc/onSnapshot
-- API on top of these tables, so almost none of the existing app code had
-- to change.
--
-- Run this once against a fresh Supabase project (SQL Editor, or
-- `supabase db push` — see ../../README.md).

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Generic document tables
-- ---------------------------------------------------------------------

create table if not exists public.settings (
  id         text primary key,
  data       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.riders (
  id         text primary key default gen_random_uuid()::text,
  data       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.clients (
  id         text primary key default gen_random_uuid()::text,
  data       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Staff login profiles. Passwords are NOT stored here — real credentials
-- live in Supabase Auth (auth.users), created via the create-staff /
-- set-staff-password edge functions. This table only holds the profile
-- (name, staffId, role, active) that the app already expects, keyed the
-- same way `admins` docs were keyed before.
create table if not exists public.admins (
  id         text primary key default gen_random_uuid()::text,
  data       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.parcels (
  id         text primary key, -- the tracking number itself, e.g. STK-XXXXXX
  data       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.notifications (
  id         text primary key default gen_random_uuid()::text,
  data       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.activity_log (
  id         text primary key default gen_random_uuid()::text,
  data       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.deletion_requests (
  id         text primary key default gen_random_uuid()::text,
  data       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Links a real Supabase Auth user to a staff profile / role. staff_id is
-- the human-facing "Staff ID" (e.g. SK-0001) the login form already asks
-- for; the actual Supabase Auth email is a synthetic
-- "<staffId>@staff.stallionking.internal" address, created server-side by
-- the create-staff edge function so the login form's UX doesn't change.
create table if not exists public.profiles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  staff_id   text unique not null,
  admin_doc_id text not null references public.admins(id) on delete cascade,
  role       text not null default 'staff' check (role in ('staff','admin','superadmin')),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- updated_at bookkeeping
-- ---------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['settings','riders','clients','admins','parcels','notifications','activity_log','deletion_requests']
  loop
    execute format('drop trigger if exists trg_set_updated_at on public.%I;', t);
    execute format('create trigger trg_set_updated_at before update on public.%I for each row execute function public.set_updated_at();', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Indexes used by the app's orderBy('createdAt','desc').limit(n) queries
-- ---------------------------------------------------------------------

create index if not exists idx_parcels_created_at       on public.parcels (created_at desc);
create index if not exists idx_notifications_created_at on public.notifications (created_at desc);
create index if not exists idx_activity_log_created_at  on public.activity_log (created_at desc);
create index if not exists idx_riders_created_at        on public.riders (created_at desc);
create index if not exists idx_clients_created_at       on public.clients (created_at desc);
create index if not exists idx_admins_created_at        on public.admins (created_at desc);
create index if not exists idx_deletion_requests_created_at on public.deletion_requests (created_at desc);

-- ---------------------------------------------------------------------
-- Row Level Security
--
-- Staff pages (Warehouse / Clients / Dispatch / Admin) run under a real
-- Supabase Auth session once a staff member logs in, so full read/write
-- access to the operational tables is granted to any authenticated user.
-- The app's own UI already hides Admin Users / Activity Log from
-- non-superadmins; the *sensitive* superadmin-only actions (creating a
-- staff login, changing a password) are additionally enforced server-side
-- in the create-staff / set-staff-password edge functions, which check the
-- caller's profiles.role with the service role key — RLS alone can't see
-- "is this specific write a password change", so that check lives there.
--
-- Customers are never given a Supabase Auth session. Parcel tracking by
-- tracking number is served by the public `track` edge function (which
-- uses the service role key and returns only the one parcel asked for),
-- not by a direct table read — so `parcels` has no anon SELECT policy.
-- ---------------------------------------------------------------------

alter table public.settings           enable row level security;
alter table public.riders             enable row level security;
alter table public.clients            enable row level security;
alter table public.admins             enable row level security;
alter table public.parcels            enable row level security;
alter table public.notifications      enable row level security;
alter table public.activity_log       enable row level security;
alter table public.deletion_requests  enable row level security;
alter table public.profiles           enable row level security;

-- Ordinary business data: any signed-in staff member (whatever their role —
-- the app's own UI already sorts out which nav sections they can reach) can
-- read and write freely, same trust level the original client-side-only
-- version of this app had.
do $$
declare t text;
begin
  foreach t in array array['settings','riders','clients','parcels','notifications','activity_log','deletion_requests']
  loop
    execute format('drop policy if exists staff_full_access on public.%I;', t);
    execute format(
      'create policy staff_full_access on public.%I for all to authenticated using (true) with check (true);',
      t
    );
  end loop;
end $$;

-- The `admins` table is the one place client-side role gating isn't enough
-- to trust: it's the staff roster itself, so a plain "staff" login writing
-- to it directly (e.g. from devtools) must not be able to grant itself
-- superadmin. Every signed-in staff member may still read it (the Riders
-- roster and a few other panels list colleagues by name), but only a
-- superadmin may insert/update/delete a row — and even superadmins should
-- go through the create-staff / update-staff edge functions for anything
-- touching a password, since those also manage the matching Supabase Auth
-- user and keep profiles.role in sync.
create or replace function public.is_superadmin()
returns boolean language sql stable as $$
  select exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid() and p.role = 'superadmin'
  );
$$;

drop policy if exists admins_read_all_staff on public.admins;
create policy admins_read_all_staff on public.admins
  for select to authenticated
  using (true);

drop policy if exists admins_write_superadmin_only on public.admins;
create policy admins_write_superadmin_only on public.admins
  for all to authenticated
  using (public.is_superadmin())
  with check (public.is_superadmin());

-- A staff member may read their own profile row (used to resolve their
-- name/role/staffId right after signing in, and by is_superadmin() above).
-- Profiles are otherwise only written by the edge functions using the
-- service role key.
drop policy if exists read_own_profile on public.profiles;
create policy read_own_profile on public.profiles
  for select to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- Realtime — the adapter's onSnapshot() is backed by Postgres change
-- notifications, so every table it subscribes to must be in the
-- supabase_realtime publication.
-- ---------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['settings','riders','clients','admins','parcels','notifications','activity_log','deletion_requests']
  loop
    begin
      execute format('alter publication supabase_realtime add table public.%I;', t);
    exception when duplicate_object then
      null; -- already added
    end;
  end loop;
end $$;
