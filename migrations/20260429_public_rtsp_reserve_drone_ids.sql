-- =============================================================================
-- public-rtsp: reserve drone / system camera ids
--
-- The "Drone Cam" tile in Live View is a system feed sourced from the DJI
-- bridge / deployment fixture. It must never be writable through the user
-- public-rtsp surface (no add / no rename / no duplicate / no delete by id).
--
-- The application-layer guard lives in
-- `src/public-rtsp/public-rtsp.service.ts::isReservedCameraId`. This migration
-- adds two further safety nets:
--
--   1. A one-shot DELETE that removes any historical rows whose
--      `client_camera_id` matches the reserved namespace (drone / system /
--      drone:* / system:*). At authoring time prod has 0 such rows
--      (verified via Supabase MCP), so this is effectively a no-op there;
--      keeping it in source means any new environment / restored backup is
--      cleaned identically.
--
--   2. A CHECK constraint that prevents future inserts/updates from creating
--      reserved-id rows even if the application guard regresses.
--
-- Idempotent: re-running has no effect.
-- =============================================================================

-- 1. Backfill cleanup ---------------------------------------------------------
delete from public.user_public_rtsp_cameras
where lower(client_camera_id) in ('drone', 'drone-cam', 'dronecam', 'system', 'system-drone')
   or lower(client_camera_id) like 'drone:%'
   or lower(client_camera_id) like 'system:%';

-- 2. CHECK constraint --------------------------------------------------------
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'user_public_rtsp_cameras_client_camera_id_not_reserved'
  ) then
    alter table public.user_public_rtsp_cameras
      add constraint user_public_rtsp_cameras_client_camera_id_not_reserved
      check (
        lower(client_camera_id) not in ('drone', 'drone-cam', 'dronecam', 'system', 'system-drone')
        and lower(client_camera_id) not like 'drone:%'
        and lower(client_camera_id) not like 'system:%'
      );
  end if;
end$$;

comment on constraint user_public_rtsp_cameras_client_camera_id_not_reserved
  on public.user_public_rtsp_cameras is
  'Drone Cam is a system feed surfaced via the DJI bridge; reserved client_camera_ids must not be writable from the user public-rtsp surface. Mirror of isReservedCameraId() in public-rtsp.service.ts.';
