// =============================================================================
// Argus ESP32 drawer controller — MVP firmware (single-file Arduino sketch).
// Implements the boot/registration/MQTT/command/state-machine contract from
// docs/ESP32_DEVICE_MVP_PLAN.md (§6 boot, §7 registration, §9 MQTT, §10 command,
// §11 safety, §12 reconnect).
//
// Prototype drives an LED in place of the drawer motor; the command/state
// contract is identical to the final hardware.
//
// Arduino IDE setup:
//   Boards Manager : "esp32 by Espressif Systems"
//   Board          : your ESP32 (e.g. "ESP32 Dev Module" / "ESP32S3 Dev Module")
//   Library Manager: MQTTPubSubClient (hideakitai), ArduinoJson (bblanchon, v7)
// =============================================================================

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <MQTTPubSubClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <time.h>

#if __has_include(<esp_mac.h>)
#include <esp_mac.h>
#else
#include <esp_system.h>
#endif

// =============================================================================
// CONFIG — fill these in. Prototype-only; rotate these before pilot/production.
// =============================================================================

// ---- Wi-Fi ------------------------------------------------------------------
#define WIFI_SSID       "your-wifi-ssid"
#define WIFI_PASSWORD   "your-wifi-password"

// ---- Backend HTTP (registration) --------------------------------------------
// Point at the machine running ArgusBE on your LAN (NOT localhost — the ESP32
// is a separate host). CONTROLLER_API_KEY must match the backend's env.
#define API_BASE_URL        "http://192.168.1.100:3333"
#define CONTROLLER_API_KEY  "your-controller-key"

// ---- MQTT -------------------------------------------------------------------
// Defaults target EMQX Cloud Serverless (TLS on 8883), same broker the backend
// connects to. For a local plaintext broker set MQTT_USE_TLS 0 and MQTT_PORT 1883.
#define MQTT_USE_TLS    1
#define MQTT_HOST       "your-broker.example.com"
#define MQTT_PORT       8883
#define MQTT_USERNAME   "your-mqtt-user"
#define MQTT_PASSWORD   "your-mqtt-password"

// ---- Identity / metadata ----------------------------------------------------
#define CONTROLLER_SERIAL   "ARGUS-ESP32-001" // metadata only; NOT unique in MVP
#define CONTROLLER_TYPE     "DRAWER_CONTROLLER"
#define FIRMWARE_VERSION    "0.1.0"
#define FIRMWARE_BUILD      __DATE__

// Optional: override the eFuse MAC (12 hex, uppercase, no separators) for
// simulator/bench testing. Leave empty to use the real base MAC.
#define MAC_OVERRIDE    ""

// ---- GPIO -------------------------------------------------------------------
// Prototype: drive an LED in place of the drawer motor. Relay/motor driver +
// limit switches get wired in Phase 7.
#define PIN_DRAWER_MOTOR    2   // relay / motor driver enable (LED on many boards)
#define PIN_LIGHT           4   // light relay / LED
#define PIN_LIMIT_OPEN      18  // limit switch: fully open  (active LOW, INPUT_PULLUP)
#define PIN_LIMIT_CLOSED    19  // limit switch: fully closed (active LOW, INPUT_PULLUP)

// Set true once real limit switches are wired. When false, movement is
// simulated by SIMULATE_MOVE_MS so the flow is testable with an LED.
#define LIMIT_SWITCHES_ENABLED  false
#define SIMULATE_MOVE_MS        1500

// ---- Timing -----------------------------------------------------------------
#define BACKOFF_START_MS    5000UL
#define BACKOFF_MAX_MS      300000UL
#define BACKOFF_JITTER_MS   3000UL

// NTP lets the device honor absolute expiresAt. Relative timeoutMs is always
// used for movement; absolute expiry is only enforced once time is valid.
#define NTP_ENABLED         true
#define NTP_SERVER          "pool.ntp.org"

// =============================================================================
// STATE
// =============================================================================
#if MQTT_USE_TLS
static WiFiClientSecure netClient;
#else
static WiFiClient netClient;
#endif
// MQTTPubSubClient with a 512-byte buffer (command payloads exceed 256).
static MQTTPubSub::PubSubClient<512> mqtt;
static Preferences prefs;

static String macAddress;   // normalized 12-hex uppercase
static String controllerId; // assigned by backend, persisted in NVS
static String bootId;       // random per boot

enum DrawerState { DS_UNKNOWN, DS_CLOSED, DS_OPENING, DS_OPEN, DS_CLOSING, DS_BLOCKED, DS_FAULT };
static DrawerState drawerState = DS_UNKNOWN;
static bool lightOn = false;

// One in-flight movement at a time (never open + close simultaneously).
static bool moving = false;
static String activeCommandId;
static String activeType;
static uint32_t moveStartMs = 0;
static uint32_t moveTimeoutMs = 8000;

// Command dedup ring buffer — don't re-actuate a repeated commandId.
static const int RECENT_MAX = 8;
static String recentIds[RECENT_MAX];
static int recentIdx = 0;

// MQTT reconnect backoff.
static uint32_t mqttBackoffMs = BACKOFF_START_MS;
static uint32_t mqttNextAttemptMs = 0;

// =============================================================================
// HELPERS
// =============================================================================
static String topic(const char *leaf) {
  return String("argus/v1/controllers/") + controllerId + "/" + leaf;
}

static String readBaseMac() {
  if (strlen(MAC_OVERRIDE) == 12) return String(MAC_OVERRIDE);
  uint8_t mac[6] = {0};
  esp_efuse_mac_get_default(mac);
  char buf[13];
  snprintf(buf, sizeof(buf), "%02X%02X%02X%02X%02X%02X",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  return String(buf);
}

static String genBootId() {
  char buf[17];
  uint32_t a = esp_random(), b = esp_random();
  snprintf(buf, sizeof(buf), "%08X%08X", a, b);
  return String(buf);
}

static bool isDuplicate(const String &id) {
  for (int i = 0; i < RECENT_MAX; i++)
    if (recentIds[i] == id) return true;
  return false;
}
static void rememberId(const String &id) {
  recentIds[recentIdx] = id;
  recentIdx = (recentIdx + 1) % RECENT_MAX;
}

static const char *drawerStateName(DrawerState s) {
  switch (s) {
    case DS_CLOSED: return "CLOSED";
    case DS_OPENING: return "OPENING";
    case DS_OPEN: return "OPEN";
    case DS_CLOSING: return "CLOSING";
    case DS_BLOCKED: return "BLOCKED";
    case DS_FAULT: return "FAULT";
    default: return "UNKNOWN";
  }
}

static bool timeValid() { return time(nullptr) > 1700000000; }

// Parse "YYYY-MM-DDTHH:MM:SSZ" to epoch seconds (UTC). Returns 0 on failure.
static time_t parseIso8601(const char *iso) {
  int y, mo, d, h, mi, s;
  if (sscanf(iso, "%d-%d-%dT%d:%d:%d", &y, &mo, &d, &h, &mi, &s) != 6) return 0;
  static const int cum[] = {0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334};
  long days = (long)(y - 1970) * 365 + (y - 1969) / 4;
  days += cum[mo - 1];
  if (mo > 2 && (y % 4 == 0 && (y % 100 != 0 || y % 400 == 0))) days += 1;
  days += (d - 1);
  return (time_t)days * 86400 + h * 3600 + mi * 60 + s;
}

// =============================================================================
// SAFE STATE
// =============================================================================
static void gpioSafeState() {
  pinMode(PIN_DRAWER_MOTOR, OUTPUT);
  pinMode(PIN_LIGHT, OUTPUT);
  digitalWrite(PIN_DRAWER_MOTOR, LOW); // motor off
  digitalWrite(PIN_LIGHT, LOW);        // light off
#if LIMIT_SWITCHES_ENABLED
  pinMode(PIN_LIMIT_OPEN, INPUT_PULLUP);
  pinMode(PIN_LIMIT_CLOSED, INPUT_PULLUP);
#endif
  drawerState = DS_UNKNOWN; // never assume position after boot
  lightOn = false;
  moving = false;
}

// =============================================================================
// WIFI
// =============================================================================
static bool ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) return true;
  Serial.printf("[wifi] connecting to %s\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
    delay(250);
    Serial.print(".");
  }
  Serial.println();
  bool ok = WiFi.status() == WL_CONNECTED;
  if (ok) Serial.printf("[wifi] connected, ip=%s\n", WiFi.localIP().toString().c_str());
  return ok;
}

// =============================================================================
// REGISTRATION (plan §7)
// Returns: 1 ok, 0 retryable error, -1 fatal (disabled) — caller halts.
// =============================================================================
static int tryRegister() {
  String url = String(API_BASE_URL) + "/drawer-provisioning/" + macAddress;

  JsonDocument body;
  body["serialNumber"] = CONTROLLER_SERIAL;
  body["controllerType"] = CONTROLLER_TYPE;
  JsonObject fw = body["firmware"].to<JsonObject>();
  fw["version"] = FIRMWARE_VERSION;
  fw["build"] = FIRMWARE_BUILD;
  JsonArray caps = body["capabilities"].to<JsonArray>();
  caps.add("DRAWER_OPEN");
  caps.add("DRAWER_CLOSE");
  caps.add("LIGHT_ON");
  caps.add("LIGHT_OFF");
  caps.add("DRAWER_SENSOR");
  JsonObject net = body["network"].to<JsonObject>();
  net["ipAddress"] = WiFi.localIP().toString();
  net["wifiRssi"] = WiFi.RSSI();
  JsonObject boot = body["boot"].to<JsonObject>();
  boot["bootId"] = bootId;
  boot["resetReason"] = "POWER_ON";

  String payload;
  serializeJson(body, payload);

  HTTPClient http;
  http.begin(url); // http:// on LAN; for https use http.begin(secureClient, url)
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Controller-Key", CONTROLLER_API_KEY);
  int code = http.PUT((uint8_t *)payload.c_str(), payload.length());
  String resp = http.getString();
  http.end();

  Serial.printf("[register] PUT %s -> %d\n", url.c_str(), code);

  if (code == 423) { Serial.println("[register] DEVICE_DISABLED — halting"); return -1; }
  if (code != 200 && code != 201) {
    Serial.printf("[register] retryable (%d) %s\n", code, resp.c_str());
    return 0;
  }

  JsonDocument doc;
  if (deserializeJson(doc, resp)) { Serial.println("[register] bad JSON"); return 0; }
  const char *cid = doc["controllerId"];
  if (!cid) { Serial.println("[register] missing controllerId"); return 0; }

  controllerId = String(cid);
  prefs.putString("controllerId", controllerId);
  Serial.printf("[register] controllerId=%s outcome=%s\n", controllerId.c_str(),
                (const char *)(doc["registrationOutcome"] | ""));
  return 1;
}

static void registerWithBackoff() {
  uint32_t backoff = BACKOFF_START_MS;
  while (true) {
    if (ensureWifi()) {
      int r = tryRegister();
      if (r == 1) return;
      if (r == -1) { while (true) delay(1000); } // disabled: stop here
    }
    uint32_t wait = backoff + (esp_random() % BACKOFF_JITTER_MS);
    Serial.printf("[register] retry in %lums\n", (unsigned long)wait);
    delay(wait);
    backoff = min(backoff * 2, BACKOFF_MAX_MS);
  }
}

// =============================================================================
// MQTT PUBLISH HELPERS
// =============================================================================
static void publishPresence(bool online) {
  JsonDocument doc;
  doc["schemaVersion"] = 1;
  doc["status"] = online ? "ONLINE" : "OFFLINE";
  doc["bootId"] = bootId;
  doc["firmwareVersion"] = FIRMWARE_VERSION;
  String out;
  serializeJson(doc, out);
  mqtt.publish(topic("presence"), out, true /* retain */, 1 /* qos */);
}

static void publishState() {
  JsonDocument doc;
  doc["schemaVersion"] = 1;
  doc["drawerState"] = drawerStateName(drawerState);
  doc["lightState"] = lightOn ? "ON" : "OFF";
  doc["bootId"] = bootId;
  String out;
  serializeJson(doc, out);
  mqtt.publish(topic("state"), out, true /* retain */, 1 /* qos */);
}

static void publishResult(const String &commandId, const char *status, const char *errorCode) {
  JsonDocument doc;
  doc["schemaVersion"] = 1;
  doc["commandId"] = commandId;
  doc["status"] = status;
  JsonObject st = doc["actualState"].to<JsonObject>();
  st["drawer"] = drawerStateName(drawerState);
  st["light"] = lightOn ? "ON" : "OFF";
  if (errorCode) doc["errorCode"] = errorCode;
  String out;
  serializeJson(doc, out);
  mqtt.publish(topic("command-result"), out, false /* retain */, 1 /* qos */);
}

static void publishEvent(const char *eventType, const char *severity) {
  JsonDocument doc;
  doc["schemaVersion"] = 1;
  doc["eventType"] = eventType;
  doc["severity"] = severity;
  String out;
  serializeJson(doc, out);
  mqtt.publish(topic("event"), out, false /* retain */, 1 /* qos */);
}

// =============================================================================
// MOVEMENT
// =============================================================================
static void startMovement(const String &commandId, const String &type, uint32_t timeoutMs) {
  moving = true;
  activeCommandId = commandId;
  activeType = type;
  moveStartMs = millis();
  moveTimeoutMs = timeoutMs;
  drawerState = (type == "DRAWER_OPEN") ? DS_OPENING : DS_CLOSING;
  digitalWrite(PIN_DRAWER_MOTOR, HIGH); // motor running
  publishResult(commandId, "ACCEPTED", nullptr);
  publishState();
}

static void finishMovement(bool success) {
  digitalWrite(PIN_DRAWER_MOTOR, LOW); // motor off (safe)
  if (success) {
    drawerState = (activeType == "DRAWER_OPEN") ? DS_OPEN : DS_CLOSED;
    publishResult(activeCommandId, "SUCCEEDED", nullptr);
  } else {
    drawerState = DS_FAULT;
    publishResult(activeCommandId, "FAILED", "MOVE_TIMEOUT");
    publishEvent("drawer_move_timeout", "ERROR");
  }
  publishState();
  moving = false;
  activeCommandId = "";
  activeType = "";
}

static void serviceMovement() {
  if (!moving) return;
  uint32_t elapsed = millis() - moveStartMs;

#if LIMIT_SWITCHES_ENABLED
  bool reached = (activeType == "DRAWER_OPEN") ? (digitalRead(PIN_LIMIT_OPEN) == LOW)
                                               : (digitalRead(PIN_LIMIT_CLOSED) == LOW);
  if (reached) { finishMovement(true); return; }
#else
  if (elapsed >= SIMULATE_MOVE_MS) { finishMovement(true); return; } // prototype (LED)
#endif

  if (elapsed >= moveTimeoutMs) finishMovement(false); // hard timeout -> FAULT
}

// =============================================================================
// COMMAND HANDLING (plan §10.2)
// =============================================================================
static void handleCommand(const String &raw) {
  JsonDocument doc;
  if (deserializeJson(doc, raw)) { Serial.println("[cmd] bad JSON — ignored"); return; }

  int schema = doc["schemaVersion"] | 0;
  const char *cid = doc["commandId"];
  const char *type = doc["type"];
  if (schema != 1 || !cid || !type) {
    Serial.println("[cmd] missing/unsupported fields — ignored");
    return;
  }
  String commandId = String(cid);
  String cmdType = String(type);

  // Dedup — never re-actuate the same commandId (QoS1 duplicate / redelivery).
  if (isDuplicate(commandId)) { Serial.printf("[cmd] duplicate %s — ignored\n", cid); return; }

  // Absolute-expiry reject, only when NTP time is trustworthy. Movement timeout
  // (timeoutMs) is the primary, clock-independent guard.
  const char *expiresAt = doc["expiresAt"];
  if (timeValid() && expiresAt) {
    time_t exp = parseIso8601(expiresAt);
    if (exp > 0 && time(nullptr) > exp) {
      rememberId(commandId);
      publishResult(commandId, "REJECTED", "EXPIRED");
      return;
    }
  }

  bool supported = cmdType == "DRAWER_OPEN" || cmdType == "DRAWER_CLOSE" ||
                   cmdType == "LIGHT_ON" || cmdType == "LIGHT_OFF";
  if (!supported) {
    rememberId(commandId);
    publishResult(commandId, "REJECTED", "UNSUPPORTED_TYPE");
    return;
  }

  rememberId(commandId);
  uint32_t timeoutMs = doc["parameters"]["timeoutMs"] | 8000;

  // Light commands are instantaneous.
  if (cmdType == "LIGHT_ON" || cmdType == "LIGHT_OFF") {
    lightOn = (cmdType == "LIGHT_ON");
    digitalWrite(PIN_LIGHT, lightOn ? HIGH : LOW);
    publishResult(commandId, "ACCEPTED", nullptr);
    publishResult(commandId, "SUCCEEDED", nullptr);
    publishState();
    return;
  }

  // Drawer commands: never run while already moving (no open+close at once).
  if (moving) {
    publishResult(commandId, "REJECTED", "BUSY");
    return;
  }
  // Idempotent no-op if already in the target state.
  if ((cmdType == "DRAWER_OPEN" && drawerState == DS_OPEN) ||
      (cmdType == "DRAWER_CLOSE" && drawerState == DS_CLOSED)) {
    publishResult(commandId, "ACCEPTED", nullptr);
    publishResult(commandId, "SUCCEEDED", nullptr);
    publishState();
    return;
  }

  startMovement(commandId, cmdType, timeoutMs);
}

// =============================================================================
// MQTT CONNECT
// =============================================================================
static bool mqttConnect() {
  // (Re)establish the underlying TCP/TLS socket first — MQTTPubSubClient runs
  // on top of any Client/Stream.
  if (netClient.connected()) netClient.stop();
  if (!netClient.connect(MQTT_HOST, MQTT_PORT)) {
    Serial.println("[mqtt] socket connect failed");
    return false;
  }

  mqtt.begin(netClient);
  // Last Will: retained OFFLINE presence on ungraceful disconnect.
  mqtt.setWill(topic("presence"), "{\"schemaVersion\":1,\"status\":\"OFFLINE\"}",
               true /* retain */, 1 /* qos */);
  // cleanSession=true: broker must NOT queue stale commands for us.
  mqtt.setCleanSession(true);

  if (!mqtt.connect(controllerId, MQTT_USERNAME, MQTT_PASSWORD)) {
    Serial.println("[mqtt] MQTT connect rejected");
    return false;
  }
  Serial.println("[mqtt] connected");

  // Only the command topic is subscribed, so the payload-only callback suffices.
  mqtt.subscribe(topic("command"), 1 /* qos */,
                 [](const String &payload, const size_t) { handleCommand(payload); });

  publishPresence(true);
  publishState();
  mqttBackoffMs = BACKOFF_START_MS;
  return true;
}

// =============================================================================
// ARDUINO LIFECYCLE
// =============================================================================
void setup() {
  Serial.begin(115200);
  delay(200);
  gpioSafeState();

  prefs.begin("argus", false);
  controllerId = prefs.getString("controllerId", "");
  bootId = genBootId();
  macAddress = readBaseMac();
  Serial.printf("[boot] mac=%s bootId=%s savedControllerId=%s\n", macAddress.c_str(),
                bootId.c_str(), controllerId.c_str());

  registerWithBackoff(); // always re-register on boot (idempotent backend)

#if NTP_ENABLED
  configTime(0, 0, NTP_SERVER); // UTC; best-effort, non-blocking thereafter
#endif

#if MQTT_USE_TLS
  // Prototype: skip server-cert validation. Before pilot, pin the broker CA:
  //   netClient.setCACert(EMQX_CA_PEM);
  netClient.setInsecure();
#endif

  mqttConnect();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) ensureWifi();

  if (!netClient.connected() || !mqtt.isConnected()) {
    uint32_t now = millis();
    if (now >= mqttNextAttemptMs) {
      if (!mqttConnect()) {
        uint32_t wait = mqttBackoffMs + (esp_random() % BACKOFF_JITTER_MS);
        mqttNextAttemptMs = now + wait;
        mqttBackoffMs = min(mqttBackoffMs * 2, BACKOFF_MAX_MS);
        Serial.printf("[mqtt] retry in %lums\n", (unsigned long)wait);
      }
    }
  } else {
    mqtt.update();
  }

  serviceMovement();
}
