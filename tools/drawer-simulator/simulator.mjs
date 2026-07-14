// =============================================================================
// ESP32 drawer-controller simulator (plan §15 Phase 3).
// Exercises the backend with the SAME registration + MQTT contract as firmware,
// so the whole flow is testable without hardware.
//
// Run from the ArgusBE repo root (uses its node_modules `mqtt`):
//   node tools/drawer-simulator/simulator.mjs
//
// Env overrides:
//   API_BASE_URL       default http://localhost:3333
//   CONTROLLER_API_KEY default prototype-shared-controller-key
//   MQTT_URL           default mqtt://localhost:1883
//   MAC                default AABBCCDDEEF0   (12 hex, uppercase)
//   FAIL_MODE          one of: none | fail | timeout | duplicate   (default none)
//   MOVE_MS            simulated drawer travel time (default 1200)
// =============================================================================

import mqtt from "mqtt";

const API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:3333";
const CONTROLLER_API_KEY = process.env.CONTROLLER_API_KEY ?? "prototype-shared-controller-key";
const MQTT_URL = process.env.MQTT_URL ?? "mqtt://localhost:1883";
const MAC = (process.env.MAC ?? "AABBCCDDEEF0").toUpperCase();
const FAIL_MODE = process.env.FAIL_MODE ?? "none";
const MOVE_MS = Number(process.env.MOVE_MS ?? 1200);
const BOOT_ID = Math.random().toString(16).slice(2, 18);

const state = { drawer: "UNKNOWN", light: "OFF" };
const seen = new Set();

const log = (...a) => console.log(`[sim ${MAC}]`, ...a);

async function register() {
  const url = `${API_BASE_URL}/drawer-provisioning/${MAC}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-Controller-Key": CONTROLLER_API_KEY },
    body: JSON.stringify({
      serialNumber: "SIM-0001",
      controllerType: "DRAWER_CONTROLLER",
      firmware: { version: "0.1.0-sim", build: new Date().toISOString().slice(0, 10) },
      capabilities: ["DRAWER_OPEN", "DRAWER_CLOSE", "LIGHT_ON", "LIGHT_OFF", "DRAWER_SENSOR"],
      network: { ipAddress: "127.0.0.1", wifiRssi: -50 },
      boot: { bootId: BOOT_ID, resetReason: "POWER_ON" },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`register failed ${res.status}: ${JSON.stringify(body)}`);
  }
  log(`registered -> controllerId=${body.controllerId} (${body.registrationOutcome}, ${res.status})`);
  return body.controllerId;
}

function topic(controllerId, leaf) {
  return `argus/v1/controllers/${controllerId}/${leaf}`;
}

function connectMqtt(controllerId) {
  const t = (leaf) => topic(controllerId, leaf);
  const client = mqtt.connect(MQTT_URL, {
    clientId: controllerId,
    clean: true, // cleanSession: broker must not queue stale commands
    will: {
      topic: t("presence"),
      payload: JSON.stringify({ schemaVersion: 1, status: "OFFLINE" }),
      qos: 1,
      retain: true,
    },
  });

  const pub = (leaf, obj, retain = false) =>
    client.publish(t(leaf), JSON.stringify({ schemaVersion: 1, ...obj }), { qos: 1, retain });

  const publishState = () =>
    pub("state", { drawerState: state.drawer, lightState: state.light, bootId: BOOT_ID }, true);

  client.on("connect", () => {
    log("mqtt connected");
    client.subscribe(t("command"), { qos: 1 });
    pub("presence", { status: "ONLINE", bootId: BOOT_ID, firmwareVersion: "0.1.0-sim" }, true);
    publishState();
  });

  client.on("message", (_topic, payload) => {
    let cmd;
    try {
      cmd = JSON.parse(payload.toString());
    } catch {
      log("bad JSON command — ignored");
      return;
    }
    handleCommand(client, pub, publishState, cmd);
  });

  client.on("error", (e) => log("mqtt error:", e.message));
  return client;
}

function handleCommand(client, pub, publishState, cmd) {
  const { commandId, type, expiresAt } = cmd;
  if (!commandId || !type) return;

  if (seen.has(commandId)) {
    log(`duplicate ${commandId} — ignored (no re-actuate)`);
    return;
  }
  seen.add(commandId);

  if (expiresAt && Date.now() > Date.parse(expiresAt)) {
    pub("command-result", { commandId, status: "REJECTED", errorCode: "EXPIRED" });
    return;
  }

  // FAIL_MODE=timeout: accept but never report a terminal result (backend reconciler
  // should EXPIRE it). FAIL_MODE=duplicate: emit SUCCEEDED twice (backend must dedup).
  if (type === "LIGHT_ON" || type === "LIGHT_OFF") {
    state.light = type === "LIGHT_ON" ? "ON" : "OFF";
    pub("command-result", { commandId, status: "ACCEPTED" });
    pub("command-result", { commandId, status: "SUCCEEDED", actualState: { ...state } });
    publishState();
    return;
  }

  // Drawer movement.
  pub("command-result", { commandId, status: "ACCEPTED" });
  const target = type === "DRAWER_OPEN" ? "OPEN" : "CLOSED";
  if (FAIL_MODE === "timeout") {
    log(`${type} accepted, simulating hang (no result)`);
    return;
  }
  setTimeout(() => {
    if (FAIL_MODE === "fail") {
      pub("command-result", { commandId, status: "FAILED", errorCode: "MOVE_TIMEOUT" });
      pub("event", { eventType: "drawer_move_timeout", severity: "ERROR" });
    } else {
      state.drawer = target;
      pub("command-result", { commandId, status: "SUCCEEDED", actualState: { ...state } });
      if (FAIL_MODE === "duplicate") {
        pub("command-result", { commandId, status: "SUCCEEDED", actualState: { ...state } });
      }
    }
    publishState();
  }, MOVE_MS);
}

(async () => {
  log(`FAIL_MODE=${FAIL_MODE} MQTT_URL=${MQTT_URL}`);
  const controllerId = await register();
  connectMqtt(controllerId);
  log("running — Ctrl+C to stop");
})().catch((e) => {
  console.error("[sim] fatal:", e.message);
  process.exit(1);
});
