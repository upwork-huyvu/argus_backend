import { Injectable, Logger } from "@nestjs/common";
import { SupabaseService } from "../common/supabase/supabase.service";
import {
  safeParseJson,
  type CommandResultPayload,
  type CommandResultStatus,
  type EventPayload,
  type PresencePayload,
  type StatePayload,
} from "./mqtt-payloads";

/**
 * Persists device-originated MQTT messages into Supabase. Pure sink: it depends
 * only on SupabaseService (no MqttService / DrawerCommandsService) so the module
 * graph stays acyclic. All updates are idempotent and forward-only.
 *
 * See docs/ESP32_DEVICE_MVP_PLAN.md §8, §10.4.
 */
@Injectable()
export class MqttMessageHandlerService {
  private readonly logger = new Logger(MqttMessageHandlerService.name);

  /** Terminal command states — never transition out of these. */
  private static readonly RESULT_FROM: Record<CommandResultStatus, string[]> = {
    ACCEPTED: ["PENDING", "PUBLISHED"],
    SUCCEEDED: ["PENDING", "PUBLISHED", "ACCEPTED"],
    FAILED: ["PENDING", "PUBLISHED", "ACCEPTED"],
    REJECTED: ["PENDING", "PUBLISHED", "ACCEPTED"],
  };

  constructor(private readonly supabase: SupabaseService) {}

  /** Dispatch by topic leaf. Unknown controller/leaf is logged and ignored. */
  async handle(controllerId: string, leaf: string, raw: Buffer): Promise<void> {
    const known = await this.touchController(controllerId);
    if (!known) {
      this.logger.warn(`Message for unknown controllerId=${controllerId} (leaf=${leaf}) — ignored`);
      return;
    }

    switch (leaf) {
      case "presence":
        return this.handlePresence(controllerId, raw);
      case "state":
        return this.handleState(controllerId, raw);
      case "command-result":
        return this.handleCommandResult(controllerId, raw);
      case "event":
        return this.handleEvent(controllerId, raw);
      default:
        this.logger.warn(`Unknown leaf '${leaf}' for controllerId=${controllerId} — ignored`);
    }
  }

  // ---------------------------------------------------------------------------

  /** Bump last_seen_at; returns false when the controller does not exist. */
  private async touchController(controllerId: string): Promise<boolean> {
    const admin = this.supabase.getAdminClient();
    const { data, error } = await admin
      .from("drawer_controllers")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("id", controllerId)
      .select("id")
      .maybeSingle<{ id: string }>();
    if (error) {
      // Malformed controllerId (e.g. not a uuid) surfaces here — treat as unknown.
      this.logger.warn(`touchController failed for ${controllerId}: ${error.message}`);
      return false;
    }
    return !!data;
  }

  private async handlePresence(controllerId: string, raw: Buffer): Promise<void> {
    const p = safeParseJson<PresencePayload>(raw);
    if (!p || (p.status !== "ONLINE" && p.status !== "OFFLINE")) {
      this.logger.warn(`Malformed presence for ${controllerId} — ignored`);
      return;
    }
    await this.insertEvent(controllerId, "presence", "INFO", { status: p.status, bootId: p.bootId });
  }

  private async handleState(controllerId: string, raw: Buffer): Promise<void> {
    const s = safeParseJson<StatePayload>(raw);
    if (!s) {
      this.logger.warn(`Malformed state for ${controllerId} — ignored`);
      return;
    }
    const admin = this.supabase.getAdminClient();
    const { error } = await admin.from("drawer_state").upsert(
      {
        drawer_controller_id: controllerId,
        drawer_state: s.drawerState ?? null,
        light_state: s.lightState ?? null,
        lock_state: s.lockState ?? null,
        sensor_state: s.sensorState ?? null,
        boot_id: s.bootId ?? null,
        reported_at: s.timestamp ?? new Date().toISOString(),
        raw_payload: s as unknown as Record<string, unknown>,
      },
      { onConflict: "drawer_controller_id" },
    );
    if (error) this.logger.error(`state upsert failed for ${controllerId}: ${error.message}`);
  }

  private async handleCommandResult(controllerId: string, raw: Buffer): Promise<void> {
    const r = safeParseJson<CommandResultPayload>(raw);
    if (!r || !r.commandId || !r.status || !(r.status in MqttMessageHandlerService.RESULT_FROM)) {
      this.logger.warn(`Malformed command-result for ${controllerId} — ignored`);
      return;
    }

    const now = new Date().toISOString();
    const patch: Record<string, unknown> = { status: r.status };
    if (r.status === "ACCEPTED") patch.accepted_at = now;
    if (r.status === "SUCCEEDED" || r.status === "FAILED" || r.status === "REJECTED") {
      patch.completed_at = r.completedAt ?? now;
      if (r.errorCode) patch.error_code = r.errorCode;
      if (r.errorMessage) patch.error_message = r.errorMessage;
    }

    const allowedFrom = MqttMessageHandlerService.RESULT_FROM[r.status];
    const admin = this.supabase.getAdminClient();
    // Forward-transition + ownership guard: only update if the command belongs to
    // this controller AND is in an allowed prior state. Duplicate/stale QoS1
    // deliveries match 0 rows and are silently ignored.
    const { data, error } = await admin
      .from("drawer_commands")
      .update(patch)
      .eq("id", r.commandId)
      .eq("drawer_controller_id", controllerId)
      .in("status", allowedFrom)
      .select("id")
      .maybeSingle<{ id: string }>();

    if (error) {
      this.logger.warn(`command-result update failed for ${r.commandId}: ${error.message}`);
      return;
    }
    if (!data) {
      this.logger.debug(
        `command-result ${r.status} for ${r.commandId} ignored (stale/duplicate/unknown)`,
      );
    }
  }

  private async handleEvent(controllerId: string, raw: Buffer): Promise<void> {
    const e = safeParseJson<EventPayload>(raw);
    if (!e || !e.eventType) {
      this.logger.warn(`Malformed event for ${controllerId} — ignored`);
      return;
    }
    await this.insertEvent(
      controllerId,
      e.eventType,
      e.severity ?? "INFO",
      e.payload ?? {},
      e.timestamp,
    );
  }

  private async insertEvent(
    controllerId: string,
    eventType: string,
    severity: string,
    payload: Record<string, unknown>,
    occurredAt?: string,
  ): Promise<void> {
    const admin = this.supabase.getAdminClient();
    const { error } = await admin.from("drawer_events").insert({
      drawer_controller_id: controllerId,
      event_type: eventType,
      severity,
      payload,
      occurred_at: occurredAt ?? new Date().toISOString(),
    });
    if (error) this.logger.error(`event insert failed for ${controllerId}: ${error.message}`);
  }
}
