import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SupabaseService } from "../common/supabase/supabase.service";
import { ApiException } from "../common/errors/api-exception";
import { ROLE_PERMISSIONS, type UserRole } from "../common/permissions";
import { MqttService } from "../mqtt/mqtt.service";
import { SCHEMA_VERSION } from "../mqtt/mqtt-payloads";
import {
  DRAWER_COMMAND_TYPES,
  type CreateDrawerCommandDto,
  type DrawerCommandType,
} from "./dto/create-drawer-command.dto";

const DEFAULT_EXPIRES_SECONDS = 15;

/** Per-type actuator timeout the device uses (relative, NTP-skew safe). */
const MOVEMENT_TIMEOUT_MS: Record<DrawerCommandType, number> = {
  DRAWER_OPEN: 8000,
  DRAWER_CLOSE: 8000,
  LIGHT_ON: 2000,
  LIGHT_OFF: 2000,
};

type CommandRow = {
  id: string;
  drawer_controller_id: string;
  ark_id: string;
  type: string;
  status: string;
  idempotency_key: string;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  published_at: string | null;
  accepted_at: string | null;
  completed_at: string | null;
  expires_at: string;
};

export type CommandView = {
  commandId: string;
  controllerId: string;
  arkId: string;
  type: string;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  publishedAt: string | null;
  acceptedAt: string | null;
  completedAt: string | null;
  expiresAt: string;
};

@Injectable()
export class DrawerCommandsService {
  private readonly logger = new Logger(DrawerCommandsService.name);

  /**
   * DRAWER_SKIP_ONLINE_CHECK=true → publish to MQTT without requiring known
   * presence. Escape hatch for bring-up/debug: presence lives in this process's
   * memory, so a backend that restarted (or never got the retained presence)
   * would otherwise refuse commands for a perfectly healthy drawer.
   * Cost: with no presence, a command to a truly absent device just EXPIREs.
   */
  private readonly skipOnlineCheck: boolean;

  constructor(
    private readonly supabase: SupabaseService,
    private readonly mqtt: MqttService,
    private readonly config: ConfigService,
  ) {
    this.skipOnlineCheck =
      (this.config.get<string>("DRAWER_SKIP_ONLINE_CHECK") ?? "").trim().toLowerCase() === "true";
    if (this.skipOnlineCheck) {
      this.logger.warn("DRAWER_SKIP_ONLINE_CHECK=true — publishing commands without a presence check");
    }
  }

  /**
   * Create + publish a command. See docs/ESP32_DEVICE_MVP_PLAN.md §10.1.
   * Authz = ark ownership + canControlDrone + controller ACTIVE under that ark.
   * Idempotent on (controllerId, Idempotency-Key). PUBACK != success.
   */
  async createCommand(
    user: { userId: string; role: UserRole },
    arkId: string,
    controllerId: string,
    idempotencyKey: string | undefined,
    dto: CreateDrawerCommandDto,
  ): Promise<CommandView> {
    if (!idempotencyKey || !idempotencyKey.trim()) {
      throw new ApiException(400, "MISSING_IDEMPOTENCY_KEY", "Idempotency-Key header is required.");
    }
    if (!ROLE_PERMISSIONS[user.role].canControlDrone) {
      throw new ApiException(403, "FORBIDDEN", "Your role cannot control drawers.");
    }
    if (!DRAWER_COMMAND_TYPES.includes(dto.type)) {
      throw new ApiException(400, "INVALID_COMMAND_TYPE", "Unsupported command type.");
    }

    const admin = this.supabase.getAdminClient();
    const idem = idempotencyKey.trim();

    // Ownership: the user must own the ark (enforced in code even if RLS bypassed).
    const { data: ark, error: arkErr } = await admin
      .from("arks")
      .select("id")
      .eq("id", arkId)
      .eq("user_id", user.userId)
      .maybeSingle<{ id: string }>();
    if (arkErr) throw new ApiException(500, "COMMAND_FAILED", arkErr.message);
    if (!ark) throw new ApiException(404, "ARK_NOT_FOUND", "Ark not found or not owned by you.");

    // Controller must belong to this ark and be ACTIVE.
    const { data: controller, error: cErr } = await admin
      .from("drawer_controllers")
      .select("id,lifecycle_status")
      .eq("id", controllerId)
      .eq("ark_id", arkId)
      .maybeSingle<{ id: string; lifecycle_status: string }>();
    if (cErr) throw new ApiException(500, "COMMAND_FAILED", cErr.message);
    if (!controller) {
      throw new ApiException(404, "CONTROLLER_NOT_FOUND", "Controller not found under this ark.");
    }
    if (controller.lifecycle_status !== "ACTIVE") {
      throw new ApiException(409, "DRAWER_NOT_ACTIVE", "Controller is not active.");
    }

    const now = Date.now();
    const expiresInSeconds = dto.expiresInSeconds ?? DEFAULT_EXPIRES_SECONDS;
    const expiresAt = new Date(now + expiresInSeconds * 1000).toISOString();

    // Idempotency: replay the existing command instead of creating a duplicate.
    // EXCEPT when it never reached the device — a command that was never
    // published actuated nothing, so re-arming the same record under the same
    // key is safe and keeps a transient failure (e.g. a brief CONTROLLER_OFFLINE)
    // from poisoning that key forever.
    const existing = await this.findByIdempotencyKey(controllerId, idem);
    let inserted: CommandRow;

    if (existing) {
      // An Idempotency-Key identifies ONE intent. Reusing it for a different
      // command type must not silently replay the old command — the caller would
      // believe their DRAWER_CLOSE was handled while nothing was ever sent, and
      // the response would even report the wrong type. Reject instead (same
      // "reused with different parameters" rule as Stripe). expiresInSeconds is
      // only a TTL hint and is deliberately not part of the identity.
      if (existing.type !== dto.type) {
        throw new ApiException(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          `Idempotency-Key '${idem}' was already used for ${existing.type} (command ${existing.id}). Use a new key for ${dto.type}.`,
        );
      }
      if (!this.neverReachedDevice(existing)) return this.toView(existing);
      const rearmed = await this.markCommand(existing.id, {
        status: "PENDING",
        error_code: null,
        error_message: null,
        completed_at: null,
        expires_at: expiresAt,
      });
      if (!rearmed) throw new ApiException(500, "COMMAND_FAILED", "Unable to retry command.");
      this.logger.log(`retrying command ${existing.id} (never published) under the same key`);
      inserted = rearmed;
    } else {
      const { data: created, error: insErr } = await admin
        .from("drawer_commands")
        .insert({
          drawer_controller_id: controllerId,
          ark_id: arkId,
          requested_by: user.userId,
          type: dto.type,
          status: "PENDING",
          idempotency_key: idem,
          expires_at: expiresAt,
        })
        .select("*")
        .maybeSingle<CommandRow>();

      if (insErr) {
        // Unique-violation race: another concurrent request created it first.
        if (insErr.code === "23505") {
          const raced = await this.findByIdempotencyKey(controllerId, idem);
          if (raced) return this.toView(raced);
        }
        throw new ApiException(500, "COMMAND_FAILED", insErr.message);
      }
      if (!created) throw new ApiException(500, "COMMAND_FAILED", "Unable to create command.");
      inserted = created;
    }

    // Fail fast if the controller is not online — do NOT rely on broker queueing.
    // Skippable via DRAWER_SKIP_ONLINE_CHECK for bring-up/debug.
    if (!this.skipOnlineCheck && !this.mqtt.isControllerOnline(controllerId)) {
      const updated = await this.markCommand(inserted.id, {
        status: "FAILED",
        error_code: "CONTROLLER_OFFLINE",
        error_message:
          "Controller is offline. Set DRAWER_SKIP_ONLINE_CHECK=true to publish anyway.",
        completed_at: new Date().toISOString(),
      });
      return this.toView(updated ?? inserted);
    }

    // Publish (QoS 1). PUBACK is transport-only; status becomes PUBLISHED, not SUCCEEDED.
    try {
      await this.mqtt.publishCommand(controllerId, {
        schemaVersion: SCHEMA_VERSION,
        commandId: inserted.id,
        type: dto.type,
        issuedAt: new Date(now).toISOString(),
        expiresAt,
        parameters: { timeoutMs: MOVEMENT_TIMEOUT_MS[dto.type] },
      });
      const published = await this.markCommand(inserted.id, {
        status: "PUBLISHED",
        published_at: new Date().toISOString(),
      });
      return this.toView(published ?? inserted);
    } catch (e) {
      this.logger.error(`publish failed for command ${inserted.id}: ${String(e)}`);
      const failed = await this.markCommand(inserted.id, {
        status: "FAILED",
        error_code: "PUBLISH_FAILED",
        error_message: "Failed to publish command to broker.",
        completed_at: new Date().toISOString(),
      });
      return this.toView(failed ?? inserted);
    }
  }

  /** Command status for App polling. Ownership-checked. */
  async getCommand(
    userId: string,
    arkId: string,
    controllerId: string,
    commandId: string,
  ): Promise<CommandView> {
    const admin = this.supabase.getAdminClient();

    const { data: ark } = await admin
      .from("arks")
      .select("id")
      .eq("id", arkId)
      .eq("user_id", userId)
      .maybeSingle<{ id: string }>();
    if (!ark) throw new ApiException(404, "ARK_NOT_FOUND", "Ark not found or not owned by you.");

    const { data, error } = await admin
      .from("drawer_commands")
      .select("*")
      .eq("id", commandId)
      .eq("drawer_controller_id", controllerId)
      .eq("ark_id", arkId)
      .maybeSingle<CommandRow>();
    if (error) throw new ApiException(500, "COMMAND_LOOKUP_FAILED", error.message);
    if (!data) throw new ApiException(404, "COMMAND_NOT_FOUND", "Command not found.");
    return this.toView(data);
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /**
   * True when this command definitively never got to the ESP32: it failed
   * before any publish (published_at is null). Retrying it cannot double-actuate
   * anything, so the Idempotency-Key may be reused. A command that WAS published
   * is never retried — the device may have already run the motor.
   */
  private neverReachedDevice(row: CommandRow): boolean {
    return (
      row.published_at === null && (row.status === "FAILED" || row.status === "EXPIRED")
    );
  }

  private async findByIdempotencyKey(
    controllerId: string,
    key: string,
  ): Promise<CommandRow | null> {
    const admin = this.supabase.getAdminClient();
    const { data } = await admin
      .from("drawer_commands")
      .select("*")
      .eq("drawer_controller_id", controllerId)
      .eq("idempotency_key", key)
      .maybeSingle<CommandRow>();
    return data ?? null;
  }

  private async markCommand(
    commandId: string,
    patch: Record<string, unknown>,
  ): Promise<CommandRow | null> {
    const admin = this.supabase.getAdminClient();
    const { data, error } = await admin
      .from("drawer_commands")
      .update(patch)
      .eq("id", commandId)
      .select("*")
      .maybeSingle<CommandRow>();
    if (error) {
      this.logger.warn(`markCommand ${commandId} failed: ${error.message}`);
      return null;
    }
    return data;
  }

  private toView(row: CommandRow): CommandView {
    return {
      commandId: row.id,
      controllerId: row.drawer_controller_id,
      arkId: row.ark_id,
      type: row.type,
      status: row.status,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      createdAt: row.created_at,
      publishedAt: row.published_at,
      acceptedAt: row.accepted_at,
      completedAt: row.completed_at,
      expiresAt: row.expires_at,
    };
  }
}
