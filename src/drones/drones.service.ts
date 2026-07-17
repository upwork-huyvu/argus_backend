import { Injectable } from "@nestjs/common";
import { SupabaseService } from "../common/supabase/supabase.service";
import { ApiException } from "../common/errors/api-exception";
import type { AssignDroneDto, CreateDroneDto, UpdateDroneDto } from "./dto/drone.dto";

type DroneRow = {
  id: string;
  ark_id: string;
  drawer_controller_id: string | null;
  model: string | null;
  serial_number: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

const DRONE_COLUMNS =
  "id,ark_id,drawer_controller_id,model,serial_number,status,created_at,updated_at";

/**
 * Drones and their mapping to a drawer controller (the drawer they are docked
 * in). See docs/ESP32_DEVICE_MVP_PLAN.md — `drawer_controller 1 : N drones`,
 * `drawer_controller_id = null` means in flight / unassigned. This mapping is
 * what makes launch-gating ("only launch when that drone's drawer is OPEN")
 * possible.
 */
@Injectable()
export class DronesService {
  constructor(private readonly supabase: SupabaseService) {}

  /** ADMIN. Ark must exist; controller (if given) must be under the same ark. */
  async create(dto: CreateDroneDto) {
    const admin = this.supabase.getAdminClient();
    await this.assertArkExists(dto.arkId);
    if (dto.drawerControllerId) {
      await this.assertControllerInArk(dto.drawerControllerId, dto.arkId);
    }

    const { data, error } = await admin
      .from("drones")
      .insert({
        ark_id: dto.arkId,
        drawer_controller_id: dto.drawerControllerId ?? null,
        model: dto.model ?? null,
        serial_number: dto.serialNumber ?? null,
        status: dto.status ?? "DOCKED",
      })
      .select(DRONE_COLUMNS)
      .maybeSingle<DroneRow>();

    if (error) throw new ApiException(500, "DRONE_CREATE_FAILED", error.message);
    if (!data) throw new ApiException(500, "DRONE_CREATE_FAILED", "Unable to create drone.");
    return this.toDto(data);
  }

  /** Drones of an ark. Ownership is enforced by the caller (controller). */
  async listByArk(arkId: string) {
    const admin = this.supabase.getAdminClient();
    const { data, error } = await admin
      .from("drones")
      .select(DRONE_COLUMNS)
      .eq("ark_id", arkId)
      .order("created_at", { ascending: true })
      .returns<DroneRow[]>();
    if (error) throw new ApiException(500, "DRONE_LIST_FAILED", error.message);
    return (data ?? []).map((r) => this.toDto(r));
  }

  async getById(droneId: string) {
    const admin = this.supabase.getAdminClient();
    const { data, error } = await admin
      .from("drones")
      .select(DRONE_COLUMNS)
      .eq("id", droneId)
      .maybeSingle<DroneRow>();
    if (error) throw new ApiException(500, "DRONE_LOOKUP_FAILED", error.message);
    if (!data) throw new ApiException(404, "DRONE_NOT_FOUND", "Drone not found.");
    return data;
  }

  /**
   * ADMIN. Map the drone into a drawer controller, or detach it (null).
   * The controller must belong to the SAME ark as the drone — otherwise a drone
   * could be "docked" in another ark's drawer and launch-gating would read the
   * wrong drawer's state.
   */
  async assignToController(droneId: string, dto: AssignDroneDto) {
    const drone = await this.getById(droneId);

    if (dto.drawerControllerId) {
      await this.assertControllerInArk(dto.drawerControllerId, drone.ark_id);
    }

    const admin = this.supabase.getAdminClient();
    const { data, error } = await admin
      .from("drones")
      .update({ drawer_controller_id: dto.drawerControllerId })
      .eq("id", droneId)
      .select(DRONE_COLUMNS)
      .maybeSingle<DroneRow>();

    if (error) throw new ApiException(500, "DRONE_ASSIGN_FAILED", error.message);
    if (!data) throw new ApiException(404, "DRONE_NOT_FOUND", "Drone not found.");
    return this.toDto(data);
  }

  /** ADMIN. Update model / serial / status. */
  async update(droneId: string, dto: UpdateDroneDto) {
    const patch: Record<string, unknown> = {};
    if (dto.model !== undefined) patch.model = dto.model;
    if (dto.serialNumber !== undefined) patch.serial_number = dto.serialNumber;
    if (dto.status !== undefined) patch.status = dto.status;
    if (Object.keys(patch).length === 0) {
      throw new ApiException(400, "NO_FIELDS", "No updatable fields were provided.");
    }

    const admin = this.supabase.getAdminClient();
    const { data, error } = await admin
      .from("drones")
      .update(patch)
      .eq("id", droneId)
      .select(DRONE_COLUMNS)
      .maybeSingle<DroneRow>();

    if (error) throw new ApiException(500, "DRONE_UPDATE_FAILED", error.message);
    if (!data) throw new ApiException(404, "DRONE_NOT_FOUND", "Drone not found.");
    return this.toDto(data);
  }

  async remove(droneId: string) {
    const admin = this.supabase.getAdminClient();
    const { data, error } = await admin
      .from("drones")
      .delete()
      .eq("id", droneId)
      .select("id")
      .maybeSingle<{ id: string }>();
    if (error) throw new ApiException(500, "DRONE_DELETE_FAILED", error.message);
    if (!data) throw new ApiException(404, "DRONE_NOT_FOUND", "Drone not found.");
    return { id: data.id, deleted: true };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /** Throws 404 unless the ark exists; when userId is given, unless they own it. */
  async assertArkExists(arkId: string, userId?: string): Promise<void> {
    const admin = this.supabase.getAdminClient();
    let query = admin.from("arks").select("id").eq("id", arkId);
    if (userId) query = query.eq("user_id", userId);
    const { data, error } = await query.maybeSingle<{ id: string }>();
    if (error) throw new ApiException(500, "ARK_LOOKUP_FAILED", error.message);
    if (!data) {
      throw new ApiException(404, "ARK_NOT_FOUND", "Ark not found or not owned by you.");
    }
  }

  private async assertControllerInArk(controllerId: string, arkId: string): Promise<void> {
    const admin = this.supabase.getAdminClient();
    const { data, error } = await admin
      .from("drawer_controllers")
      .select("id,ark_id")
      .eq("id", controllerId)
      .maybeSingle<{ id: string; ark_id: string | null }>();
    if (error) throw new ApiException(500, "CONTROLLER_LOOKUP_FAILED", error.message);
    if (!data) {
      throw new ApiException(404, "CONTROLLER_NOT_FOUND", "Drawer controller not found.");
    }
    if (data.ark_id !== arkId) {
      throw new ApiException(
        409,
        "CONTROLLER_ARK_MISMATCH",
        `Drawer controller ${controllerId} belongs to ark ${
          data.ark_id ?? "(unassigned)"
        }, not ${arkId}.`,
      );
    }
  }

  private toDto(r: DroneRow) {
    return {
      droneId: r.id,
      arkId: r.ark_id,
      drawerControllerId: r.drawer_controller_id,
      model: r.model,
      serialNumber: r.serial_number,
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}
