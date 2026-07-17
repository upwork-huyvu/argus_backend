-- =============================================================================
-- Lock arks.deployment_type to the canonical lowercase set.
--
-- Follows 20260717_normalize_ark_deployment_type.sql (which back-filled existing
-- rows). This CHECK stops the drift from ever coming back — including from seed
-- scripts / manual inserts outside the API.
--
-- Mirrors public.deployment_types (enum) and src/common/deployment-types.ts.
-- A CHECK (not an FK) because deployment_types.id is an enum type, and the
-- column is plain text.
--
-- BREAKING for any writer still inserting capitalized values ("Commercial") —
-- they must send lowercase. ArksService already normalizes on write.
--
-- Applied to project ehlbdulcjzijgojntoye via Supabase MCP (2026-07-17).
-- =============================================================================

begin;

alter table public.arks
  drop constraint if exists arks_deployment_type_valid;

alter table public.arks
  add constraint arks_deployment_type_valid
  check (
    deployment_type in
      ('construction', 'commercial', 'school', 'sports', 'estate', 'residential')
  );

commit;
