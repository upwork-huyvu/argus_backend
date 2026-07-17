import { Injectable, Logger } from "@nestjs/common";
import { SupabaseService } from "../common/supabase/supabase.service";
import { ApiException } from "../common/errors/api-exception";
import { MqttService } from "../mqtt/mqtt.service";
import { normalizeMac } from "./mac.util";
import type { RegisterControllerDto } from "./dto/register-controller.dto";

export type LifecycleStatus = "UNASSIGNED" | "ACTIVE" | "DISABLED";

type ControllerRow = {
  id: string;
  mac_address: string;
  serial_number: string | null;
  controller_type: string;
  ark_id: string | null;
  lifecycle_status: LifecycleStatus;
  firmware_version: string | null;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
};

export type RegistrationResult = {
  created: boolean;
  body: {
    controllerId: string;
    macAddress: string;
    registrationOutcome: "CREATED" | "ALREADY_REGISTERED";
    lifecycleStatus: LifecycleStatus;
    serverTime: string;
  };
};

@Injectable()
export class DrawerControllersService {
  private readonly logger = new Logger(DrawerControllersService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly mqtt: MqttService,
  ) {}

  /**
   * Owner-scoped current state of a drawer: what the device last REPORTED
   * (sensor-confirmed), not what we asked it to do. This is the source of truth
   * for the UI and for launch-gating — see docs/ESP32_DEVICE_MVP_PLAN.md §11.
   *
   * `drawerState` is null when the controller has never published state yet.
   */
  async getStateForArk(userId: string, arkId: string, controllerId: string) {
    const admin = this.supabase.getAdminClient();

    // Ownership enforced in code (RLS is bypassed with the service-role key).
    const { data: ark } = await admin
      .from("arks")
      .select("id")
      .eq("id", arkId)
      .eq("user_id", userId)
      .maybeSingle<{ id: string }>();
    if (!ark) throw new ApiException(404, "ARK_NOT_FOUND", "Ark not found or not owned by you.");

    const { data: controller } = await admin
      .from("drawer_controllers")
      .select("id,lifecycle_status,last_seen_at")
      .eq("id", controllerId)
      .eq("ark_id", arkId)
      .maybeSingle<{ id: string; lifecycle_status: LifecycleStatus; last_seen_at: string | null }>();
    if (!controller) {
      throw new ApiException(404, "CONTROLLER_NOT_FOUND", "Controller not found under this ark.");
    }

    const { data: state } = await admin
      .from("drawer_state")
      .select("drawer_state,light_state,lock_state,sensor_state,boot_id,reported_at")
      .eq("drawer_controller_id", controllerId)
      .maybeSingle<{
        drawer_state: string | null;
        light_state: string | null;
        lock_state: string | null;
        sensor_state: Record<string, unknown> | null;
        boot_id: string | null;
        reported_at: string | null;
      }>();

    return {
      controllerId,
      arkId,
      lifecycleStatus: controller.lifecycle_status,
      online: this.mqtt.isControllerOnline(controllerId),
      lastSeenAt: controller.last_seen_at,
      drawerState: state?.drawer_state ?? null,
      lightState: state?.light_state ?? null,
      lockState: state?.lock_state ?? null,
      sensorState: state?.sensor_state ?? null,
      bootId: state?.boot_id ?? null,
      reportedAt: state?.reported_at ?? null,
    };
  }

  /**
   * Idempotent create-or-update keyed by normalized MAC.
   * See docs/ESP32_DEVICE_MVP_PLAN.md §7.2. Concurrency-safe via the unique
   * index on mac_address + upsert ON CONFLICT. lifecycle_status and ark_id are
   * intentionally NOT in the upsert payload, so they survive re-registration.
   */
  async register(rawMac: string, dto: RegisterControllerDto): Promise<RegistrationResult> {
    const mac = normalizeMac(rawMac);
    if (!mac) {
      throw new ApiException(400, "INVALID_MAC", "MAC address is not a valid 12-hex identifier.");
    }

    const admin = this.supabase.getAdminClient();

    // Existence check drives the CREATED/ALREADY_REGISTERED outcome and lets us
    // short-circuit a DISABLED controller before touching updated_at.
    const { data: existing, error: selErr } = await admin
      .from("drawer_controllers")
      .select("id,lifecycle_status")
      .eq("mac_address", mac)
      .maybeSingle<{ id: string; lifecycle_status: LifecycleStatus }>();
    if (selErr) {
      this.logger.error(`register select failed: ${selErr.message}`);
      throw new ApiException(500, "REGISTRATION_FAILED", "Registration lookup failed.");
    }
    if (existing?.lifecycle_status === "DISABLED") {
      throw new ApiException(423, "DEVICE_DISABLED", "Controller has been disabled by an admin.");
    }

    const now = new Date().toISOString();
    const { data: row, error: upErr } = await admin
      .from("drawer_controllers")
      .upsert(
        {
          mac_address: mac,
          serial_number: dto.serialNumber ?? null,
          controller_type: dto.controllerType,
          firmware_version: dto.firmware?.version ?? null,
          capabilities: dto.capabilities ?? [],
          hardware_info: dto.hardware ?? {},
          network_info: dto.network ?? {},
          last_boot_id: dto.boot?.bootId ?? null,
          last_seen_at: now,
        },
        { onConflict: "mac_address" },
      )
      .select("id,lifecycle_status")
      .maybeSingle<{ id: string; lifecycle_status: LifecycleStatus }>();

    if (upErr || !row) {
      this.logger.error(`register upsert failed: ${upErr?.message}`);
      throw new ApiException(500, "REGISTRATION_FAILED", "Registration failed.");
    }
    // Race guard: controller disabled between the select and the upsert.
    if (row.lifecycle_status === "DISABLED") {
      throw new ApiException(423, "DEVICE_DISABLED", "Controller has been disabled by an admin.");
    }

    const created = !existing;
    return {
      created,
      body: {
        controllerId: row.id,
        macAddress: mac,
        registrationOutcome: created ? "CREATED" : "ALREADY_REGISTERED",
        lifecycleStatus: row.lifecycle_status,
        serverTime: now,
      },
    };
  }

  // ─── Admin ────────────────────────────────────────────────────────────────

  async list(): Promise<ControllerRow[]> {
    const admin = this.supabase.getAdminClient();
    const { data, error } = await admin
      .from("drawer_controllers")
      .select(
        "id,mac_address,serial_number,controller_type,ark_id,lifecycle_status,firmware_version,last_seen_at,created_at,updated_at",
      )
      .order("created_at", { ascending: false })
      .returns<ControllerRow[]>();
    if (error) throw new ApiException(500, "LIST_FAILED", error.message);
    return data ?? [];
  }

  /** Assign a controller to an ark and activate it (UNASSIGNED → ACTIVE). */
  async assignToArk(controllerId: string, arkId: string): Promise<ControllerRow> {
    const admin = this.supabase.getAdminClient();

    const { data: ark, error: arkErr } = await admin
      .from("arks")
      .select("id")
      .eq("id", arkId)
      .maybeSingle<{ id: string }>();
    if (arkErr) throw new ApiException(500, "ASSIGN_FAILED", arkErr.message);
    if (!ark) throw new ApiException(404, "ARK_NOT_FOUND", "Ark not found.");

    return this.updateController(controllerId, { ark_id: arkId, lifecycle_status: "ACTIVE" });
  }

  async setLifecycleStatus(controllerId: string, status: LifecycleStatus): Promise<ControllerRow> {
    return this.updateController(controllerId, { lifecycle_status: status });
  }

  private async updateController(
    controllerId: string,
    patch: Record<string, unknown>,
  ): Promise<ControllerRow> {
    const admin = this.supabase.getAdminClient();
    const { data, error } = await admin
      .from("drawer_controllers")
      .update(patch)
      .eq("id", controllerId)
      .select(
        "id,mac_address,serial_number,controller_type,ark_id,lifecycle_status,firmware_version,last_seen_at,created_at,updated_at",
      )
      .maybeSingle<ControllerRow>();
    if (error) throw new ApiException(500, "UPDATE_FAILED", error.message);
    if (!data) throw new ApiException(404, "CONTROLLER_NOT_FOUND", "Controller not found.");
    return data;
  }
}
