# Drawer Controller (ESP32) — MVP Implementation Plan

> **Ghi chú thuật ngữ (quan trọng).** Trong codebase hiện tại, "device" đã mang
> nghĩa **drone**. Thiết bị ESP32 điều khiển ngăn kéo được đặt tên là
> **`drawer_controller`** (id = `controllerId`) để **không đụng nghĩa** với drone
> (`canControlDrone`, `DRONE_ACTIONS`, DJI SDK). Đừng dùng lại từ "device" cho
> phần cứng ESP32 ở bất kỳ đâu.

## 1. Mục tiêu

Xây dựng luồng MVP cho ESP32 (drawer controller) điều khiển ngăn kéo và đèn của
Argus Ark:

1. ESP32 khởi động và kết nối Wi-Fi bằng cấu hình hardcode.
2. ESP32 tự đăng ký với ArgusBE bằng MAC address.
3. Backend tạo `drawer_controller` nếu chưa tồn tại hoặc cập nhật nếu đã tồn tại
   (idempotent, an toàn với request đồng thời).
4. Backend trả về `controllerId` ổn định cho ESP32.
5. ESP32 kết nối MQTT bằng cấu hình hardcode.
6. Backend gửi command mở/đóng ngăn kéo hoặc bật/tắt đèn qua MQTT.
7. ESP32 gửi kết quả command, trạng thái ngăn kéo và trạng thái kết nối về backend.
8. App chỉ giao tiếp với ArgusBE qua HTTP; App **không** kết nối trực tiếp MQTT.

MVP ưu tiên hoàn thiện luồng end-to-end và khả năng test. Provision certificate và
credential riêng cho từng thiết bị được triển khai ở phase sau.

### Mô hình thực thể (canonical)

```text
app_users (owner)
   │ user_id
   ▼
arks (id text, dock_status)                 -- đã có sẵn trong repo
   │ 1 : N
   ▼
drawer_controllers (ESP32, id = controllerId)
   │ 1 : N
   ▼
drones (id, drawer_controller_id nullable)  -- MỚI; null = drone đang bay/chưa gán
```

- **ark 1 : N drawer_controllers** — một ark có thể có nhiều ngăn kéo/ESP32.
- **drawer_controller 1 : N drones** — một ngăn kéo chứa 1..N drone.
  `drawer_controller_id = null` khi drone đang bay hoặc chưa được gán vào ngăn kéo.
- **Giả định MVP:** một `drawer_controller` (ESP32) tương ứng **1:1** với một ngăn
  kéo vật lý, nên MVP chưa tách bảng `dock_drawers` riêng. Nếu sau này một
  controller điều khiển nhiều ngăn, tách `dock_drawers` và cho `drones.dock_drawer_id`.

## 2. Phạm vi MVP

### Trong phạm vi

- ESP32 dùng constants cho Wi-Fi, ArgusBE URL và MQTT config.
- Base MAC/eFuse MAC làm hardware identifier.
- Registration idempotent theo MAC, **UPSERT nguyên tử** (an toàn concurrency).
- Backend sinh `controllerId` (UUID) riêng, không dùng MAC làm primary key.
- Một MQTT account dùng chung cho các ESP32 trong môi trường MVP.
- Backend gửi command qua MQTT theo `controllerId`.
- ESP32 publish presence, state và command result.
- Lưu controller, drones, command và trạng thái gần nhất trong Supabase.
- **Mapping drone ↔ drawer_controller** (bảng `drones`) để phục vụ launch-gating.
- Kiểm tra quyền user (ownership + `canControlDrone`) trước khi gửi command.
- ESP32 simulator để test backend khi chưa có hardware thật.

### Ngoài phạm vi

- Mutual TLS và certificate riêng cho từng ESP32.
- Wi-Fi provisioning qua BLE hoặc SoftAP.
- OTA firmware update.
- Credential rotation tự động.
- Broker high availability.
- App kết nối MQTT trực tiếp.
- Điều khiển drone launch hoàn chỉnh (MVP chỉ mở/đóng ngăn kéo + gate an toàn).

## 3. Kiến trúc

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

Nguyên tắc:

- HTTPS dùng cho registration và App API.
- MQTT dùng cho command, command result, presence và state.
- ArgusBE là nơi kiểm tra authorization và lưu audit trail.
- Trạng thái vật lý phải được **sensor xác nhận**, không suy luận từ relay output.
- **PUBACK ≠ thành công.** Command chỉ `SUCCEEDED` khi ESP32 xác nhận trạng thái thật.

## 4. Danh tính

### 4.1 Hardware identifier (MAC)

MVP dùng base MAC/eFuse MAC của ESP32. Backend **normalize** trước khi lookup và
**lưu giá trị đã normalize**:

- Chuyển chữ hoa.
- Loại bỏ `:`, `-`, khoảng trắng.
- Validate đúng 12 ký tự hex (`^[0-9A-F]{12}$`).

Ví dụ chuẩn: `7CDFA1123456`.

### 4.2 Các loại id

```text
mac_address     = hardware identifier (đã normalize)
controllerId    = database/business id của drawer_controller (UUID)
mqttClientId    = = controllerId
droneId         = UUID của drone (bảng drones)
```

Không dùng MAC làm primary key hay đưa MAC vào toàn bộ quan hệ dữ liệu.

## 5. Constants trên ESP32

```cpp
#define WIFI_SSID "ArgusWifi"
#define WIFI_PASSWORD "prototype-password"

#define API_BASE_URL "http://192.168.1.100:3333"
#define CONTROLLER_API_KEY "prototype-shared-controller-key"

#define MQTT_HOST "192.168.1.100"
#define MQTT_PORT 1883
#define MQTT_USERNAME "argus-controller"
#define MQTT_PASSWORD "prototype-mqtt-password"

#define CONTROLLER_SERIAL "ARGUS-ESP32-001"   // metadata; KHÔNG unique trong MVP
#define CONTROLLER_TYPE "DRAWER_CONTROLLER"
#define FIRMWARE_VERSION "0.1.0"
```

MAC đọc từ eFuse (cho phép override bằng constant khi chạy simulator/debug).
Không log `WIFI_PASSWORD`, `CONTROLLER_API_KEY`, `MQTT_PASSWORD`.

## 6. ESP32 boot flow

```text
BOOT
  |
  v
Khởi tạo GPIO/relay/sensors ở SAFE STATE; drawerState = UNKNOWN
  |
  v
Đọc base MAC (eFuse)
  |
  v
Kết nối Wi-Fi (backoff + jitter)
  |
  v
PUT /drawer-provisioning/{normalizedMac}   (X-Controller-Key)
  |
  +-- 423 DEVICE_DISABLED --> dừng, báo LED lỗi, KHÔNG kết nối MQTT
  +-- lỗi mạng/5xx        --> retry exponential backoff + jitter
  |
  v
Nhận controllerId --> lưu vào NVS
  |
  v
Kết nối MQTT: clientId = controllerId, cleanSession = TRUE,
              LWT = retained OFFLINE trên .../presence
  |
  v
Subscribe .../command (QoS 1)
  |
  v
Publish retained ONLINE presence + retained current state (UNKNOWN)
```

ESP32 gọi registration API **mỗi lần boot**. Không cần API riêng để kiểm tra tồn tại.

> **cleanSession = TRUE** là bắt buộc: broker sẽ **không** queue command cũ và
> giao lại sau reconnect (tránh actuate lệnh đã hết hạn).

## 7. Registration API

### 7.1 Endpoint

```http
PUT /drawer-provisioning/:mac
Content-Type: application/json
X-Controller-Key: <shared MVP key>
```

Dùng `PUT` vì thao tác idempotent create-or-update. Backend normalize `:mac`
trước khi xử lý.

### 7.2 Idempotency & concurrency (bắt buộc)

- Backend thực hiện **UPSERT nguyên tử** theo `mac_address` đã normalize:
  `INSERT ... ON CONFLICT (mac_address) DO UPDATE ... RETURNING *`
  (Supabase `.upsert(payload, { onConflict: 'mac_address' })`).
- Unique index trên `mac_address` là điều kiện đủ; UPSERT là điều kiện cần để
  hai request đồng thời **không tạo bản ghi trùng**.
- Sau khi có row (RETURNING): nếu `lifecycle_status = 'DISABLED'` → **không**
  cập nhật để "hồi sinh"; trả `423 DEVICE_DISABLED`.
- Gọi nhiều lần → cùng `controllerId`.

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

Không truyền Wi-Fi/MQTT password trong payload.

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
- `lifecycleStatus`: `UNASSIGNED` | `ACTIVE` | `DISABLED` (vòng đời — **khác** với outcome).

ESP32 chỉ cần `controllerId` hợp lệ để tiếp tục kết nối MQTT.

### 7.5 Error cases

Response lỗi có shape thống nhất `{ "message": string, "code": string }`
(cần mở rộng `HttpExceptionFilter` để phát thêm `code`; xem §13). Firmware có thể
dựa vào **HTTP status** là đủ; `code` mang tính bổ trợ.

| HTTP | Code | Ý nghĩa |
| --- | --- | --- |
| 400 | `INVALID_MAC` | MAC không hợp lệ |
| 401 | `INVALID_CONTROLLER_KEY` | Shared key không hợp lệ |
| 423 | `DEVICE_DISABLED` | Controller đã bị admin vô hiệu hóa |
| 500 | `REGISTRATION_FAILED` | Lỗi backend/database |

> **Bỏ `SERIAL_CONFLICT`.** MVP hardcode chung một serial cho mọi firmware nên
> serial **không** unique; danh tính duy nhất là MAC. Serial chỉ là metadata.

## 8. Database design

> SQL đầy đủ (bao gồm FK, CHECK, index, RLS, trigger `set_updated_at`) nằm ở
> migration riêng. Phần dưới là hợp đồng dữ liệu.

### 8.1 `drawer_controllers`

```text
id                    uuid PK (controllerId)
mac_address           text  UNIQUE NOT NULL      -- đã normalize
serial_number         text                       -- KHÔNG unique
controller_type       text  NOT NULL             -- 'DRAWER_CONTROLLER'
ark_id                text  FK -> arks(id) NULL   -- 1 ark : N controller
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

Unique index bắt buộc trên `mac_address` (chống duplicate khi request đồng thời).

### 8.2 `drones` (MỚI)

```text
id                    uuid PK
ark_id                text  FK -> arks(id) NOT NULL
drawer_controller_id  uuid  FK -> drawer_controllers(id) NULL   -- null = đang bay
model                 text
serial_number         text
status                text  NOT NULL   -- DOCKED | IN_FLIGHT | MAINTENANCE | UNKNOWN
created_at            timestamptz
updated_at            timestamptz
```

Đây là phần cộng thêm so với `arks.drone_count` / `arks.drone_model` (denormalized).
Sau này có thể reconcile `drone_count` bằng view/trigger đếm từ `drones`.

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

Bắt buộc:

- Unique `(drawer_controller_id, idempotency_key)` → double POST không tạo command
  thứ hai (chống actuate 2 lần).
- Index `(status, expires_at)` cho reconciliation sweep.

Command state machine (đầy đủ):

```text
PENDING ──> PUBLISHED ──> ACCEPTED ──> SUCCEEDED
   │            │            │
   │            │            └──> FAILED
   │            └───────────────> REJECTED        (ESP32 từ chối: expired/unsafe/...)
   └────────────┴───────────────> EXPIRED         (sweeper: now() > expires_at)
```

Backend chỉ áp **forward transition**: `UPDATE ... WHERE id = :commandId AND
status IN (<hợp lệ>)`. Result trễ/trùng (QoS1) bị bỏ qua, không lùi trạng thái.

### 8.4 `drawer_state`

Một row trạng thái gần nhất cho mỗi controller:

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

Theo pattern repo (RLS + bypass service_role trong dev):

- `drawer_commands`, `drawer_state`, `drones`: App **SELECT** được nếu sở hữu ark
  (`arks.user_id = auth.uid()`).
- `drawer_controllers`, `drawer_events`: **chỉ service_role** (backend). Không policy
  cho client.
- Mọi ghi (registration, command create/update) do backend thực hiện bằng
  service_role như code hiện tại.

### 8.7 `arks.dock_status`

`arks.dock_status` (locked/unlocked) là field mức ark có sẵn. Khi một ark có nhiều
controller, field đơn này **không** biểu diễn đủ. MVP: coi `arks.dock_status` là
legacy/hiển thị; **nguồn sự thật là `drawer_state`**. Nếu cần, cập nhật
`arks.dock_status` bằng aggregate/trigger sau MVP.

## 9. MQTT design

### 9.1 Topics

```text
argus/v1/controllers/{controllerId}/command
argus/v1/controllers/{controllerId}/command-result
argus/v1/controllers/{controllerId}/state
argus/v1/controllers/{controllerId}/presence
argus/v1/controllers/{controllerId}/event
```

- ESP32: subscribe `command`; publish `command-result`, `state`, `presence`, `event`.
- Backend: publish `command`; subscribe các topic output.

### 9.2 QoS & retained

| Message | QoS | Retained |
| --- | ---: | --- |
| Command | 1 | Không |
| Command result | 1 | Không |
| State | 1 | Có |
| Presence | 1 | Có |
| Event | 1 | Không |

- Command **không retained** và ESP32 dùng **cleanSession = TRUE** → không bao giờ
  thực hiện lệnh cũ sau reboot/reconnect.
- QoS 1 → có thể trùng. ESP32 **dedup theo `commandId`**; backend **idempotent**
  theo `(commandId, status)` + forward-transition.

### 9.3 Presence & Last Will

Khi kết nối MQTT thành công, ESP32 publish (retained):

```json
{ "schemaVersion": 1, "status": "ONLINE", "bootId": "…", "firmwareVersion": "0.1.0", "timestamp": "…" }
```

LWT retained:

```json
{ "schemaVersion": 1, "status": "OFFLINE" }
```

LWT chỉ bắt disconnect đột ngột. Backend còn cần **heartbeat sweeper**
(`DRAWER_HEARTBEAT_TIMEOUT_SECONDS`) để đánh offline controller treo mà TCP vẫn mở.

## 10. Command contract

### 10.1 App API

```http
POST /arks/:arkId/drawer-controllers/:controllerId/commands
Authorization: Bearer <user token>
Idempotency-Key: <unique value>   (bắt buộc)
```

```json
{ "type": "DRAWER_OPEN", "expiresInSeconds": 15 }
```

- Commands MVP: `DRAWER_OPEN`, `DRAWER_CLOSE`, `LIGHT_ON`, `LIGHT_OFF`.
- DTO validation: `type` ∈ enum; `expiresInSeconds` `@IsInt() @Min(5) @Max(60)`.

**Authorization (bắt buộc cả ba):**

1. User sở hữu ark: `arks.user_id = req.user.userId` (như `ArksService`).
2. `ROLE_PERMISSIONS[role].canControlDrone === true` (GUEST bị chặn).
3. Controller thuộc ark: `drawer_controllers.ark_id = :arkId` và
   `lifecycle_status = 'ACTIVE'`.

Trả `202 Accepted`:

```json
{ "commandId": "…", "status": "PENDING", "expiresAt": "2026-07-14T10:00:15Z" }
```

Nếu controller `presence = OFFLINE` tại thời điểm gửi → command chuyển
`EXPIRED`/`FAILED(OFFLINE)` nhanh, **không** dựa vào broker để queue.

Idempotency: nếu `(controllerId, Idempotency-Key)` đã tồn tại → **trả lại command
cũ** (cùng `commandId`), không tạo mới, không publish lại.

### 10.2 App API — trạng thái command (bắt buộc cho App polling)

```http
GET /arks/:arkId/drawer-controllers/:controllerId/commands/:commandId
Authorization: Bearer <user token>
```

Trả `status`, `error`, `actualState`, các mốc thời gian. App poll vì không nối MQTT.

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

ESP32 reject command nếu: `schemaVersion` không hỗ trợ; thiếu `commandId`;
hết hạn; type không hỗ trợ; device đang ở trạng thái không an toàn.

> **Đồng hồ:** ESP32 thường chưa NTP-sync ngay sau boot. ESP32 dùng **`timeoutMs`
> tương đối tính từ lúc nhận** làm nguồn chính để reject/expire; chỉ dùng
> `expiresAt` tuyệt đối khi đã NTP-synced. Backend expire độc lập theo `expires_at`.

ESP32 **dedup theo `commandId`** — cùng một command không được kích motor hai lần.

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

PUBACK không phải thành công. `SUCCEEDED` chỉ gửi khi ESP32 đã xác nhận trạng thái
thực tế (ưu tiên sensor).

## 11. Drawer state machine & safety

```text
UNKNOWN  CLOSED  OPENING  OPEN  CLOSING  BLOCKED  FAULT
```

Yêu cầu tối thiểu:

- GPIO/relay về **safe state** khi boot; drawerState = `UNKNOWN` cho tới khi sensor đọc.
- Không cho mở và đóng đồng thời.
- Mỗi chuyển động có **hard timeout**.
- Không suy luận drawer đã mở chỉ dựa trên relay output.
- Reject command hết hạn (theo `timeoutMs` cục bộ).
- Không chạy lại command trùng `commandId`.
- Hardware fault → `FAULT` + publish event.

**Launch-gating (trong scope MVP, nhờ mapping drone↔controller):** để phóng drone X:

1. Tra `drones.drawer_controller_id` của drone X.
2. Yêu cầu `drawer_state(controllerId).drawer_state = 'OPEN'` (đã sensor xác nhận)
   và `drones.status = 'DOCKED'`.
3. Nếu `drawer_controller_id IS NULL` hoặc state ≠ `OPEN` → **chặn launch**.

Sau mất điện/reboot: state = `UNKNOWN` → launch bị chặn cho tới khi sensor xác nhận.

Prototype đầu có thể thay motor bằng LED nhưng giữ nguyên command/state contract.

> **Trước pilot (drawer thật):** limit switch cho `fully_open`/`fully_closed` là
> **bắt buộc** (không được suy `OPEN` từ timeout khi gate launch).

## 12. Retry & reconnect

Registration và MQTT reconnect dùng exponential backoff + jitter:

```text
5s -> 10s -> 20s -> 40s -> 80s -> tối đa 300s   (+ jitter 0..3s)
```

Khi MQTT reconnect thành công:

1. Subscribe `command`.
2. Publish `ONLINE` presence.
3. Publish current state.

## 13. Backend modules

```text
src/drawer-controllers/
  drawer-controllers.module.ts
  drawer-controllers.controller.ts          -- admin: gán ark_id, disable/enable
  drawer-provisioning.controller.ts         -- PUT /drawer-provisioning/:mac
  drawer-controllers.service.ts
  drawer-controller-key.guard.ts            -- X-Controller-Key
  dto/register-controller.dto.ts

src/drawer-commands/
  drawer-commands.module.ts
  drawer-commands.controller.ts             -- POST/GET command cho ark+controller
  drawer-commands.service.ts
  drawer-commands.reconciler.ts             -- sweeper: expire command quá hạn
  dto/create-drawer-command.dto.ts

src/mqtt/
  mqtt.module.ts
  mqtt.service.ts                           -- singleton client
  mqtt-message-handler.service.ts
  mqtt-topics.ts
  mqtt-payloads.ts
```

`MqttService` (singleton) cần: tự reconnect; resubscribe sau connect/reconnect;
validate JSON; **không crash** khi malformed; correlate result theo `commandId`;
update presence/state/command trong Supabase (idempotent, forward-transition).

Mở rộng `HttpExceptionFilter` để trả `{ message, code }` (thêm field `code` tùy
chọn) phục vụ error contract §7.5.

## 14. Environment variables

Thêm vào `.env.example`:

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

Production phải chuyển sang `mqtts://` và HTTPS.

## 15. Implementation phases

> Thứ tự đã sửa: simulator lên sớm (Phase 3) để test backend MQTT/command; thêm
> reconciliation job và bảng `drones`.

### Phase 1 — Infrastructure & schema

- Thêm local MQTT broker bằng Docker Compose.
- Migrations: `drawer_controllers`, `drones`, `drawer_commands`, `drawer_state`,
  `drawer_events` — kèm FK, CHECK, unique (`mac_address`,
  `(drawer_controller_id, idempotency_key)`), index (`(status, expires_at)`), RLS,
  trigger `set_updated_at`.
- Bổ sung environment variables.

Kết quả: broker + database sẵn sàng.

### Phase 2 — Registration API

- `DrawerControllersModule` + MAC normalization/validation.
- `PUT /drawer-provisioning/:mac`, guard `X-Controller-Key`.
- **UPSERT nguyên tử** create-or-update; guard `DISABLED`.
- Swagger + tests (bao gồm concurrency).

Kết quả: cùng MAC gọi nhiều lần chỉ tạo một controller, an toàn concurrency.

### Phase 3 — ESP32 simulator (Node.js)

- Dùng cùng registration + MQTT contract.
- Register bằng MAC cố định; subscribe command; publish `ACCEPTED`, `SUCCEEDED`,
  state, presence.
- Mô phỏng timeout, failure, disconnect, **duplicate message**.

Kết quả: có công cụ test backend MQTT/command mà không cần board thật.

### Phase 4 — MQTT backend

- Cài MQTT client; `MqttService` singleton.
- Subscribe presence/state/event/command-result; lưu Supabase.
- Update `last_seen_at`, presence/state; xử lý reconnect + malformed payload.

Kết quả: backend nhận trạng thái từ simulator (Phase 3).

### Phase 5 — Command API + reconciliation

- Endpoint POST/GET command cho `arks/:arkId/drawer-controllers/:controllerId`.
- Authz: ownership + `canControlDrone` + controller ACTIVE thuộc ark.
- Idempotency-Key unique; tạo command trước khi publish; publish QoS 1.
- Update command theo result (forward-transition, idempotent).
- **Reconciler**: expire command quá `expires_at`; reconcile qua retained state khi
  backend (re)connect.
- Endpoint gán controller vào ark (admin) để chuyển `UNASSIGNED → ACTIVE`.

Kết quả: App gửi + theo dõi command end-to-end; command không kẹt sau restart.

### Phase 6 — ESP32 firmware prototype

- Hardcode Wi-Fi/API/MQTT; đọc base MAC; gọi registration khi boot; lưu
  `controllerId` NVS; connect/reconnect MQTT (cleanSession); LED thay motor.
- Publish result + state.

Kết quả: App điều khiển LED end-to-end.

### Phase 7 — Drawer hardware

- Relay/motor driver + limit switches; drawer state machine; movement timeout +
  fault state.
- Test mất mạng, reboot, mất điện khi drawer đang chạy.

Kết quả: điều khiển drawer an toàn, trạng thái sensor xác nhận.

## 16. Test cases bắt buộc

### Registration

- MAC mới tạo đúng một controller (201, `CREATED`).
- Cùng MAC nhiều lần → không duplicate, cùng `controllerId` (200, `ALREADY_REGISTERED`).
- MAC khác format normalize về cùng giá trị.
- MAC không hợp lệ bị reject (400).
- Sai controller key bị reject (401).
- Controller `DISABLED` bị chặn (423), không bị "hồi sinh".
- **Hai registration đồng thời cùng MAC → đúng một row** (UPSERT), không 500.
- Timeout rồi retry (backend đã tạo) → cùng `controllerId`.

### MQTT

- Connect → publish ONLINE (retained).
- Unexpected disconnect → OFFLINE qua LWT; heartbeat sweeper đánh offline khi treo.
- Reconnect → resubscribe command; cleanSession ⇒ không nhận command cũ.
- Malformed JSON → backend không crash.
- Unknown controller/topic → bỏ qua, log an toàn.
- **Duplicate command-result (QoS1)** → áp đúng một lần, không lùi trạng thái.

### Commands

- Authorized user (owner + canControlDrone) gửi được command.
- User không sở hữu ark → 403/404.
- GUEST → 403.
- Command lưu trước khi publish.
- `ACCEPTED`/`SUCCEEDED` cập nhật đúng record (forward-transition).
- Command hết hạn → `EXPIRED` (sweeper).
- **Double POST cùng Idempotency-Key → một command, actuator chạy một lần.**
- Controller OFFLINE khi gửi → `FAILED(OFFLINE)`/`EXPIRED`, không queue.
- PUBACK không tự chuyển `SUCCEEDED`.
- Backend restart giữa PUBLISHED và result → không kẹt vĩnh viễn (reconcile).

### Hardware safety

- Relay safe state sau boot; state = UNKNOWN cho tới khi sensor đọc.
- Motor dừng khi timeout.
- Không open + close đồng thời.
- Sensor xác nhận đúng OPEN/CLOSED.
- Hardware fault publish về backend.
- ESP32 reboot khi drawer đang chạy → boot safe, command cũ đã EXPIRED, launch bị chặn.

### Launch-gating

- Drone có `drawer_controller_id` và drawer `OPEN` → cho phép.
- Drawer ≠ OPEN hoặc `drawer_controller_id IS NULL` → chặn.

## 17. MVP acceptance criteria

1. ESP32/simulator tự kết nối Wi-Fi và gọi registration sau boot.
2. Một MAC ↔ đúng một `drawer_controller` (kể cả khi request đồng thời).
3. ESP32 nhận `controllerId` ổn định qua nhiều lần reboot.
4. ESP32/simulator kết nối MQTT và hiển thị online ở backend.
5. App/API gửi được bốn command MVP theo `arkId + controllerId`.
6. Backend theo dõi command từ `PENDING` → `SUCCEEDED`/`FAILED`/`REJECTED`/`EXPIRED`.
7. ESP32 publish state sau khi thực hiện command.
8. Command trùng (Idempotency-Key) hoặc hết hạn không làm actuator chạy lại.
9. Mất kết nối được phát hiện (LWT + heartbeat) và controller chuyển offline.
10. Command không kẹt sau backend restart (reconciler chạy).
11. Mapping drone↔controller tồn tại và launch-gating hoạt động theo `drawer_state`.
12. Các test registration/MQTT/command/safety quan trọng đều pass.

## 18. Rủi ro MVP & mốc phải sửa

| Rủi ro | Local prototype | Trước pilot | Trước production |
| --- | :---: | :---: | :---: |
| Shared controller API key | Chấp nhận | Key per-controller | Token/cert per-device |
| Shared MQTT credential | Chấp nhận | Broker ACL per controllerId | mTLS per-device |
| HTTP/MQTT không TLS (LAN) | Chấp nhận | `mqtts://` + HTTPS | Bắt buộc + HSTS |
| MAC spoofing | Chấp nhận | Hạn chế qua ACL | Device attestation |
| Secret hardcode trong firmware | Chấp nhận | Provisioning riêng | Secure boot + flash encryption |
| Suy `OPEN` từ timeout | Chấp nhận (LED) | **Limit switch bắt buộc** | — |
| Tin command-result cho launch | Chấp nhận | Đối chiếu retained state/sensor | — |

## 19. Hướng nâng cấp sau MVP

- Tách `dock_drawers` vật lý nếu 1 controller điều khiển nhiều ngăn.
- Reconcile `arks.drone_count`/`dock_status` từ `drones`/`drawer_state` (view/trigger).
- Activation code/QR để claim controller vào ark.
- Credential/certificate riêng cho từng ESP32; MQTT over TLS + HTTPS bắt buộc.
- Broker ACL theo device/client ID.
- Secure boot, flash encryption, signed OTA; credential rotation/revocation.
- WebSocket/SSE để App nhận realtime state (thay polling).
- device_events retention/rollup; metrics, alerts, firmware rollout theo batch.
