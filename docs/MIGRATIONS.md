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
- Creates the `public.user_role` enum (`GUEST | OPERATOR | ADMIN`).
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
