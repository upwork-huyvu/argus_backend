/**
 * MQTT topic tree — see docs/ESP32_DEVICE_MVP_PLAN.md §9.1.
 *
 *   argus/v1/controllers/{controllerId}/{leaf}
 *
 * Backend PUBLISHES `command`; SUBSCRIBES the device output leaves.
 */

export const TOPIC_PREFIX = "argus/v1/controllers";

export type DeviceLeaf = "command-result" | "state" | "presence" | "event";

/** Leaves the backend subscribes to (everything the device publishes). */
export const SUBSCRIBED_LEAVES: DeviceLeaf[] = [
  "command-result",
  "state",
  "presence",
  "event",
];

export function commandTopic(controllerId: string): string {
  return `${TOPIC_PREFIX}/${controllerId}/command`;
}

export function presenceTopic(controllerId: string): string {
  return `${TOPIC_PREFIX}/${controllerId}/presence`;
}

/** Wildcard subscription for a given device-output leaf across all controllers. */
export function subscriptionFilter(leaf: DeviceLeaf): string {
  return `${TOPIC_PREFIX}/+/${leaf}`;
}

/**
 * Parse an incoming topic back into `{ controllerId, leaf }`.
 * Returns null for anything that does not match the expected shape.
 */
export function parseTopic(topic: string): { controllerId: string; leaf: string } | null {
  const parts = topic.split("/");
  // argus / v1 / controllers / {controllerId} / {leaf}
  if (parts.length !== 5) return null;
  if (parts[0] !== "argus" || parts[1] !== "v1" || parts[2] !== "controllers") return null;
  const controllerId = parts[3];
  const leaf = parts[4];
  if (!controllerId || !leaf) return null;
  return { controllerId, leaf };
}
