# Drawer-controller simulator

Node.js stand-in for the ESP32. Same registration + MQTT contract as the
firmware, so the backend is fully testable without hardware (plan §15 Phase 3).

## Prerequisites

1. MQTT broker running: `docker compose -f docker-compose.mqtt.yml up -d`
2. Backend running: `npm run start:dev` (needs `CONTROLLER_API_KEY` + `MQTT_URL`
   in `.env.development`).

## Run

```bash
# from the ArgusBE repo root (uses the repo's node_modules `mqtt`)
node tools/drawer-simulator/simulator.mjs
```

Then assign the controller to an ark (admin) and send a command:

```bash
# 1. Find the controllerId (admin token required)
curl -H "Authorization: Bearer <ADMIN_JWT>" http://localhost:3333/drawer-controllers

# 2. Assign + activate it under an ark you own
curl -X PATCH -H "Authorization: Bearer <ADMIN_JWT>" -H "Content-Type: application/json" \
  -d '{"arkId":"ark-01"}' \
  http://localhost:3333/drawer-controllers/<controllerId>/assign

# 3. Send a command (OPERATOR/ADMIN, owns the ark)
curl -X POST -H "Authorization: Bearer <JWT>" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"type":"DRAWER_OPEN","expiresInSeconds":15}' \
  http://localhost:3333/arks/ark-01/drawer-controllers/<controllerId>/commands
```

## Failure-mode flags

| Env | Effect | Tests |
| --- | --- | --- |
| `FAIL_MODE=none` (default) | ACCEPTED → SUCCEEDED | happy path |
| `FAIL_MODE=fail` | ACCEPTED → FAILED + event | motor-timeout handling |
| `FAIL_MODE=timeout` | ACCEPTED, no terminal result | backend reconciler → EXPIRED |
| `FAIL_MODE=duplicate` | SUCCEEDED emitted twice | backend result dedup |

Other env: `MAC`, `API_BASE_URL`, `MQTT_URL`, `CONTROLLER_API_KEY`, `MOVE_MS`.
Run multiple with different `MAC` values to simulate an ark with several drawers.
