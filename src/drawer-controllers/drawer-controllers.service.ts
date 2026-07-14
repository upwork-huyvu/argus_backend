import { Injectable, Logger } from "@nestjs/common";
import { SupabaseService } from "../common/supabase/supabase.service";
import { ApiException } from "../common/errors/api-exception";
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

  constructor(private readonly supabase: SupabaseService) {}

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
