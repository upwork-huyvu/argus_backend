-- =============================================================================
-- Phase A follow-up — reintroduce username as a first-class field.
--
-- - Normalizes existing usernames to lowercase.
-- - Adds a case-insensitive unique index on app_users.username
--   (NULLs are allowed so existing rows without usernames don't block the add).
-- - Updates handle_new_auth_user() to copy username from
--   raw_user_meta_data -> 'username' on signup.
--
-- Idempotent — safe to re-run.
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Normalize existing usernames to lowercase.
-- ---------------------------------------------------------------------------
update public.app_users
   set username = lower(username)
 where username is not null
   and username <> lower(username);

-- ---------------------------------------------------------------------------
-- 2. Case-insensitive unique index. Using lower(username) as the key so the
--    constraint works even if older rows somehow have mixed case.
-- ---------------------------------------------------------------------------
create unique index if not exists uq_app_users_username_ci
  on public.app_users (lower(username))
  where username is not null;

-- ---------------------------------------------------------------------------
-- 3. Trigger: pull username from signup metadata, lowercase it.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  meta_role     text;
  final_role    text;
  meta_username text;
begin
  meta_role := new.raw_user_meta_data ->> 'role';
  final_role := case
    when meta_role in ('GUEST', 'OPERATOR', 'ADMIN') then meta_role
    else 'GUEST'
  end;

  meta_username := lower(nullif(new.raw_user_meta_data ->> 'username', ''));

  insert into public.app_users (
    id, email, full_name, username, phone, organization, role, is_active
  )
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.email),
    meta_username,
    new.raw_user_meta_data ->> 'phone',
    new.raw_user_meta_data ->> 'organization',
    final_role,
    true
  )
  on conflict (id) do update set
    email        = excluded.email,
    full_name    = coalesce(public.app_users.full_name,    excluded.full_name),
    username     = coalesce(public.app_users.username,     excluded.username),
    phone        = coalesce(public.app_users.phone,        excluded.phone),
    organization = coalesce(public.app_users.organization, excluded.organization);
  return new;
end;
$$;

-- Trigger stays the same; function replacement above is enough.
drop trigger if exists trg_on_auth_user_created on auth.users;
create trigger trg_on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

commit;
