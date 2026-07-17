-- =============================================================================
-- Normalize public.arks.deployment_type to the canonical lowercase form.
--
-- Why: `arks.deployment_type` is free text (no FK/CHECK) and rows were seeded
-- capitalized ("Commercial", "School"), while the rest of the system treats the
-- lowercase values as canonical:
--   - public.deployment_types.id  -> enum: construction|commercial|school|sports|estate|residential
--   - src/common/deployment-types.ts (DEPLOYMENT_TYPES / isDeploymentType)
--   - missions.deployment_type and public_rtsp deployment_type comparisons
-- ArksService now always stores the lowercase value; this back-fills old rows.
--
-- Safe: data-only (no schema change). Nothing compares arks.deploymentType to a
-- capitalized literal (checked in ArgusBE + ArgusRN).
--
-- Applied to project ehlbdulcjzijgojntoye via Supabase MCP (2026-07-17).
-- =============================================================================

begin;

update public.arks
   set deployment_type = lower(trim(deployment_type))
 where deployment_type is distinct from lower(trim(deployment_type));

commit;

-- Verification (should return zero rows):
--   select id, deployment_type from public.arks
--    where deployment_type <> lower(trim(deployment_type));
--
-- Optional hardening (NOT applied — would reject any future non-canonical
-- insert, including legacy seed scripts):
--   alter table public.arks add constraint arks_deployment_type_valid
--     check (deployment_type in
--       ('construction','commercial','school','sports','estate','residential'));
