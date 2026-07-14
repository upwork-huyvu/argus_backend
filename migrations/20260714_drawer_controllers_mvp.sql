-- =============================================================================
-- Drawer Controller (ESP32) MVP schema.
--
-- Introduces the ESP32 "drawer_controller" hardware entity (renamed away from
-- "device", which already means *drone* in this product), plus drone identity,
-- command lifecycle, latest-state and event tables.
--
-- Model:
--   arks (1) ──< drawer_controllers (N) ──< drones (0..N)
--   drones.drawer_controller_id NULL = drone in flight / not docked.
--
-- Assumes pre-existing tables:
--   public.arks(id text PK, user_id uuid)      -- not in migrations/ (predates them)
--   public.app_users(id uuid PK)               -- profile table (= auth.users.id)
-- FKs to those tables are added defensively (skip-with-notice if absent), same
-- style as 20260420_auth_profiles.sql. Reuses public.set_updated_at().
--
-- Applied to project ehlbdulcjzijgojntoye via Supabase MCP (2026-07-14). Kept in
-- source for future environments + audit trail. All 5 tables, 4 cross-table FKs,
-- key indexes and RLS policies verified present after apply.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. drawer_controllers — the ESP32 hardware (registration + MQTT endpoint)
-- -----------------------------------------------------------------------------
create table if not exists public.drawer_controllers (
  id uuid primary key default gen_random_uuid(),                 -- controllerId
  mac_address text not null,                                     -- normalized: ^[0-9A-F]{12}$
  serial_number text,                                            -- metadata only; NOT unique in MVP
  controller_type text not null default 'DRAWER_CONTROLLER',
  ark_id text,                                                   -- FK -> arks(id); added below
  lifecycle_status text not null default 'UNASSIGNED'
    check (lifecycle_status in ('UNASSIGNED', 'ACTIVE', 'DISABLED')),
  firmware_version text,
  capabilities jsonb not null default '[]'::jsonb,
  hardware_info jsonb not null default '{}'::jsonb,
  network_info  jsonb not null default '{}'::jsonb,
  last_boot_id text,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint drawer_controllers_mac_format check (mac_address ~ '^[0-9A-F]{12}$')
);

-- UPSERT target + duplicate guard for concurrent registration.
create unique index if not exists uq_drawer_controllers_mac
  on public.drawer_controllers (mac_address);
create index if not exists idx_drawer_controllers_ark
  on public.drawer_controllers (ark_id) where ark_id is not null;

-- -----------------------------------------------------------------------------
-- 2. drones — drone identity + mapping to the drawer they are docked in
-- -----------------------------------------------------------------------------
create table if not exists public.drones (
  id uuid primary key default gen_random_uuid(),
  ark_id text not null,                                          -- FK -> arks(id); added below
  drawer_controller_id uuid
    references public.drawer_controllers(id) on delete set null, -- NULL = in flight / unassigned
  model text,
  serial_number text,
  status text not null default 'DOCKED'
    check (status in ('DOCKED', 'IN_FLIGHT', 'MAINTENANCE', 'UNKNOWN')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_drones_controller
  on public.drones (drawer_controller_id) where drawer_controller_id is not null;
create index if not exists idx_drones_ark on public.drones (ark_id);

-- -----------------------------------------------------------------------------
-- 3. drawer_commands — command lifecycle (App -> backend -> MQTT -> ESP32)
-- -----------------------------------------------------------------------------
create table if not exists public.drawer_commands (
  id uuid primary key default gen_random_uuid(),                 -- commandId
  drawer_controller_id uuid not null
    references public.drawer_controllers(id) on delete cascade,  -- publish target
  ark_id text not null,                                          -- FK -> arks(id); authz/audit
  requested_by uuid not null,                                    -- FK -> app_users(id); added below
  type text not null
    check (type in ('DRAWER_OPEN', 'DRAWER_CLOSE', 'LIGHT_ON', 'LIGHT_OFF')),
  status text not null default 'PENDING'
    check (status in ('PENDING', 'PUBLISHED', 'ACCEPTED', 'SUCCEEDED',
                      'FAILED', 'REJECTED', 'EXPIRED')),
  idempotency_key text not null,
  payload jsonb not null default '{}'::jsonb,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  accepted_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz not null
);

-- Double-tap / client retry with same key must NOT create a second command.
create unique index if not exists uq_drawer_commands_idempotency
  on public.drawer_commands (drawer_controller_id, idempotency_key);
-- Reconciliation sweeper: expire PENDING/PUBLISHED/ACCEPTED past expires_at.
create index if not exists idx_drawer_commands_reconcile
  on public.drawer_commands (status, expires_at);
create index if not exists idx_drawer_commands_ark_created
  on public.drawer_commands (ark_id, created_at desc);

-- -----------------------------------------------------------------------------
-- 4. drawer_state — one latest-state row per controller
-- -----------------------------------------------------------------------------
create table if not exists public.drawer_state (
  drawer_controller_id uuid primary key
    references public.drawer_controllers(id) on delete cascade,
  drawer_state text
    check (drawer_state in ('UNKNOWN', 'CLOSED', 'OPENING', 'OPEN',
                            'CLOSING', 'BLOCKED', 'FAULT')),
  light_state text,
  lock_state text,
  sensor_state jsonb,
  boot_id text,
  reported_at timestamptz,
  raw_payload jsonb
);

-- -----------------------------------------------------------------------------
-- 5. drawer_events — audit / fault history
-- -----------------------------------------------------------------------------
create table if not exists public.drawer_events (
  id uuid primary key default gen_random_uuid(),
  drawer_controller_id uuid not null
    references public.drawer_controllers(id) on delete cascade,
  event_type text not null,
  severity text not null
    check (severity in ('INFO', 'WARNING', 'ERROR', 'CRITICAL')),
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz,
  received_at timestamptz not null default now()
);

create index if not exists idx_drawer_events_controller_time
  on public.drawer_events (drawer_controller_id, occurred_at desc);

-- -----------------------------------------------------------------------------
-- 6. updated_at triggers (reuse existing public.set_updated_at())
-- -----------------------------------------------------------------------------
drop trigger if exists trg_drawer_controllers_updated_at on public.drawer_controllers;
create trigger trg_drawer_controllers_updated_at
  before update on public.drawer_controllers
  for each row execute function public.set_updated_at();

drop trigger if exists trg_drones_updated_at on public.drones;
create trigger trg_drones_updated_at
  before update on public.drones
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 7. Cross-table FKs to pre-existing tables (arks, app_users) — defensive.
--    Skip-with-notice if the target table is missing, so the migration is safe
--    in environments where arks/app_users have not been provisioned yet.
-- -----------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = 'arks'
  ) then
    begin
      alter table public.drawer_controllers
        add constraint fk_drawer_controllers_ark
        foreign key (ark_id) references public.arks(id) on delete set null;
    exception when duplicate_object then null;
             when others then raise notice 'skip FK drawer_controllers.ark_id: %', sqlerrm;
    end;
    begin
      alter table public.drones
        add constraint fk_drones_ark
        foreign key (ark_id) references public.arks(id) on delete cascade;
    exception when duplicate_object then null;
             when others then raise notice 'skip FK drones.ark_id: %', sqlerrm;
    end;
    begin
      alter table public.drawer_commands
        add constraint fk_drawer_commands_ark
        foreign key (ark_id) references public.arks(id) on delete cascade;
    exception when duplicate_object then null;
             when others then raise notice 'skip FK drawer_commands.ark_id: %', sqlerrm;
    end;
  else
    raise notice 'public.arks not found — skipping all ark FKs';
  end if;

  if exists (
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = 'app_users'
  ) then
    begin
      alter table public.drawer_commands
        add constraint fk_drawer_commands_requested_by
        foreign key (requested_by) references public.app_users(id);
    exception when duplicate_object then null;
             when others then raise notice 'skip FK drawer_commands.requested_by: %', sqlerrm;
    end;
  else
    raise notice 'public.app_users not found — skipping requested_by FK';
  end if;
end$$;

-- -----------------------------------------------------------------------------
-- 8. RLS
--    - App (authenticated user) may SELECT rows for arks they own.
--    - drawer_controllers + drawer_events: no client policy => service_role only.
--    - All writes are performed by the backend using the service_role key.
--    Policies that reference public.arks are only created if arks exists.
-- -----------------------------------------------------------------------------
alter table public.drawer_controllers enable row level security;
alter table public.drones             enable row level security;
alter table public.drawer_commands    enable row level security;
alter table public.drawer_state       enable row level security;
alter table public.drawer_events      enable row level security;

do $$
begin
  if exists (
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = 'arks'
  ) then
    -- drones: owner of the ark can read its drones.
    drop policy if exists drones_select_owner on public.drones;
    create policy drones_select_owner on public.drones
      for select using (
        exists (select 1 from public.arks a
                 where a.id = drones.ark_id and a.user_id = auth.uid())
      );

    -- drawer_commands: owner of the ark can read command status.
    drop policy if exists drawer_commands_select_owner on public.drawer_commands;
    create policy drawer_commands_select_owner on public.drawer_commands
      for select using (
        exists (select 1 from public.arks a
                 where a.id = drawer_commands.ark_id and a.user_id = auth.uid())
      );

    -- drawer_state: owner of the controller's ark can read latest state.
    drop policy if exists drawer_state_select_owner on public.drawer_state;
    create policy drawer_state_select_owner on public.drawer_state
      for select using (
        exists (
          select 1
            from public.drawer_controllers dc
            join public.arks a on a.id = dc.ark_id
           where dc.id = drawer_state.drawer_controller_id
             and a.user_id = auth.uid()
        )
      );
  else
    raise notice 'public.arks not found — skipping owner SELECT policies';
  end if;
end$$;

commit;
