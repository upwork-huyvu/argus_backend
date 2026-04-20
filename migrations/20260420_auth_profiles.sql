-- =============================================================================
-- Phase A: migrate app_users to Supabase-Auth-linked profile table with the new
-- role enum (GUEST / OPERATOR / ADMIN). Idempotent where possible.
--
-- Legacy role mapping:
--   client_admin      -> ADMIN
--   treycor_operator  -> OPERATOR
--   viewer            -> GUEST
--
-- Run inside Supabase SQL editor (or `supabase db push`) against the `arguss`
-- project. See docs/MIGRATIONS.md for step-by-step.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Role enum
--    Runs OUTSIDE the main transaction because Postgres forbids using an enum
--    value in the same transaction where it was added — and step 3 below
--    casts rows to 'ADMIN'/'OPERATOR'/'GUEST'. The `add value if not exists`
--    calls handle the case where the enum was created previously with
--    different/partial labels (e.g. lowercase or legacy values).
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'user_role') then
    create type public.user_role as enum ('GUEST', 'OPERATOR', 'ADMIN');
  end if;
end$$;

alter type public.user_role add value if not exists 'GUEST';
alter type public.user_role add value if not exists 'OPERATOR';
alter type public.user_role add value if not exists 'ADMIN';

begin;

-- ---------------------------------------------------------------------------
-- 2. New profile columns
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

-- Backfill full_name from the legacy `name` column where null.
update public.app_users
   set full_name = coalesce(full_name, name)
 where full_name is null;

-- ---------------------------------------------------------------------------
-- 3. Role value migration + column type conversion
-- ---------------------------------------------------------------------------
do $$
declare
  col_type text;
begin
  select data_type into col_type
    from information_schema.columns
   where table_schema = 'public'
     and table_name   = 'app_users'
     and column_name  = 'role';

  if col_type in ('text', 'character varying') then
    update public.app_users
       set role = case role
         when 'client_admin'     then 'ADMIN'
         when 'treycor_operator' then 'OPERATOR'
         when 'viewer'           then 'GUEST'
         else coalesce(role, 'GUEST')
       end;

    alter table public.app_users alter column role drop default;
    alter table public.app_users
      alter column role type public.user_role using role::public.user_role;
    alter table public.app_users alter column role set default 'GUEST'::public.user_role;
    alter table public.app_users alter column role set not null;
  end if;
end$$;

-- ---------------------------------------------------------------------------
-- 4. updated_at auto-refresh trigger
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
-- 5. Auto-create profile row when auth.users row is created.
--    Reads full_name/phone/organization/role from raw_user_meta_data so the
--    backend can pass them via supabase.auth.signUp({ options: { data } }).
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.app_users (
    id, email, full_name, phone, organization, role, is_active
  )
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.email),
    new.raw_user_meta_data ->> 'phone',
    new.raw_user_meta_data ->> 'organization',
    coalesce(
      nullif(new.raw_user_meta_data ->> 'role', '')::public.user_role,
      'GUEST'::public.user_role
    ),
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
-- 6. FK app_users.id -> auth.users.id (add only if no orphan rows)
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
-- 7. Indexes
-- ---------------------------------------------------------------------------
create index if not exists idx_app_users_role      on public.app_users(role);
create index if not exists idx_app_users_email     on public.app_users(email);
create index if not exists idx_app_users_is_active on public.app_users(is_active);

-- ---------------------------------------------------------------------------
-- 8. Baseline RLS (permissive: service_role bypasses; authenticated users see
--    their own row; ADMINs see all). Policies are intentionally narrow; tighten
--    in later phases as product needs evolve.
-- ---------------------------------------------------------------------------
alter table public.app_users enable row level security;

drop policy if exists "app_users_select_own_or_admin" on public.app_users;
create policy "app_users_select_own_or_admin" on public.app_users
  for select
  using (
    auth.uid() = id
    or exists (
      select 1 from public.app_users p
       where p.id = auth.uid() and p.role = 'ADMIN'::public.user_role
    )
  );

drop policy if exists "app_users_update_own_limited" on public.app_users;
create policy "app_users_update_own_limited" on public.app_users
  for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

commit;
