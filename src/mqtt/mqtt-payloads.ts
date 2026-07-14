/**
 * MQTT payload shapes exchanged with drawer controllers.
 * See docs/ESP32_DEVICE_MVP_PLAN.md §9–§10. All payloads carry `schemaVersion`.
 */

export const SCHEMA_VERSION = 1;

export type DrawerCommandType = "DRAWER_OPEN" | "DRAWER_CLOSE" | "LIGHT_ON" | "LIGHT_OFF";

/** Backend -> device. Published to `.../command`, QoS 1, NOT retained. */
export interface CommandPayload {
  schemaVersion: number;
  commandId: string;
  type: DrawerCommandType;
  issuedAt: string;
  expiresAt: string;
  parameters: {
    /** Relative timeout the device uses for expiry (NTP-skew safe). */
    timeoutMs: number;
  };
}

export type CommandResultStatus = "ACCEPTED" | "SUCCEEDED" | "FAILED" | "REJECTED";

/** Device -> backend. Received on `.../command-result`. */
export interface CommandResultPayload {
  schemaVersion: number;
  commandId: string;
  status: CommandResultStatus;
  actualState?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
  completedAt?: string;
}

/** Device -> backend, retained. Received on `.../state`. */
export interface StatePayload {
  schemaVersion: number;
  drawerState?: string;
  lightState?: string;
  lockState?: string;
  sensorState?: Record<string, unknown>;
  bootId?: string;
  timestamp?: string;
}

/** Device -> backend, retained. Received on `.../presence`. Also the LWT. */
export interface PresencePayload {
  schemaVersion: number;
  status: "ONLINE" | "OFFLINE";
  bootId?: string;
  firmwareVersion?: string;
  timestamp?: string;
}

/** Device -> backend. Received on `.../event`. */
export interface EventPayload {
  schemaVersion: number;
  eventType: string;
  severity?: "INFO" | "WARNING" | "ERROR" | "CRITICAL";
  payload?: Record<string, unknown>;
  timestamp?: string;
}

/** Safe JSON parse — never throws; returns null for malformed input. */
export function safeParseJson<T = unknown>(raw: string | Buffer): T | null {
  try {
    const text = typeof raw === "string" ? raw : raw.toString("utf8");
    if (!text.trim()) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
