# Migrations

Migrations live in `/migrations/*.sql`. They are plain SQL — apply via the
Supabase SQL editor, `supabase db push`, or a psql connection with the service
role.

## How to apply

### Option 1 — Supabase dashboard
1. Open the `arguss` project → SQL Editor.
2. Paste the contents of the migration file.
3. Run.

### Option 2 — Supabase CLI
```bash
supabase link --project-ref <ref>
supabase db push migrations/20260420_auth_profiles.sql
```

### Option 3 — psql directly
```bash
PSQL_URL=$(supabase --project-ref <ref> db dump --dry-run 2>&1 | grep -oE 'postgresql://[^ ]+')
psql "$PSQL_URL" -f migrations/20260420_auth_profiles.sql
```

## Ordering

Filenames are sorted lexicographically: `YYYYMMDD_description.sql`. Apply in
order. Each file uses `begin;` / `commit;` so a failure rolls back its own
changes (but not prior migrations).

## 20260420_auth_profiles.sql

Initial Supabase-Auth-linked profile migration.

**Pre-flight checklist:**
- Confirm the `auth.users` table already contains rows for every current
  `app_users.id`. If not, the FK add step will `raise notice` and skip rather
  than fail — clean up orphans, then rerun.
- Back up the `app_users` table if in production.

**Changes:**
- Normalizes `app_users.role` to `text` with a CHECK constraint for
  `GUEST | OPERATOR | ADMIN`. If the column already existed as the legacy
  `user_role` enum, it's converted to text and the enum type is dropped.
  (Reason: Postgres forbids using a newly-added enum value in the same
  transaction — painful in Supabase's single-paste SQL editor.)
- Adds profile columns: `email`, `full_name`, `phone`, `organization`,
  `avatar_url`, `is_active`, `last_login_at`, `created_by`, `created_at`,
  `updated_at`.
- Rewrites legacy role values (`client_admin → ADMIN`,
  `treycor_operator → OPERATOR`, `viewer → GUEST`) and converts the column type.
- Installs `handle_new_auth_user` trigger → auto-creates a profile row on new
  `auth.users` insert, pulling `full_name` / `phone` / `organization` / `role`
  from `raw_user_meta_data`.
- Adds FK `app_users.id → auth.users.id on delete cascade`.
- Baseline RLS: users see/update only their own row; ADMIN sees all.

**Rollback:** not idempotent in reverse — restore from backup.

## 20260714_drawer_controllers_mvp.sql

ESP32 drawer-controller MVP schema (see `docs/ESP32_DEVICE_MVP_PLAN.md`).

**Pre-flight checklist:**
- Assumes `public.arks(id text PK, user_id uuid)` and `public.app_users(id uuid PK)`
  already exist. Cross-table FKs and owner RLS policies are added in guarded
  `do` blocks that `raise notice` and skip if `arks`/`app_users` are absent —
  the migration will not hard-fail, but re-run once those tables exist to
  install the skipped constraints.
- Reuses `public.set_updated_at()` (from `20260420_auth_profiles.sql`) — apply
  that migration first.

**Changes:**
- Tables: `drawer_controllers` (ESP32 hardware, `id = controllerId`), `drones`
  (identity + `drawer_controller_id` mapping), `drawer_commands` (command
  lifecycle), `drawer_state` (latest state per controller), `drawer_events`.
- CHECK constraints on every enum/status; MAC format check `^[0-9A-F]{12}$`.
- Unique `drawer_controllers.mac_address` (concurrency-safe registration);
  unique `(drawer_controller_id, idempotency_key)` on `drawer_commands`;
  reconcile index `(status, expires_at)`.
- RLS: owner-scoped SELECT on `drones`/`drawer_commands`/`drawer_state`;
  `drawer_controllers`/`drawer_events` are service-role only (RLS on, no policy).

**Rollback:** drop the five tables (and their `fk_*` constraints) — no data
migration to reverse.
