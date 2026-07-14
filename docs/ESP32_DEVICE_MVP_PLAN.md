# Drawer Controller (ESP32) — MVP Implementation Plan

> **Terminology note (important).** In the current codebase, "device" already
> means **drone**. The ESP32 board that controls the drawer is named
> **`drawer_controller`** (id = `controllerId`) to **avoid colliding** with the
> drone meaning (`canControlDrone`, `DRONE_ACTIONS`, DJI SDK). Do not reuse the
> word "device" for the ESP32 hardware anywhere.

## 1. Goal

Build the MVP flow for the ESP32 (drawer controller) that controls the drawer and
light of the Argus Ark:

1. ESP32 boots and connects to Wi-Fi using hardcoded config.
2. ESP32 self-registers with ArgusBE using its MAC address.
3. Backend creates a `drawer_controller` if it does not exist, or updates it if it
   does (idempotent, safe under concurrent requests).
4. Backend returns a stable `controllerId` to the ESP32.
5. ESP32 connects to MQTT using hardcoded config.
6. Backend sends open/close drawer or light on/off commands over MQTT.
7. ESP32 reports command results, drawer state, and connection status to the backend.
8. The App only talks to ArgusBE over HTTP; the App does **not** connect to MQTT directly.

The MVP prioritizes a complete end-to-end flow and testability. Per-device
certificates and credentials are deferred to a later phase.

### Entity model (canonical)

```text
app_users (owner)
   │ user_id
   ▼
arks (id text, dock_status)                 -- already exists in the repo
   │ 1 : N
   ▼
drawer_controllers (ESP32, id = controllerId)
   │ 1 : N
   ▼
drones (id, drawer_controller_id nullable)  -- NEW; null = drone in flight / unassigned
```

- **ark 1 : N drawer_controllers** — an ark may have multiple drawers/ESP32s.
- **drawer_controller 1 : N drones** — a drawer holds 1..N drones.
  `drawer_controller_id = null` when the drone is in flight or not yet assigned to a drawer.
- **MVP assumption:** one `drawer_controller` (ESP32) maps **1:1** to one physical
  drawer, so the MVP does not split out a separate `dock_drawers` table yet. If a
  controller later drives multiple drawers, split `dock_drawers` and give
  `drones.dock_drawer_id`.

## 2. MVP scope

### In scope

- ESP32 uses constants for Wi-Fi, ArgusBE URL, and MQTT config.
- Base MAC / eFuse MAC as the hardware identifier.
- Idempotent registration by MAC, **atomic UPSERT** (concurrency-safe).
- Backend generates a separate `controllerId` (UUID); MAC is not the primary key.
- One shared MQTT account for all ESP32s in the MVP environment.
- Backend sends commands over MQTT keyed by `controllerId`.
- ESP32 publishes presence, state, and command results.
- Store controller, drones, commands, and latest state in Supabase.
- **drone ↔ drawer_controller mapping** (table `drones`) for launch-gating.
- Check user permission (ownership + `canControlDrone`) before sending commands.
- An ESP32 simulator to test the backend before real hardware exists.

### Out of scope

- Mutual TLS and per-ESP32 certificates.
- Wi-Fi provisioning over BLE or SoftAP.
- OTA firmware updates.
- Automatic credential rotation.
- Broker high availability.
- App connecting to MQTT directly.
- Full drone launch control (the MVP only opens/closes the drawer + safety gate).

## 3. Architecture

```text
Mobile App
    |
    | HTTPS
    v
ArgusBE (NestJS)
    |
    +---- Supabase
    |       drawer_controllers
    |       drones
    |       drawer_commands
    |       drawer_state
    |       drawer_events
    |
    +---- MQTT client (singleton)
             |
             v
         MQTT Broker
             |
             v
         ESP32 (drawer_controller)
      drawer + light + sensors
```

Principles:

- HTTPS is used for registration and the App API.
- MQTT is used for commands, command results, presence, and state.
- ArgusBE is where authorization is checked and the audit trail is stored.
- Physical state must be **sensor-confirmed**, never inferred from relay output.
- **PUBACK ≠ success.** A command is only `SUCCEEDED` when the ESP32 confirms the real state.

## 4. Identity

### 4.1 Hardware identifier (MAC)

The MVP uses the ESP32 base MAC / eFuse MAC. The backend **normalizes** it before
lookup and **stores the normalized value**:

- Uppercase.
- Strip `:`, `-`, and whitespace.
- Validate exactly 12 hex characters (`^[0-9A-F]{12}$`).

Canonical example: `7CDFA1123456`.

### 4.2 The id types

```text
mac_address     = hardware identifier (normalized)
controllerId    = database/business id of the drawer_controller (UUID)
mqttClientId    = = controllerId
droneId         = UUID of a drone (table drones)
```

Do not use the MAC as a primary key or thread the MAC through the whole data model.

## 5. Constants on the ESP32

```cpp
#define WIFI_SSID "ArgusWifi"
#define WIFI_PASSWORD "prototype-password"

#define API_BASE_URL "http://192.168.1.100:3333"
#define CONTROLLER_API_KEY "prototype-shared-controller-key"

#define MQTT_HOST "192.168.1.100"
#define MQTT_PORT 1883
#define MQTT_USERNAME "argus-controller"
#define MQTT_PASSWORD "prototype-mqtt-password"

#define CONTROLLER_SERIAL "ARGUS-ESP32-001"   // metadata; NOT unique in the MVP
#define CONTROLLER_TYPE "DRAWER_CONTROLLER"
#define FIRMWARE_VERSION "0.1.0"
```

MAC is read from eFuse (allow overriding it with a constant when running the
simulator/debug). Never log `WIFI_PASSWORD`, `CONTROLLER_API_KEY`, or `MQTT_PASSWORD`.

## 6. ESP32 boot flow

```text
BOOT
  |
  v
Init GPIO/relay/sensors to SAFE STATE; drawerState = UNKNOWN
  |
  v
Read base MAC (eFuse)
  |
  v
Connect Wi-Fi (backoff + jitter)
  |
  v
PUT /drawer-provisioning/{normalizedMac}   (X-Controller-Key)
  |
  +-- 423 DEVICE_DISABLED --> stop, show error LED, do NOT connect MQTT
  +-- network error / 5xx --> retry with exponential backoff + jitter
  |
  v
Receive controllerId --> store in NVS
  |
  v
Connect MQTT: clientId = controllerId, cleanSession = TRUE,
              LWT = retained OFFLINE on .../presence
  |
  v
Subscribe .../command (QoS 1)
  |
  v
Publish retained ONLINE presence + retained current state (UNKNOWN)
```

The ESP32 calls the registration API **on every boot**. No separate existence-check
API is needed.

> **cleanSession = TRUE** is mandatory: the broker will **not** queue old commands
> and redeliver them after reconnect (avoids actuating an expired command).

## 7. Registration API

### 7.1 Endpoint

```http
PUT /drawer-provisioning/:mac
Content-Type: application/json
X-Controller-Key: <shared MVP key>
```

`PUT` because the operation is an idempotent create-or-update. The backend
normalizes `:mac` before processing.

### 7.2 Idempotency & concurrency (mandatory)

- The backend performs an **atomic UPSERT** on the normalized `mac_address`:
  `INSERT ... ON CONFLICT (mac_address) DO UPDATE ... RETURNING *`
  (Supabase `.upsert(payload, { onConflict: 'mac_address' })`).
- The unique index on `mac_address` is the sufficient condition; the UPSERT is the
  necessary condition so two concurrent requests **do not create a duplicate row**.
- After obtaining the row (RETURNING): if `lifecycle_status = 'DISABLED'`, do
  **not** update to "revive" it; return `423 DEVICE_DISABLED`.
- Calling multiple times → the same `controllerId`.

### 7.3 Request payload

```json
{
  "serialNumber": "ARGUS-ESP32-001",
  "controllerType": "DRAWER_CONTROLLER",
  "hardware": { "chipModel": "ESP32-S3", "chipRevision": 1, "cores": 2, "flashSize": 8388608 },
  "firmware": { "version": "0.1.0", "build": "2026-07-14" },
  "capabilities": ["DRAWER_OPEN", "DRAWER_CLOSE", "LIGHT_ON", "LIGHT_OFF", "DRAWER_SENSOR"],
  "network": { "ipAddress": "192.168.1.23", "wifiRssi": -61 },
  "boot": { "bootId": "random-value-per-boot", "resetReason": "POWER_ON" }
}
```

Do not send the Wi-Fi/MQTT password in the payload.

### 7.4 Response

```json
{
  "controllerId": "6f1604cd-84d6-4ac4-9134-d5d03a4c2ad3",
  "macAddress": "7CDFA1123456",
  "registrationOutcome": "CREATED",
  "lifecycleStatus": "UNASSIGNED",
  "serverTime": "2026-07-14T10:00:00Z"
}
```

- `registrationOutcome`: `CREATED` (HTTP 201) | `ALREADY_REGISTERED` (HTTP 200).
- `lifecycleStatus`: `UNASSIGNED` | `ACTIVE` | `DISABLED` (lifecycle — **distinct** from the outcome).

The ESP32 only needs a valid `controllerId` to proceed to the MQTT connection.

### 7.5 Error cases

Error responses share a consistent shape `{ "message": string, "code": string }`
(requires extending `HttpExceptionFilter` to also emit `code`; see §13). Firmware
can rely on the **HTTP status** alone; `code` is supplementary.

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | `INVALID_MAC` | Invalid MAC |
| 401 | `INVALID_CONTROLLER_KEY` | Invalid shared key |
| 423 | `DEVICE_DISABLED` | Controller has been disabled by an admin |
| 500 | `REGISTRATION_FAILED` | Backend/database error |

> **Drop `SERIAL_CONFLICT`.** The MVP hardcodes a shared serial across all
> firmware, so the serial is **not** unique; the only unique identity is the MAC.
> The serial is metadata only.

## 8. Database design

> The full SQL (including FKs, CHECKs, indexes, RLS, and the `set_updated_at`
> trigger) lives in a dedicated migration. The section below is the data contract.

### 8.1 `drawer_controllers`

```text
id                    uuid PK (controllerId)
mac_address           text  UNIQUE NOT NULL      -- normalized
serial_number         text                       -- NOT unique
controller_type       text  NOT NULL             -- 'DRAWER_CONTROLLER'
ark_id                text  FK -> arks(id) NULL   -- 1 ark : N controllers
lifecycle_status      text  NOT NULL              -- UNASSIGNED | ACTIVE | DISABLED
firmware_version      text
capabilities          jsonb
hardware_info         jsonb
network_info          jsonb
last_boot_id          text
last_seen_at          timestamptz
created_at            timestamptz
updated_at            timestamptz
```

A unique index on `mac_address` is mandatory (prevents duplicates under concurrent requests).

### 8.2 `drones` (NEW)

```text
id                    uuid PK
ark_id                text  FK -> arks(id) NOT NULL
drawer_controller_id  uuid  FK -> drawer_controllers(id) NULL   -- null = in flight
model                 text
serial_number         text
status                text  NOT NULL   -- DOCKED | IN_FLIGHT | MAINTENANCE | UNKNOWN
created_at            timestamptz
updated_at            timestamptz
```

This is additive over `arks.drone_count` / `arks.drone_model` (denormalized).
Later, `drone_count` can be reconciled via a view/trigger that counts from `drones`.

### 8.3 `drawer_commands`

```text
id                    uuid PK
drawer_controller_id  uuid  FK -> drawer_controllers(id) NOT NULL   -- target
ark_id                text  FK -> arks(id) NOT NULL                 -- authz/audit
requested_by          uuid  FK -> app_users(id) NOT NULL
type                  text  NOT NULL   -- DRAWER_OPEN|DRAWER_CLOSE|LIGHT_ON|LIGHT_OFF
status                text  NOT NULL
idempotency_key       text  NOT NULL
payload               jsonb
error_code            text
error_message         text
created_at            timestamptz
published_at          timestamptz
accepted_at           timestamptz
completed_at          timestamptz
expires_at            timestamptz NOT NULL
```

Mandatory:

- Unique `(drawer_controller_id, idempotency_key)` → a double POST does not create a
  second command (prevents double actuation).
- Index `(status, expires_at)` for the reconciliation sweep.

Command state machine (full):

```text
PENDING ──> PUBLISHED ──> ACCEPTED ──> SUCCEEDED
   │            │            │
   │            │            └──> FAILED
   │            └───────────────> REJECTED        (ESP32 refuses: expired/unsafe/...)
   └────────────┴───────────────> EXPIRED         (sweeper: now() > expires_at)
```

The backend only applies **forward transitions**: `UPDATE ... WHERE id = :commandId
AND status IN (<valid>)`. Late/duplicate results (QoS1) are dropped, never rolling
the state back.

### 8.4 `drawer_state`

One latest-state row per controller:

```text
drawer_controller_id  uuid PK FK -> drawer_controllers(id)
drawer_state          text     -- UNKNOWN|CLOSED|OPENING|OPEN|CLOSING|BLOCKED|FAULT
light_state           text
lock_state            text
sensor_state          jsonb
boot_id               text
reported_at           timestamptz
raw_payload           jsonb
```

### 8.5 `drawer_events`

```text
id                    uuid PK
drawer_controller_id  uuid FK -> drawer_controllers(id) NOT NULL
event_type            text NOT NULL
severity              text NOT NULL
payload               jsonb
occurred_at           timestamptz
received_at           timestamptz
```

### 8.6 RLS

Following the repo pattern (RLS + service_role bypass in dev):

- `drawer_commands`, `drawer_state`, `drones`: the App can **SELECT** if it owns the
  ark (`arks.user_id = auth.uid()`).
- `drawer_controllers`, `drawer_events`: **service_role only** (backend). No client
  policy.
- All writes (registration, command create/update) are performed by the backend
  using service_role, as the current code does.

### 8.7 `arks.dock_status`

`arks.dock_status` (locked/unlocked) is an existing ark-level field. When one ark
has multiple controllers, this single field **cannot** represent it fully. MVP:
treat `arks.dock_status` as legacy/display; **the source of truth is
`drawer_state`**. If needed, update `arks.dock_status` via an aggregate/trigger
after the MVP.

## 9. MQTT design

### 9.1 Topics

```text
argus/v1/controllers/{controllerId}/command
argus/v1/controllers/{controllerId}/command-result
argus/v1/controllers/{controllerId}/state
argus/v1/controllers/{controllerId}/presence
argus/v1/controllers/{controllerId}/event
```

- ESP32: subscribes `command`; publishes `command-result`, `state`, `presence`, `event`.
- Backend: publishes `command`; subscribes the output topics.

### 9.2 QoS & retained

| Message | QoS | Retained |
| --- | ---: | --- |
| Command | 1 | No |
| Command result | 1 | No |
| State | 1 | Yes |
| Presence | 1 | Yes |
| Event | 1 | No |

- Commands are **not retained** and the ESP32 uses **cleanSession = TRUE** → it
  never executes an old command after reboot/reconnect.
- QoS 1 → can duplicate. The ESP32 **dedups by `commandId`**; the backend is
  **idempotent** on `(commandId, status)` + forward-transition.

### 9.3 Presence & Last Will

On a successful MQTT connection, the ESP32 publishes (retained):

```json
{ "schemaVersion": 1, "status": "ONLINE", "bootId": "…", "firmwareVersion": "0.1.0", "timestamp": "…" }
```

Retained LWT:

```json
{ "schemaVersion": 1, "status": "OFFLINE" }
```

The LWT only catches abrupt disconnects. The backend also needs a **heartbeat
sweeper** (`DRAWER_HEARTBEAT_TIMEOUT_SECONDS`) to mark a hung controller offline
while its TCP connection is still open.

## 10. Command contract

### 10.1 App API

```http
POST /arks/:arkId/drawer-controllers/:controllerId/commands
Authorization: Bearer <user token>
Idempotency-Key: <unique value>   (required)
```

```json
{ "type": "DRAWER_OPEN", "expiresInSeconds": 15 }
```

- MVP commands: `DRAWER_OPEN`, `DRAWER_CLOSE`, `LIGHT_ON`, `LIGHT_OFF`.
- DTO validation: `type` ∈ enum; `expiresInSeconds` `@IsInt() @Min(5) @Max(60)`.

**Authorization (all three required):**

1. The user owns the ark: `arks.user_id = req.user.userId` (like `ArksService`).
2. `ROLE_PERMISSIONS[role].canControlDrone === true` (GUEST blocked).
3. The controller belongs to the ark: `drawer_controllers.ark_id = :arkId` and
   `lifecycle_status = 'ACTIVE'`.

Returns `202 Accepted`:

```json
{ "commandId": "…", "status": "PENDING", "expiresAt": "2026-07-14T10:00:15Z" }
```

If the controller's `presence = OFFLINE` at send time → the command quickly moves to
`EXPIRED`/`FAILED(OFFLINE)`; do **not** rely on the broker to queue it.

Idempotency: if `(controllerId, Idempotency-Key)` already exists → **return the
existing command** (same `commandId`), do not create a new one, do not re-publish.

### 10.2 App API — command status (required for App polling)

```http
GET /arks/:arkId/drawer-controllers/:controllerId/commands/:commandId
Authorization: Bearer <user token>
```

Returns `status`, `error`, `actualState`, and the timestamps. The App polls because
it does not connect to MQTT.

### 10.3 MQTT command payload

```json
{
  "schemaVersion": 1,
  "commandId": "b66fbab7-…",
  "type": "DRAWER_OPEN",
  "issuedAt": "2026-07-14T10:00:00Z",
  "expiresAt": "2026-07-14T10:00:15Z",
  "parameters": { "timeoutMs": 8000 }
}
```

The ESP32 rejects a command if: `schemaVersion` is unsupported; `commandId` is
missing; it is expired; the type is unsupported; or the device is in an unsafe state.

> **Clocks:** the ESP32 is often not NTP-synced right after boot. It uses the
> **relative `timeoutMs` measured from receipt** as the primary source for
> reject/expire; it only uses the absolute `expiresAt` once NTP-synced. The backend
> expires independently based on `expires_at`.

The ESP32 **dedups by `commandId`** — the same command must not fire the motor twice.

### 10.4 Command result

```json
{
  "schemaVersion": 1,
  "commandId": "b66fbab7-…",
  "status": "SUCCEEDED",
  "actualState": { "drawer": "OPEN", "light": "ON" },
  "completedAt": "2026-07-14T10:00:03Z"
}
```

Result statuses: `ACCEPTED`, `SUCCEEDED`, `FAILED`, `REJECTED`.

PUBACK is not success. `SUCCEEDED` is only sent once the ESP32 has confirmed the
actual state (sensor-preferred).

## 11. Drawer state machine & safety

```text
UNKNOWN  CLOSED  OPENING  OPEN  CLOSING  BLOCKED  FAULT
```

Minimum requirements:

- GPIO/relay to **safe state** on boot; drawerState = `UNKNOWN` until a sensor reads it.
- Do not allow opening and closing simultaneously.
- Every movement has a **hard timeout**.
- Do not infer the drawer is open based on relay output alone.
- Reject expired commands (by the local `timeoutMs`).
- Do not re-run a command with a duplicate `commandId`.
- Hardware fault → `FAULT` + publish an event.

**Launch-gating (in MVP scope, thanks to the drone↔controller mapping):** to launch
drone X:

1. Look up `drones.drawer_controller_id` for drone X.
2. Require `drawer_state(controllerId).drawer_state = 'OPEN'` (sensor-confirmed) and
   `drones.status = 'DOCKED'`.
3. If `drawer_controller_id IS NULL` or state ≠ `OPEN` → **block launch**.

After power loss/reboot: state = `UNKNOWN` → launch is blocked until a sensor confirms.

An early prototype may replace the motor with an LED but keep the same command/state
contract.

> **Before the pilot (real drawer):** limit switches for `fully_open`/`fully_closed`
> are **mandatory** (never infer `OPEN` from a timeout when gating launch).

## 12. Retry & reconnect

Registration and MQTT reconnect use exponential backoff + jitter:

```text
5s -> 10s -> 20s -> 40s -> 80s -> max 300s   (+ jitter 0..3s)
```

On a successful MQTT reconnect:

1. Subscribe `command`.
2. Publish `ONLINE` presence.
3. Publish current state.

## 13. Backend modules

```text
src/drawer-controllers/
  drawer-controllers.module.ts
  drawer-controllers.controller.ts          -- admin: assign ark_id, disable/enable
  drawer-provisioning.controller.ts         -- PUT /drawer-provisioning/:mac
  drawer-controllers.service.ts
  drawer-controller-key.guard.ts            -- X-Controller-Key
  dto/register-controller.dto.ts

src/drawer-commands/
  drawer-commands.module.ts
  drawer-commands.controller.ts             -- POST/GET command for ark+controller
  drawer-commands.service.ts
  drawer-commands.reconciler.ts             -- sweeper: expire overdue commands
  dto/create-drawer-command.dto.ts

src/mqtt/
  mqtt.module.ts
  mqtt.service.ts                           -- singleton client
  mqtt-message-handler.service.ts
  mqtt-topics.ts
  mqtt-payloads.ts
```

`MqttService` (singleton) must: auto-reconnect; resubscribe after connect/reconnect;
validate JSON; **never crash** on malformed input; correlate results by `commandId`;
update presence/state/command in Supabase (idempotent, forward-transition).

Extend `HttpExceptionFilter` to return `{ message, code }` (add an optional `code`
field) to serve the error contract in §7.5.

## 14. Environment variables

Add to `.env.example`:

```env
CONTROLLER_API_KEY=

MQTT_URL=mqtt://localhost:1883
MQTT_BACKEND_CLIENT_ID=argus-backend
MQTT_USERNAME=
MQTT_PASSWORD=
MQTT_COMMAND_TIMEOUT_MS=15000
DRAWER_HEARTBEAT_TIMEOUT_SECONDS=90
COMMAND_RECONCILE_INTERVAL_MS=10000
```

Production must switch to `mqtts://` and HTTPS.

## 15. Implementation phases

> Order revised: the simulator comes early (Phase 3) to test the backend
> MQTT/command path; added the reconciliation job and the `drones` table.

### Phase 1 — Infrastructure & schema

- Add a local MQTT broker via Docker Compose.
- Migrations: `drawer_controllers`, `drones`, `drawer_commands`, `drawer_state`,
  `drawer_events` — with FKs, CHECKs, uniques (`mac_address`,
  `(drawer_controller_id, idempotency_key)`), indexes (`(status, expires_at)`), RLS,
  and the `set_updated_at` trigger.
- Add the environment variables.

Result: broker + database ready.

### Phase 2 — Registration API

- `DrawerControllersModule` + MAC normalization/validation.
- `PUT /drawer-provisioning/:mac`, guarded by `X-Controller-Key`.
- **Atomic UPSERT** create-or-update; `DISABLED` guard.
- Swagger + tests (including concurrency).

Result: the same MAC called repeatedly creates only one controller, concurrency-safe.

### Phase 3 — ESP32 simulator (Node.js)

- Uses the same registration + MQTT contract.
- Registers with a fixed MAC; subscribes to commands; publishes `ACCEPTED`,
  `SUCCEEDED`, state, presence.
- Simulates timeout, failure, disconnect, and **duplicate messages**.

Result: a tool to test the backend MQTT/command path without a real board.

### Phase 4 — MQTT backend

- Install the MQTT client; `MqttService` singleton.
- Subscribe presence/state/event/command-result; persist to Supabase.
- Update `last_seen_at`, presence/state; handle reconnect + malformed payloads.

Result: the backend receives state from the simulator (Phase 3).

### Phase 5 — Command API + reconciliation

- POST/GET command endpoints for `arks/:arkId/drawer-controllers/:controllerId`.
- Authz: ownership + `canControlDrone` + an ACTIVE controller under the ark.
- Unique Idempotency-Key; create the command before publishing; publish QoS 1.
- Update the command from the result (forward-transition, idempotent).
- **Reconciler**: expire commands past `expires_at`; reconcile via retained state
  when the backend (re)connects.
- Endpoint to assign a controller to an ark (admin) to move `UNASSIGNED → ACTIVE`.

Result: the App sends + tracks a command end-to-end; commands do not get stuck after
a restart.

### Phase 6 — ESP32 firmware prototype

- Hardcode Wi-Fi/API/MQTT; read the base MAC; call registration on boot; store
  `controllerId` in NVS; connect/reconnect MQTT (cleanSession); LED in place of a motor.
- Publish result + state.

Result: the App controls the LED end-to-end.

### Phase 7 — Drawer hardware

- Relay/motor driver + limit switches; drawer state machine; movement timeout + fault state.
- Test network loss, reboot, and power loss while the drawer is moving.

Result: safe drawer control, with sensor-confirmed state.

## 16. Mandatory test cases

### Registration

- A new MAC creates exactly one controller (201, `CREATED`).
- The same MAC multiple times → no duplicate, same `controllerId` (200, `ALREADY_REGISTERED`).
- MACs in different formats normalize to the same value.
- An invalid MAC is rejected (400).
- A wrong controller key is rejected (401).
- A `DISABLED` controller is blocked (423) and not "revived".
- **Two concurrent registrations for the same MAC → exactly one row** (UPSERT), no 500.
- Timeout then retry (backend already created it) → same `controllerId`.

### MQTT

- Connect → publish ONLINE (retained).
- Unexpected disconnect → OFFLINE via LWT; the heartbeat sweeper marks it offline when hung.
- Reconnect → resubscribe command; cleanSession ⇒ no old command received.
- Malformed JSON → the backend does not crash.
- Unknown controller/topic → ignored, safely logged.
- **Duplicate command-result (QoS1)** → applied exactly once, state not rolled back.

### Commands

- An authorized user (owner + canControlDrone) can send a command.
- A user who does not own the ark → 403/404.
- GUEST → 403.
- The command is stored before publishing.
- `ACCEPTED`/`SUCCEEDED` update the correct record (forward-transition).
- An expired command → `EXPIRED` (sweeper).
- **A double POST with the same Idempotency-Key → one command, the actuator runs once.**
- Controller OFFLINE at send time → `FAILED(OFFLINE)`/`EXPIRED`, not queued.
- PUBACK does not itself move to `SUCCEEDED`.
- A backend restart between PUBLISHED and the result → not stuck forever (reconcile).

### Hardware safety

- Relay in safe state after boot; state = UNKNOWN until a sensor reads it.
- The motor stops on timeout.
- No simultaneous open + close.
- Sensor confirms OPEN/CLOSED correctly.
- Hardware fault published to the backend.
- ESP32 reboot while the drawer is moving → boots safe, the old command has EXPIRED, launch is blocked.

### Launch-gating

- A drone with a `drawer_controller_id` and drawer `OPEN` → allowed.
- Drawer ≠ OPEN or `drawer_controller_id IS NULL` → blocked.

## 17. MVP acceptance criteria

1. The ESP32/simulator connects to Wi-Fi and calls registration after boot on its own.
2. One MAC ↔ exactly one `drawer_controller` (even under concurrent requests).
3. The ESP32 receives a stable `controllerId` across reboots.
4. The ESP32/simulator connects to MQTT and shows as online in the backend.
5. The App/API can send the four MVP commands by `arkId + controllerId`.
6. The backend tracks a command from `PENDING` → `SUCCEEDED`/`FAILED`/`REJECTED`/`EXPIRED`.
7. The ESP32 publishes state after executing a command.
8. A duplicate (Idempotency-Key) or expired command does not re-run the actuator.
9. Disconnection is detected (LWT + heartbeat) and the controller goes offline.
10. Commands do not get stuck after a backend restart (the reconciler runs).
11. The drone↔controller mapping exists and launch-gating works based on `drawer_state`.
12. The important registration/MQTT/command/safety tests all pass.

## 18. MVP risks & the milestones to fix them

| Risk | Local prototype | Before pilot | Before production |
| --- | :---: | :---: | :---: |
| Shared controller API key | Accept | Per-controller key | Per-device token/cert |
| Shared MQTT credential | Accept | Broker ACL per controllerId | Per-device mTLS |
| HTTP/MQTT without TLS (LAN) | Accept | `mqtts://` + HTTPS | Mandatory + HSTS |
| MAC spoofing | Accept | Limited via ACL | Device attestation |
| Hardcoded secrets in firmware | Accept | Dedicated provisioning | Secure boot + flash encryption |
| Inferring `OPEN` from a timeout | Accept (LED) | **Limit switch mandatory** | — |
| Trusting command-result for launch | Accept | Cross-check retained state/sensor | — |

## 19. Post-MVP upgrade directions

- Split out a physical `dock_drawers` table if one controller drives multiple drawers.
- Reconcile `arks.drone_count`/`dock_status` from `drones`/`drawer_state` (view/trigger).
- Activation code/QR to claim a controller into an ark.
- Per-ESP32 credentials/certificates; mandatory MQTT over TLS + HTTPS.
- Broker ACLs by device/client id.
- Secure boot, flash encryption, signed OTA; credential rotation/revocation.
- WebSocket/SSE so the App receives realtime state (instead of polling).
- device_events retention/rollup; metrics, alerts, batched firmware rollout.
</content>
