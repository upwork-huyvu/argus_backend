import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { connect, type MqttClient } from "mqtt";
import { MqttMessageHandlerService } from "./mqtt-message-handler.service";
import {
  commandTopic,
  leafTopic,
  parseTopic,
  RETAINED_LEAVES,
  SUBSCRIBED_LEAVES,
  subscriptionFilter,
} from "./mqtt-topics";
import { safeParseJson, type CommandPayload, type PresencePayload } from "./mqtt-payloads";

/**
 * Singleton MQTT client for the backend. See docs/ESP32_DEVICE_MVP_PLAN.md §13.
 *
 * Responsibilities:
 *  - Connect + auto-reconnect; (re)subscribe device-output leaves on every connect.
 *  - Publish commands (QoS 1, not retained).
 *  - Track per-controller presence in memory for command fail-fast. Presence &
 *    state are retained on the broker, so the map repopulates after a restart.
 *  - Never crash the process on malformed messages.
 */
@Injectable()
export class MqttService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MqttService.name);
  private client: MqttClient | null = null;

  /** `lastSeen` is diagnostics only — liveness comes from `online`. See isControllerOnline(). */
  private readonly presence = new Map<string, { online: boolean; lastSeen: number }>();

  constructor(
    private readonly config: ConfigService,
    private readonly handler: MqttMessageHandlerService,
  ) {}

  onModuleInit(): void {
    // `|| default` (not `??`) so an empty MQTT_URL="" also falls back.
    const url = (this.config.get<string>("MQTT_URL") ?? "").trim() || "mqtt://localhost:1883";
    const clientId =
      (this.config.get<string>("MQTT_BACKEND_CLIENT_ID") ?? "").trim() ||
      `argus-backend-${process.pid}`;
    const username = this.config.get<string>("MQTT_USERNAME") || undefined;
    const password = this.config.get<string>("MQTT_PASSWORD") || undefined;

    // A malformed URL makes mqtt.connect() throw synchronously — don't take the
    // whole app down over it. Require an explicit scheme (e.g. mqtt://host:1883,
    // mqtts://host:8883 for TLS brokers like EMQX Cloud).
    if (!/^(mqtts?|wss?|tcp|tls):\/\//.test(url)) {
      this.logger.error(
        `MQTT_URL '${url}' is missing a protocol scheme — expected e.g. ` +
          `mqtt://host:1883 or mqtts://host:8883. MQTT disabled; commands will ` +
          `fail as CONTROLLER_OFFLINE until this is fixed.`,
      );
      return;
    }

    try {
      this.client = connect(url, {
        clientId,
        username,
        password,
        clean: true,
        reconnectPeriod: 5000,
        connectTimeout: 10_000,
      });
    } catch (e) {
      this.logger.error(
        `MQTT init failed for '${url}': ${e instanceof Error ? e.message : String(e)}. MQTT disabled.`,
      );
      return;
    }

    this.client.on("connect", () => {
      this.logger.log(`MQTT connected as ${clientId} -> ${url}`);
      this.subscribeAll();
    });
    this.client.on("reconnect", () => this.logger.warn("MQTT reconnecting…"));
    this.client.on("close", () => this.logger.warn("MQTT connection closed"));
    this.client.on("error", (err) => this.logger.error(`MQTT error: ${err.message}`));
    this.client.on("message", (topic, payload) => {
      // Never let a bad message bubble up and crash the client.
      this.onMessage(topic, payload).catch((e) =>
        this.logger.error(`message handler threw: ${e instanceof Error ? e.message : String(e)}`),
      );
    });
  }

  onModuleDestroy(): void {
    this.client?.end(true);
  }

  // ---------------------------------------------------------------------------

  private subscribeAll(): void {
    for (const leaf of SUBSCRIBED_LEAVES) {
      const filter = subscriptionFilter(leaf);
      this.client?.subscribe(filter, { qos: 1 }, (err) => {
        if (err) this.logger.error(`subscribe ${filter} failed: ${err.message}`);
        else this.logger.log(`subscribed ${filter}`);
      });
    }
  }

  private async onMessage(topic: string, payload: Buffer): Promise<void> {
    const parsed = parseTopic(topic);
    if (!parsed) {
      this.logger.warn(`Unparseable topic '${topic}' — ignored`);
      return;
    }
    const { controllerId, leaf } = parsed;
    this.markSeen(controllerId, leaf, payload);
    await this.handler.handle(controllerId, leaf, payload);
  }

  /** Update the in-memory liveness map from an inbound message. */
  private markSeen(controllerId: string, leaf: string, payload: Buffer): void {
    const entry = this.presence.get(controllerId) ?? { online: false, lastSeen: 0 };
    entry.lastSeen = Date.now();
    // Liveness is driven ONLY by presence (authoritative + retained LWT). Other
    // leaves must not flip a device "online": a retained `state` redelivered on
    // subscribe after a backend restart would otherwise mask a dead device and
    // defeat command fail-fast.
    if (leaf === "presence") {
      const p = safeParseJson<PresencePayload>(payload);
      entry.online = p?.status === "ONLINE";
    }
    this.presence.set(controllerId, entry);
  }

  /**
   * Presence-driven liveness. MQTT presence + the retained OFFLINE Last Will are
   * the authority — when the device drops, the broker publishes the will and we
   * flip to offline here.
   *
   * Deliberately NOT gated on "recent traffic": an idle-but-connected controller
   * publishes nothing for minutes (MQTT keepalive is device↔broker only and
   * never reaches the backend), so a freshness window reports a perfectly
   * healthy drawer as offline and refuses every command.
   *
   * Trade-off: a hung device whose TCP stays open still looks online, so a
   * command gets published and then EXPIREs via the reconciler — visible and
   * safe, unlike a false SUCCEEDED. Re-introducing a staleness window requires
   * the firmware to publish a periodic heartbeat first.
   */
  isControllerOnline(controllerId: string): boolean {
    return this.presence.get(controllerId)?.online ?? false;
  }

  get connected(): boolean {
    return this.client?.connected ?? false;
  }

  /**
   * Wipe a controller's retained presence/state from the broker.
   *
   * Retained messages outlive the device AND the database row: deleting a
   * controller without this leaves the broker serving a stale
   * `{"drawerState":"OPEN"}` for that id forever, and every future subscriber
   * (including a restarted backend) is handed that ghost on connect. Publishing
   * a zero-length retained payload is the MQTT way to clear it.
   *
   * Best-effort: never blocks the delete if the broker is unreachable.
   */
  async clearRetained(controllerId: string): Promise<void> {
    this.presence.delete(controllerId);
    if (!this.client?.connected) {
      this.logger.warn(`clearRetained(${controllerId}) skipped — MQTT not connected`);
      return;
    }
    await Promise.all(
      RETAINED_LEAVES.map(
        (leaf) =>
          new Promise<void>((resolve) => {
            this.client!.publish(
              leafTopic(controllerId, leaf),
              "", // empty payload + retain = delete the retained message
              { qos: 1, retain: true },
              (err) => {
                if (err) this.logger.warn(`clearRetained ${leaf} failed: ${err.message}`);
                resolve();
              },
            );
          }),
      ),
    );
    this.logger.log(`cleared retained presence/state for ${controllerId}`);
  }

  /**
   * Publish a command (QoS 1, not retained). Resolves once the broker PUBACKs.
   * PUBACK is transport-level only — it is NOT execution success.
   */
  publishCommand(controllerId: string, payload: CommandPayload): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.client || !this.client.connected) {
        reject(new Error("MQTT client not connected"));
        return;
      }
      this.client.publish(
        commandTopic(controllerId),
        JSON.stringify(payload),
        { qos: 1, retain: false },
        (err) => (err ? reject(err) : resolve()),
      );
    });
  }
}
