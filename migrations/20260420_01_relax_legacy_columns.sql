-- =============================================================================
-- Phase A follow-up (run AFTER 20260420_auth_profiles.sql).
--
-- Fix: Supabase signUp was failing with a generic
--   "Database error saving new user"
-- because handle_new_auth_user() only inserts the new profile columns
-- (id, email, full_name, phone, organization, role, is_active), while the
-- original app_users table still had legacy NOT-NULL columns (`name`,
-- `username`, `password_hash`) without defaults. The trigger INSERT violated
-- those constraints and Postgres aborted the whole auth.users insert.
--
-- This migration makes those legacy columns nullable. They remain in the
-- table for backward compatibility until a later cleanup migration drops them.
-- Idempotent — safe to re-run.
-- =============================================================================

begin;

do $$
declare
  legacy_col text;
begin
  foreach legacy_col in array array['name', 'username', 'password_hash']
  loop
    if exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'app_users'
         and column_name = legacy_col and is_nullable = 'NO'
    ) then
      execute format('alter table public.app_users alter column %I drop not null', legacy_col);
      raise notice 'Dropped NOT NULL from public.app_users.%', legacy_col;
    end if;
  end loop;
end$$;

commit;
