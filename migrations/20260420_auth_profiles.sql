-- =============================================================================
-- Phase A: migrate app_users to Supabase-Auth-linked profile table with the
-- GUEST / OPERATOR / ADMIN role model. Idempotent.
--
-- Legacy role mapping:
--   client_admin      -> ADMIN
--   treycor_operator  -> OPERATOR
--   viewer            -> GUEST
--
-- Safe to re-run. Runs entirely inside one transaction — paste into Supabase
-- SQL editor and click Run.
--
-- NOTE on role column type: we use `text` + CHECK constraint instead of a
-- Postgres enum. Enums can't be mutated safely in the same transaction where
-- their new values are used, which makes Supabase-editor single-paste runs
-- painful. Text + CHECK is equivalent at the app layer and trivial to extend.
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Profile columns (idempotent additions)
-- ---------------------------------------------------------------------------
alter table public.app_users
  add column if not exists email         text,
  add column if not exists full_name     text,
  add column if not exists phone         text,
  add column if not exists organization  text,
  add column if not exists avatar_url    text,
  add column if not exists is_active     boolean not null default true,
  add column if not exists last_login_at timestamptz,
  add column if not exists created_by    uuid references auth.users(id) on delete set null,
  add column if not exists created_at    timestamptz not null default now(),
  add column if not exists updated_at    timestamptz not null default now();

-- Backfill full_name from the legacy `name` column if present.
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'app_users' and column_name = 'name'
  ) then
    update public.app_users
       set full_name = coalesce(full_name, name)
     where full_name is null;
  end if;
end$$;

-- ---------------------------------------------------------------------------
-- 2. Role column: ensure type = text, migrate legacy values, add CHECK.
--    Handles three possible current states:
--      a) role column doesn't exist     → create it as text default 'GUEST'
--      b) role column is an enum type   → drop its default, convert to text
--      c) role column is already text   → just migrate values
-- ---------------------------------------------------------------------------
do $$
declare
  col_type text;
begin
  select data_type into col_type
    from information_schema.columns
   where table_schema = 'public' and table_name = 'app_users' and column_name = 'role';

  if col_type is null then
    -- Case (a): no column yet.
    alter table public.app_users add column role text not null default 'GUEST';

  elsif col_type = 'USER-DEFINED' then
    -- Case (b): old enum column. Drop default, cast to text, then drop enum type.
    alter table public.app_users alter column role drop default;
    alter table public.app_users alter column role type text using role::text;
    alter table public.app_users alter column role set default 'GUEST';
  end if;

  -- Migrate legacy role values in every case.
  update public.app_users
     set role = case role
       when 'client_admin'     then 'ADMIN'
       when 'treycor_operator' then 'OPERATOR'
       when 'viewer'           then 'GUEST'
       when 'admin'            then 'ADMIN'
       when 'operator'         then 'OPERATOR'
       when 'guest'            then 'GUEST'
       else coalesce(nullif(role, ''), 'GUEST')
     end
   where role is null
      or role not in ('GUEST', 'OPERATOR', 'ADMIN');

  -- Ensure the column is non-null with a sensible default.
  alter table public.app_users alter column role set not null;
  alter table public.app_users alter column role set default 'GUEST';
end$$;

-- Drop any previously-created user_role enum type — it's no longer referenced.
-- If dependent objects exist the drop is skipped via exception handling.
do $$
begin
  if exists (select 1 from pg_type where typname = 'user_role') then
    begin
      drop type public.user_role;
    exception when dependent_objects_still_exist then
      raise notice 'Keeping legacy user_role enum — still referenced by other objects.';
    end;
  end if;
end$$;

-- Install the CHECK constraint (drop+recreate so it always matches canonical set).
alter table public.app_users drop constraint if exists app_users_role_check;
alter table public.app_users
  add constraint app_users_role_check
  check (role in ('GUEST', 'OPERATOR', 'ADMIN'));

-- ---------------------------------------------------------------------------
-- 3. updated_at auto-refresh trigger
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_app_users_updated_at on public.app_users;
create trigger trg_app_users_updated_at
  before update on public.app_users
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Auto-create profile row when auth.users row is created.
--    Reads full_name / phone / organization / role from raw_user_meta_data
--    so the backend can pass them via supabase.auth.signUp({ options: { data } }).
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  meta_role text;
  final_role text;
begin
  meta_role := new.raw_user_meta_data ->> 'role';
  final_role := case
    when meta_role in ('GUEST', 'OPERATOR', 'ADMIN') then meta_role
    else 'GUEST'
  end;

  insert into public.app_users (
    id, email, full_name, phone, organization, role, is_active
  )
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.email),
    new.raw_user_meta_data ->> 'phone',
    new.raw_user_meta_data ->> 'organization',
    final_role,
    true
  )
  on conflict (id) do update set
    email        = excluded.email,
    full_name    = coalesce(public.app_users.full_name,    excluded.full_name),
    phone        = coalesce(public.app_users.phone,        excluded.phone),
    organization = coalesce(public.app_users.organization, excluded.organization);
  return new;
end;
$$;

drop trigger if exists trg_on_auth_user_created on auth.users;
create trigger trg_on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- 5. FK app_users.id -> auth.users.id (add only if no orphan rows)
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
     where table_schema   = 'public'
       and table_name     = 'app_users'
       and constraint_name = 'app_users_id_fkey_auth'
  ) then
    begin
      alter table public.app_users
        add constraint app_users_id_fkey_auth
        foreign key (id) references auth.users(id) on delete cascade;
    exception when foreign_key_violation then
      raise notice 'Skipping FK: orphan app_users rows exist — clean them up manually before re-running.';
    end;
  end if;
end$$;

-- ---------------------------------------------------------------------------
-- 6. Indexes
-- ---------------------------------------------------------------------------
create index if not exists idx_app_users_role      on public.app_users(role);
create index if not exists idx_app_users_email     on public.app_users(email);
create index if not exists idx_app_users_is_active on public.app_users(is_active);

-- ---------------------------------------------------------------------------
-- 7. Baseline RLS
--    service_role always bypasses; authenticated users can read their own row;
--    ADMINs can read any row. Writes go through the backend (service_role),
--    so non-admin update policy is intentionally narrow.
-- ---------------------------------------------------------------------------
alter table public.app_users enable row level security;

drop policy if exists "app_users_select_own_or_admin" on public.app_users;
create policy "app_users_select_own_or_admin" on public.app_users
  for select
  using (
    auth.uid() = id
    or exists (
      select 1 from public.app_users p
       where p.id = auth.uid() and p.role = 'ADMIN'
    )
  );

drop policy if exists "app_users_update_own_limited" on public.app_users;
create policy "app_users_update_own_limited" on public.app_users
  for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

commit;
