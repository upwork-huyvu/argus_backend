import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from "@nestjs/common";
import { SupabaseService } from "../common/supabase/supabase.service";
import { DEPLOYMENT_TYPES, isDeploymentType, type DeploymentType } from "../common/deployment-types";

export type PublicRtspCamera = {
  id: string;
  name: string;
  url: string;
  note?: string;
};

type Row = {
  deployment_type: string;
  client_camera_id: string;
  name: string;
  url: string;
  note: string | null;
};

/**
 * Reserved client-camera ids. These represent system feeds the user is not
 * allowed to register, mutate, or delete via the public-rtsp surface. The
 * canonical "Drone Cam" tile is sourced from the DJI bridge / deployment
 * fixture and must remain immutable from the user's perspective.
 *
 * Rule mirrors FE `Manage Feeds Popup` design: drone row has no context menu
 * and shows "System · cannot edit or delete". The BE check is the
 * authoritative guard.
 */
const RESERVED_CAMERA_IDS: ReadonlySet<string> = new Set([
  "drone",
  "drone-cam",
  "dronecam",
  "system",
  "system-drone",
]);

function isReservedCameraId(id: string): boolean {
  const k = id.trim().toLowerCase();
  if (RESERVED_CAMERA_IDS.has(k)) return true;
  if (k.startsWith("drone:")) return true;
  if (k.startsWith("system:")) return true;
  return false;
}

@Injectable()
export class PublicRtspService {
  constructor(private readonly supabase: SupabaseService) {}

  async getMap(userId: string): Promise<Partial<Record<DeploymentType, PublicRtspCamera[]>>> {
    const admin = this.supabase.getAdminClient();
    const { data, error } = await admin
      .from("user_public_rtsp_cameras")
      .select("deployment_type,client_camera_id,name,url,note")
      .eq("user_id", userId)
      .order("created_at", { ascending: true });

    if (error) {
      throw new InternalServerErrorException("Unable to load public RTSP cameras.");
    }

    const out: Partial<Record<DeploymentType, PublicRtspCamera[]>> = {};
    for (const raw of (data ?? []) as Row[]) {
      if (!isDeploymentType(raw.deployment_type)) continue;
      const dep = raw.deployment_type;
      const cam: PublicRtspCamera = {
        id: raw.client_camera_id,
        name: raw.name,
        url: raw.url,
        note: raw.note ?? undefined,
      };
      if (!out[dep]) out[dep] = [];
      out[dep]!.push(cam);
    }
    return out;
  }

  async putMap(
    userId: string,
    byDeployment: Record<string, unknown>,
  ): Promise<Partial<Record<DeploymentType, PublicRtspCamera[]>>> {
    const parsed = this.parseByDeployment(byDeployment);
    const admin = this.supabase.getAdminClient();

    const { error: delErr } = await admin.from("user_public_rtsp_cameras").delete().eq("user_id", userId);
    if (delErr) {
      throw new InternalServerErrorException("Unable to update public RTSP cameras.");
    }

    const rows: Array<{
      user_id: string;
      deployment_type: DeploymentType;
      client_camera_id: string;
      name: string;
      url: string;
      note: string | null;
    }> = [];

    for (const dep of DEPLOYMENT_TYPES) {
      const list = parsed[dep];
      if (!list?.length) continue;
      for (const cam of list) {
        rows.push({
          user_id: userId,
          deployment_type: dep,
          client_camera_id: cam.id,
          name: cam.name,
          url: cam.url,
          note: cam.note ?? null,
        });
      }
    }

    if (rows.length > 0) {
      const { error: insErr } = await admin.from("user_public_rtsp_cameras").insert(rows);
      if (insErr) {
        throw new InternalServerErrorException("Unable to save public RTSP cameras.");
      }
    }

    return this.getMap(userId);
  }

  private parseByDeployment(
    raw: Record<string, unknown>,
  ): Partial<Record<DeploymentType, PublicRtspCamera[]>> {
    const out: Partial<Record<DeploymentType, PublicRtspCamera[]>> = {};
    for (const key of Object.keys(raw)) {
      if (!isDeploymentType(key)) {
        throw new BadRequestException({ message: `Unknown deployment id: ${key}` });
      }
      const val = raw[key];
      if (!Array.isArray(val)) {
        throw new BadRequestException({ message: `Invalid camera list for ${key}` });
      }
      const cams: PublicRtspCamera[] = [];
      for (const item of val) {
        if (!item || typeof item !== "object") {
          throw new BadRequestException({ message: "Invalid camera entry." });
        }
        const o = item as Record<string, unknown>;
        const id = typeof o.id === "string" ? o.id.trim() : "";
        const name = typeof o.name === "string" ? o.name.trim() : "";
        const url = typeof o.url === "string" ? o.url.trim() : "";
        if (!id || !name || !url) {
          throw new BadRequestException({ message: "Each camera requires id, name, and url." });
        }
        if (isReservedCameraId(id)) {
          // Drone cam is a system feature and must never be writable through
          // the user-CRUD endpoint (no add / no rename / no delete by id).
          throw new BadRequestException({
            message: `Camera id "${id}" is reserved for system feeds (drone cam) and cannot be modified.`,
          });
        }
        const lower = url.toLowerCase();
        const okScheme =
          lower.startsWith("rtsp://") ||
          lower.startsWith("rtsps://") ||
          lower.startsWith("http://") ||
          lower.startsWith("https://");
        if (!okScheme) {
          throw new BadRequestException({
            message: "URL must start with rtsp://, rtsps://, http://, or https://",
          });
        }
        const note =
          typeof o.note === "string" && o.note.trim() ? o.note.trim() : undefined;
        cams.push({ id, name, url, note });
      }
      out[key] = cams;
    }
    return out;
  }
}
