# Argus Backend API (Swagger-style)

Base URL:
- Local dev: `http://localhost:3001`
- Vercel: `https://<your-project>.vercel.app` — UI at `/docs`, spec at `/docs-json` (root `/` redirects to `/docs`)

**Vercel note:** Keep `@nestjs/swagger`, `swagger-ui-express`, and **`swagger-ui-dist`** in **`dependencies`**. Nest on Vercel is zero-config from `src/main.ts` — do **not** set `vercel.json` `functions` on a path like `src/main.ts` (Vercel only matches patterns under `api/` for that field and the build fails). `setup-swagger.ts` uses `require.resolve` on concrete `swagger-ui-dist` files so the bundler traces those assets.

Swagger UI:
- `GET /docs` (root `/` → 302 to `/docs`)
- OpenAPI JSON: `GET /docs-json`

---

## Auth

All protected endpoints require a bearer token:

**Header**
- `Authorization: Bearer <accessToken>`

The backend issues `accessToken` via:
- `POST /auth/login`
- `POST /auth/register`

---

## Error format (all endpoints)

Non-2xx responses return:
```json
{ "message": "string" }
```

Common status codes:
- `401` invalid/expired token or invalid credentials
- `403` forbidden (permissions)
- `404` unknown ids
- `400` validation errors

---

## Types

### DeploymentType
`construction | commercial | school | sports | estate | residential`

### UserRole
`treycor_operator | client_admin | viewer`

### Mission
```json
{
  "id": "string",
  "name": "string",
  "description": "string",
  "duration": "string",
  "enabled": true,
  "editable": false,
  "customizable": true
}
```

### DeploymentProfile
```json
{
  "id": "deployment_type",
  "name": "string",
  "location": "string",
  "missions": [
    {
      "id": "string",
      "name": "string",
      "description": "string",
      "duration": "string",
      "enabled": true,
      "editable": false,
      "customizable": true
    }
  ],
  "constraints": {
    "maxCustomMissions": 0,
    "canEditMissions": true,
    "canToggleMissions": true
  }
}
```

### DashboardKpi
```json
{ "label": "string", "value": "string", "change": "string" }
```

### SystemAlert
```json
{
  "id": "string",
  "title": "string",
  "message": "string",
  "time": "string",
  "tone": "critical | warning | success | info"
}
```

### Ark / Drone Unit
```json
{
  "id": "ark-01",
  "name": "string",
  "location": "string",
  "status": "online | offline",
  "power": 0,
  "network": "string",
  "coreTemp": 0,
  "dockStatus": "locked | unlocked",
  "droneCount": 0,
  "threatLevel": "low | medium | high",
  "lastSync": "string",
  "firmware": "string",
  "operator": "string",
  "deploymentType": "string",
  "heroImage": "string or null",
  "perimeterStatus": "string or null",
  "visitorMonitoring": "string or null",
  "lpr": "string or null",
  "nightPatrol": "string or null",
  "gateIntegration": "string or null"
}
```

### Auth success response
```json
{
  "accessToken": "string",
  "user": {
    "name": "string",
    "username": "string",
    "role": "treycor_operator | client_admin | viewer",
    "permissions": {
      "fullControl": true,
      "canCustomize": true,
      "canEdit": true,
      "canToggle": true,
      "canDuplicate": true
    }
  }
}
```

---

## Endpoints

### 1) Auth - Login
`POST /auth/login`

Request body:
```json
{ "username": "string", "password": "string" }
```

Success (200):
```json
{
  "accessToken": "string",
  "user": { "name": "string", "username": "string", "role": "treycor_operator|client_admin|viewer", "permissions": { "fullControl": true, "canCustomize": true, "canEdit": true, "canToggle": true, "canDuplicate": true } }
}
```

Error (401):
```json
{ "message": "Invalid credentials." }
```

Example (curl):
```bash
curl -sS -X POST "http://localhost:3001/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin"}'
```

---

### 2) Auth - Register
`POST /auth/register`

Request body:
```json
{
  "name": "string",
  "username": "string",
  "password": "string",
  "role": "treycor_operator|client_admin|viewer"
}
```

Notes:
- `role` is optional; if omitted backend defaults to `viewer`.

Success (200): same response shape as login.

Example (curl):
```bash
curl -sS -X POST "http://localhost:3001/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"name":"Demo User","username":"client","password":"admin","role":"client_admin"}'
```

---

### 3) Deployments (hydrated missions)
`GET /deployments`
Protected

Returns: `DeploymentProfile[]`

---

### 4) Deployments (single, hydrated missions)
`GET /deployments/{deploymentId}`
Protected

Path params:
- `deploymentId`:
  - `construction | commercial | school | sports | estate | residential`

Returns: `DeploymentProfile`

Error (404):
```json
{ "message": "Unknown deployment id." }
```

---

### 5) Toggle mission
`POST /deployments/{deploymentId}/missions/{missionId}/toggle`
Protected

Path params:
- `deploymentId`: one of DeploymentType
- `missionId`: string (template mission id or `custom_*` id)

Success (200):
```json
{ "deployment": { "id": "deployment_type", "name": "string", "location": "string", "missions": [], "constraints": { "maxCustomMissions": 0, "canEditMissions": true, "canToggleMissions": true } } }
```

Permissions / enforcement:
- toggling requires the authenticated user's `permissions.canToggle === true`

Errors:
- `403`:
```json
{ "message": "Forbidden." }
```
- `404`:
```json
{ "message": "Unknown deployment or mission id." }
```

---

### 6) Duplicate mission
`POST /deployments/{deploymentId}/missions/{missionId}/duplicate`
Protected

Path params:
- `deploymentId`: one of DeploymentType
- `missionId`: string (source mission instance id)

Success (200):
```json
{ "deployment": { "id": "deployment_type", "name": "string", "location": "string", "missions": [], "constraints": { "maxCustomMissions": 0, "canEditMissions": true, "canToggleMissions": true } } }
```

Permissions / enforcement:
- duplication requires authenticated user's `permissions.canDuplicate === true`
- custom mission ids created by backend must start with `custom_`
- `maxCustomMissions` enforced per deployment type and per user

Errors:
- `403`:
```json
{ "message": "Forbidden." }
```
- `400` (custom mission limit reached):
```json
{ "message": "Custom mission limit reached." }
```
- `404` unknown mission:
```json
{ "message": "Unknown mission id." }
```

---

### 7) Dashboard KPIs
`GET /deployments/{deploymentId}/dashboard-kpis`
Protected

Returns: `DashboardKpi[]`

---

### 8) Alerts
`GET /deployments/{deploymentId}/alerts`
Protected

Returns: `SystemAlert[]`

---

### 9) ARKs (drone units)
`GET /arks`
Protected

Returns: `Ark[]`

Notes:
- `heroImage` is a web-path string or `null` (RN resolves it via `src/lib/ark-hero-sources.ts`)

