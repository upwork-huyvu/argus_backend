import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CommandView = {
  /** True when this is the stored result of an earlier identical Idempotency-Key. */
  replayed?: boolean;
  /** True when this duplicate was folded into a command already in flight. */
  coalesced?: boolean;
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
   * PUBACK != success.
   *
   * `Idempotency-Key` is OPTIONAL and must be a UUID when present:
   *  - sent  → a retry of the same intent replays that command instead of
   *            running the motor twice (`replayed: true` in the response).
   *  - absent → the server generates one; there is then no way to recognise a
   *            client retry, so coalesceInFlight() is the only duplicate guard.
   */
  async createCommand(
    user: { userId: string; role: UserRole },
    arkId: string,
    controllerId: string,
    idempotencyKey: string | undefined,
    dto: CreateDrawerCommandDto,
  ): Promise<CommandView> {
    if (!ROLE_PERMISSIONS[user.role].canControlDrone) {
      throw new ApiException(403, "FORBIDDEN", "Your role cannot control drawers.");
    }
    if (!DRAWER_COMMAND_TYPES.includes(dto.type)) {
      throw new ApiException(400, "INVALID_COMMAND_TYPE", "Unsupported command type.");
    }

    // A key must be globally unique per intent. Rejecting non-UUIDs stops the
    // classic footgun of a constant like "1", which silently binds that key to
    // the first command forever and makes every later call replay it.
    const supplied = idempotencyKey?.trim();
    if (supplied && !UUID_RE.test(supplied)) {
      throw new ApiException(
        400,
        "INVALID_IDEMPOTENCY_KEY",
        `Idempotency-Key must be a UUID (got '${supplied}'). Generate a fresh one per command, or omit the header and the server will.`,
      );
    }
    const clientKeyed = !!supplied;
    const idem = supplied ?? randomUUID();

    const admin = this.supabase.getAdminClient();

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

    // A caller-supplied key identifies one intent: replay it rather than
    // actuating twice.
    if (clientKeyed) {
      const existing = await this.findByIdempotencyKey(controllerId, idem);
      if (existing) {
        // Reusing a key for a different command would silently return the wrong
        // one — the caller would think their DRAWER_CLOSE ran while nothing was
        // sent. Reject (same rule as Stripe). expiresInSeconds is only a TTL
        // hint and is deliberately not part of the identity.
        if (existing.type !== dto.type) {
          throw new ApiException(
            409,
            "IDEMPOTENCY_KEY_REUSED",
            `Idempotency-Key '${idem}' was already used for ${existing.type} (command ${existing.id}). Generate a new UUID for ${dto.type}.`,
          );
        }
        // Never published ⇒ nothing was actuated ⇒ safe to re-arm and retry, so
        // a transient CONTROLLER_OFFLINE doesn't poison the key forever.
        if (!this.neverReachedDevice(existing)) {
          return { ...this.toView(existing), replayed: true };
        }
        const rearmed = await this.markCommand(existing.id, {
          status: "PENDING",
          error_code: null,
          error_message: null,
          completed_at: null,
          expires_at: expiresAt,
        });
        if (!rearmed) throw new ApiException(500, "COMMAND_FAILED", "Unable to retry command.");
        this.logger.log(`retrying command ${existing.id} (never published) under the same key`);
        return this.publishAndMark(rearmed, controllerId, dto, expiresAt, now);
      }
    }

    // NOTE: we deliberately do NOT refuse a command because the stored state
    // already matches it. That state is only what the device last reported, and
    // a drawer can be opened or closed BY HAND — so "already OPEN" in the DB is
    // not proof the caller's intent is pointless, and refusing would leave the
    // user unable to command a drawer whose real position drifted from ours.
    // The device is the authority: it no-ops safely (reports SUCCEEDED without
    // touching the motor) when it is already in the target state.

    // Duplicate guard that works even with no client key: if the same command
    // type is already unresolved for this controller, hand back that one rather
    // than publishing a second and running the motor again.
    const inFlight = await this.coalesceInFlight(controllerId, dto.type);
    if (inFlight) {
      this.logger.log(`coalescing duplicate ${dto.type} into in-flight command ${inFlight.id}`);
      return { ...this.toView(inFlight), coalesced: true };
    }

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

    if (insErr) throw new ApiException(500, "COMMAND_FAILED", insErr.message);
    if (!created) throw new ApiException(500, "COMMAND_FAILED", "Unable to create command.");

    return this.publishAndMark(created, controllerId, dto, expiresAt, now);
  }

  /**
   * Online-check → publish → record the outcome. Shared by the fresh-command and
   * the same-key retry paths so both fail and succeed identically.
   */
  private async publishAndMark(
    command: CommandRow,
    controllerId: string,
    dto: CreateDrawerCommandDto,
    expiresAt: string,
    now: number,
  ): Promise<CommandView> {
    // Fail fast if the controller is not online — do NOT rely on broker queueing.
    // Skippable via DRAWER_SKIP_ONLINE_CHECK for bring-up/debug.
    if (!this.skipOnlineCheck && !this.mqtt.isControllerOnline(controllerId)) {
      const updated = await this.markCommand(command.id, {
        status: "FAILED",
        error_code: "CONTROLLER_OFFLINE",
        error_message:
          "Controller is offline. Set DRAWER_SKIP_ONLINE_CHECK=true to publish anyway.",
        completed_at: new Date().toISOString(),
      });
      return this.toView(updated ?? command);
    }

    // Publish (QoS 1). PUBACK is transport-only; status becomes PUBLISHED, not SUCCEEDED.
    try {
      await this.mqtt.publishCommand(controllerId, {
        schemaVersion: SCHEMA_VERSION,
        commandId: command.id,
        type: dto.type,
        issuedAt: new Date(now).toISOString(),
        expiresAt,
        parameters: { timeoutMs: MOVEMENT_TIMEOUT_MS[dto.type] },
      });
      const published = await this.markCommand(command.id, {
        status: "PUBLISHED",
        published_at: new Date().toISOString(),
      });
      return this.toView(published ?? command);
    } catch (e) {
      this.logger.error(`publish failed for command ${command.id}: ${String(e)}`);
      const failed = await this.markCommand(command.id, {
        status: "FAILED",
        error_code: "PUBLISH_FAILED",
        error_message: "Failed to publish command to broker.",
        completed_at: new Date().toISOString(),
      });
      return this.toView(failed ?? command);
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

  /** Not yet resolved: the device may still act on it. */
  private static readonly IN_FLIGHT_STATES = ["PENDING", "PUBLISHED", "ACCEPTED"];

  /**
   * True when this command definitively never got to the ESP32: it failed before
   * any publish (published_at is null). Retrying cannot double-actuate anything,
   * so the key may be reused. A command that WAS published is never retried —
   * the device may already have run the motor.
   */
  private neverReachedDevice(row: CommandRow): boolean {
    return row.published_at === null && (row.status === "FAILED" || row.status === "EXPIRED");
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

  /**
   * The duplicate-actuation guard, now that callers no longer send an
   * Idempotency-Key. If an identical command type is still unresolved for this
   * controller, a second request is almost certainly the same intent arriving
   * twice (client retry after a lost response, or a double-tap) — return the
   * live command instead of publishing another one and running the motor again.
   *
   * Scoped to unresolved commands only, so a deliberate OPEN → CLOSE → OPEN
   * sequence still works: each one resolves before the next is issued.
   */
  private async coalesceInFlight(
    controllerId: string,
    type: DrawerCommandType,
  ): Promise<CommandRow | null> {
    const admin = this.supabase.getAdminClient();
    const { data } = await admin
      .from("drawer_commands")
      .select("*")
      .eq("drawer_controller_id", controllerId)
      .eq("type", type)
      .in("status", DrawerCommandsService.IN_FLIGHT_STATES)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
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
