import { Injectable } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { SupabaseService } from "../common/supabase/supabase.service";
import { ApiException } from "../common/errors/api-exception";
import { DEPLOYMENT_TYPES } from "../common/deployment-types";
import type { CreateArkDto } from "./dto/create-ark.dto";
import type { UpdateArkDto } from "./dto/update-ark.dto";

type ArkRow = {
  id: string;
  name: string;
  location: string;
  status: "online" | "offline";
  power: number;
  network: string;
  core_temp: number;
  dock_status: "locked" | "unlocked";
  drone_count: number;
  drone_model: string | null;
  threat_level: "low" | "medium" | "high";
  last_sync: string;
  firmware: string;
  operator: string;
  deployment_type: string;
  hero_image: string | null;
  perimeter_status: string | null;
  visitor_monitoring: string | null;
  lpr: string | null;
  night_patrol: string | null;
  gate_integration: string | null;
};

/** Every column we read back, kept in one place so all queries agree. */
const ARK_COLUMNS =
  "id,name,location,status,power,network,core_temp,dock_status,drone_count,drone_model,threat_level,last_sync,firmware,operator,deployment_type,hero_image,perimeter_status,visitor_monitoring,lpr,night_patrol,gate_integration";

/**
 * `arks` has many NOT NULL columns with no DB default, so a create must supply
 * them. These keep the admin API usable without demanding every field.
 */
const DEFAULTS = {
  status: "offline",
  dock_status: "locked",
  threat_level: "low",
  network: "Unknown",
  firmware: "v0.0.0",
  operator: "Unassigned",
  power: 0,
  core_temp: 0,
  drone_count: 0,
} as const;

@Injectable()
export class ArksService {
  constructor(private readonly supabase: SupabaseService) {}

  async getArkById(userId: string, accessToken: string, arkId: string) {
    const userClient = this.supabase.getUserClient(accessToken);
    const { data } = await userClient
      .from("arks")
      .select(
        "id,name,location,status,power,network,core_temp,dock_status,drone_count,drone_model,threat_level,last_sync,firmware,operator,deployment_type,hero_image,perimeter_status,visitor_monitoring,lpr,night_patrol,gate_integration",
      )
      .eq("user_id", userId)
      .eq("id", arkId)
      .maybeSingle<ArkRow>();

    if (!data) return null;

    return {
      id: data.id,
      name: data.name,
      location: data.location,
      status: data.status,
      power: data.power,
      network: data.network,
      coreTemp: data.core_temp,
      dockStatus: data.dock_status,
      droneCount: data.drone_count,
      droneModel: data.drone_model ?? undefined,
      threatLevel: data.threat_level,
      lastSync: data.last_sync,
      firmware: data.firmware,
      operator: data.operator,
      deploymentType: data.deployment_type,
      heroImage: data.hero_image ?? null,
      perimeterStatus: data.perimeter_status ?? null,
      visitorMonitoring: data.visitor_monitoring ?? null,
      lpr: data.lpr ?? null,
      nightPatrol: data.night_patrol ?? null,
      gateIntegration: data.gate_integration ?? null,
    };
  }

  async getArks(userId: string, accessToken: string) {
    const userClient = this.supabase.getUserClient(accessToken);

    const { data } = await userClient
      .from("arks")
      .select(
        "id,name,location,status,power,network,core_temp,dock_status,drone_count,drone_model,threat_level,last_sync,firmware,operator,deployment_type,hero_image,perimeter_status,visitor_monitoring,lpr,night_patrol,gate_integration",
      )
      // Enforce ownership even if Supabase RLS is bypassed in dev.
      .eq("user_id", userId)
      .order("id", { ascending: true });

    const rows = (data ?? []) as ArkRow[];

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      location: r.location,
      status: r.status,
      power: r.power,
      network: r.network,
      coreTemp: r.core_temp,
      dockStatus: r.dock_status,
      droneCount: r.drone_count,
      droneModel: r.drone_model ?? undefined,
      threatLevel: r.threat_level,
      lastSync: r.last_sync,
      firmware: r.firmware,
      operator: r.operator,
      deploymentType: r.deployment_type,
      heroImage: r.hero_image ?? null,
      perimeterStatus: r.perimeter_status ?? null,
      visitorMonitoring: r.visitor_monitoring ?? null,
      lpr: r.lpr ?? null,
      nightPatrol: r.night_patrol ?? null,
      gateIntegration: r.gate_integration ?? null,
    }));
  }

  // ─── Admin: list all / create / update / delete ────────────────────────────

  /**
   * ADMIN only. Every ark across all users, with owner info attached — the
   * owner-scoped `getArks` can't see arks an admin created for someone else.
   */
  async listAllArks() {
    const admin = this.supabase.getAdminClient();
    const { data, error } = await admin
      .from("arks")
      .select(`${ARK_COLUMNS},user_id`)
      .order("id", { ascending: true })
      .returns<Array<ArkRow & { user_id: string }>>();
    if (error) throw new ApiException(500, "ARK_LIST_FAILED", error.message);

    const rows = data ?? [];
    if (rows.length === 0) return [];

    // Resolve owner profiles in one query.
    const ownerIds = Array.from(new Set(rows.map((r) => r.user_id)));
    const { data: owners } = await admin
      .from("app_users")
      .select("id,email,full_name")
      .in("id", ownerIds)
      .returns<Array<{ id: string; email: string | null; full_name: string | null }>>();
    const byId = new Map((owners ?? []).map((o) => [o.id, o]));

    return rows.map((r) => ({
      ...this.toDto(r),
      owner: {
        userId: r.user_id,
        email: byId.get(r.user_id)?.email ?? null,
        fullName: byId.get(r.user_id)?.full_name ?? null,
      },
    }));
  }

  /** ADMIN only. Creates an ark owned by `dto.userId`. */
  async createArk(dto: CreateArkDto) {
    const admin = this.supabase.getAdminClient();

    await this.assertUserExists(dto.userId);
    const deploymentType = this.normalizeDeploymentType(dto.deploymentType);
    const id = dto.id?.trim() || `ark-${randomBytes(4).toString("hex")}`;

    const row = {
      id,
      user_id: dto.userId,
      name: dto.name,
      location: dto.location,
      deployment_type: deploymentType,
      status: dto.status ?? DEFAULTS.status,
      dock_status: dto.dockStatus ?? DEFAULTS.dock_status,
      threat_level: dto.threatLevel ?? DEFAULTS.threat_level,
      network: dto.network ?? DEFAULTS.network,
      firmware: dto.firmware ?? DEFAULTS.firmware,
      operator: dto.operator ?? DEFAULTS.operator,
      power: dto.power ?? DEFAULTS.power,
      core_temp: dto.coreTemp ?? DEFAULTS.core_temp,
      drone_count: dto.droneCount ?? DEFAULTS.drone_count,
      last_sync: dto.lastSync ?? new Date().toISOString(),
      drone_model: dto.droneModel ?? null,
      hero_image: dto.heroImage ?? null,
      perimeter_status: dto.perimeterStatus ?? null,
      visitor_monitoring: dto.visitorMonitoring ?? null,
      lpr: dto.lpr ?? null,
      night_patrol: dto.nightPatrol ?? null,
      gate_integration: dto.gateIntegration ?? null,
    };

    const { data, error } = await admin
      .from("arks")
      .insert(row)
      .select(ARK_COLUMNS)
      .maybeSingle<ArkRow>();

    if (error) {
      // Primary-key violation — the caller-supplied id already exists.
      if (error.code === "23505") {
        throw new ApiException(409, "ARK_ID_CONFLICT", `Ark id '${id}' already exists.`);
      }
      throw new ApiException(500, "ARK_CREATE_FAILED", error.message);
    }
    if (!data) throw new ApiException(500, "ARK_CREATE_FAILED", "Unable to create ark.");
    return this.toDto(data);
  }

  /** ADMIN only. Partial update; sending `userId` transfers ownership. */
  async updateArk(arkId: string, dto: UpdateArkDto) {
    const admin = this.supabase.getAdminClient();

    if (dto.userId) await this.assertUserExists(dto.userId);

    const patch: Record<string, unknown> = {};
    const set = (col: string, value: unknown) => {
      if (value !== undefined) patch[col] = value;
    };
    set("user_id", dto.userId);
    set("name", dto.name);
    set("location", dto.location);
    set(
      "deployment_type",
      dto.deploymentType ? this.normalizeDeploymentType(dto.deploymentType) : undefined,
    );
    set("status", dto.status);
    set("dock_status", dto.dockStatus);
    set("threat_level", dto.threatLevel);
    set("network", dto.network);
    set("firmware", dto.firmware);
    set("operator", dto.operator);
    set("power", dto.power);
    set("core_temp", dto.coreTemp);
    set("drone_count", dto.droneCount);
    set("last_sync", dto.lastSync);
    set("drone_model", dto.droneModel);
    set("hero_image", dto.heroImage);
    set("perimeter_status", dto.perimeterStatus);
    set("visitor_monitoring", dto.visitorMonitoring);
    set("lpr", dto.lpr);
    set("night_patrol", dto.nightPatrol);
    set("gate_integration", dto.gateIntegration);

    if (Object.keys(patch).length === 0) {
      throw new ApiException(400, "NO_FIELDS", "No updatable fields were provided.");
    }

    const { data, error } = await admin
      .from("arks")
      .update(patch)
      .eq("id", arkId)
      .select(ARK_COLUMNS)
      .maybeSingle<ArkRow>();

    if (error) throw new ApiException(500, "ARK_UPDATE_FAILED", error.message);
    if (!data) throw new ApiException(404, "ARK_NOT_FOUND", "Ark not found.");
    return this.toDto(data);
  }

  /**
   * ADMIN only. Deleting an ark cascades: `drones` and `drawer_commands` rows
   * for it are DELETED, and `drawer_controllers.ark_id` is SET NULL (the
   * controllers survive but become unassigned).
   */
  async deleteArk(arkId: string) {
    const admin = this.supabase.getAdminClient();
    const { data, error } = await admin
      .from("arks")
      .delete()
      .eq("id", arkId)
      .select("id")
      .maybeSingle<{ id: string }>();

    if (error) throw new ApiException(500, "ARK_DELETE_FAILED", error.message);
    if (!data) throw new ApiException(404, "ARK_NOT_FOUND", "Ark not found.");
    return { id: data.id, deleted: true };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async assertUserExists(userId: string): Promise<void> {
    const admin = this.supabase.getAdminClient();
    const { data, error } = await admin
      .from("app_users")
      .select("id")
      .eq("id", userId)
      .maybeSingle<{ id: string }>();
    if (error) throw new ApiException(500, "USER_LOOKUP_FAILED", error.message);
    if (!data) throw new ApiException(404, "USER_NOT_FOUND", "Target user not found.");
  }

  /**
   * `arks.deployment_type` is free text (no FK/CHECK). Canonical form is the
   * lowercase `DEPLOYMENT_TYPES` value, matching `deployment_types.id` and the
   * `isDeploymentType()` checks used by missions / public-rtsp. Accept any
   * casing from the caller, reject unknown values, always STORE lowercase.
   */
  private normalizeDeploymentType(value: string): string {
    const match = (DEPLOYMENT_TYPES as readonly string[]).find(
      (t) => t === value.trim().toLowerCase(),
    );
    if (!match) {
      throw new ApiException(
        400,
        "INVALID_DEPLOYMENT_TYPE",
        `deploymentType must be one of: ${DEPLOYMENT_TYPES.join(", ")}`,
      );
    }
    return match;
  }

  private toDto(r: ArkRow) {
    return {
      id: r.id,
      name: r.name,
      location: r.location,
      status: r.status,
      power: r.power,
      network: r.network,
      coreTemp: r.core_temp,
      dockStatus: r.dock_status,
      droneCount: r.drone_count,
      droneModel: r.drone_model ?? undefined,
      threatLevel: r.threat_level,
      lastSync: r.last_sync,
      firmware: r.firmware,
      operator: r.operator,
      deploymentType: r.deployment_type,
      heroImage: r.hero_image ?? null,
      perimeterStatus: r.perimeter_status ?? null,
      visitorMonitoring: r.visitor_monitoring ?? null,
      lpr: r.lpr ?? null,
      nightPatrol: r.night_patrol ?? null,
      gateIntegration: r.gate_integration ?? null,
    };
  }
}

