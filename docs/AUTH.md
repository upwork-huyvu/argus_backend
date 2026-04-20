# Argus Auth (Phase A)

Argus uses **Supabase Auth** as the identity provider. The backend is a thin
wrapper that:

1. Proxies `auth.signUp` / `signInWithPassword` / `resetPasswordForEmail` /
   `updateUser` calls.
2. Maintains a `public.app_users` profile row (1-to-1 with `auth.users`).
3. Verifies incoming Supabase JWTs and enforces app-level roles
   (`GUEST` / `OPERATOR` / `ADMIN`).

---

## Required env vars

| Var | Required | Purpose |
|-----|:-:|---|
| `SUPABASE_URL` | ✓ | Project URL |
| `SUPABASE_ANON_KEY` | ✓ | Client-facing key (RLS applies) |
| `SUPABASE_SERVICE_ROLE_KEY` | ✓ | Backend admin ops (bypass RLS) |
| `SUPABASE_JWT_SECRET` | ✓ | HS256 secret Supabase uses to sign access tokens. `JwtAuthGuard` verifies with this. |
| `PASSWORD_RESET_REDIRECT_URL` | — | Target of the reset-password email link. Default `argusrn://reset-password`. |
| `JWT_SECRET` | — | Legacy fallback. Still accepted by `JwtAuthGuard` if `SUPABASE_JWT_SECRET` is missing — plan to remove. |

---

## Roles

| Role | Can control drone | Can manage users | Can edit missions |
|------|:-:|:-:|:-:|
| `GUEST`    | ✗ | ✗ | ✗ |
| `OPERATOR` | ✓ | ✗ | ✓ |
| `ADMIN`    | ✓ | ✓ | ✓ |

Canonical source: [`src/common/permissions.ts`](../src/common/permissions.ts).
Legacy role values are mapped automatically via `normalizeRole()`:

| Legacy | Current |
|---|---|
| `client_admin`     | `ADMIN`    |
| `treycor_operator` | `OPERATOR` |
| `viewer`           | `GUEST`    |

---

## Endpoints

All `POST` bodies are JSON; responses are JSON. `Authorization: Bearer <jwt>` is
the Supabase access token returned by `/auth/login`.

### `POST /auth/register`

Self-registration. Always assigns `GUEST`.

```json
{
  "email": "jane@argus.io",
  "password": "P@ssw0rd1!",
  "fullName": "Jane Doe",
  "phone": "+1-407-555-0101",
  "organization": "Argus Security Inc."
}
```

Response → `SessionResponse` (see below). When email-confirmation is enabled
on the Supabase project, `accessToken` is empty until the user clicks the
verification link; the FE should redirect to login.

### `POST /auth/login`

```json
{ "email": "jane@argus.io", "password": "P@ssw0rd1!" }
```

Response: **SessionResponse**

```json
{
  "accessToken": "eyJhbGci…",
  "refreshToken": "eyJhbGci…",
  "expiresAt": 1745126400,
  "user": {
    "id": "…uuid…",
    "email": "jane@argus.io",
    "fullName": "Jane Doe",
    "phone": "+1-407-555-0101",
    "organization": "Argus Security Inc.",
    "avatarUrl": null,
    "role": "GUEST",
    "isActive": true,
    "permissions": {
      "canControlDrone": false,
      "canManageUsers": false,
      "canEditMissions": false,
      "canViewDashboard": true
    }
  }
}
```

### `POST /auth/forgot-password`

```json
{ "email": "jane@argus.io" }
```

Always returns `{ "sent": true }` (no account enumeration).

### `POST /auth/change-password` (auth required)

```json
{ "currentPassword": "…", "newPassword": "N3wP@ss!23" }
```

Returns `{ "ok": true }`. Rejects if `currentPassword` is wrong.

### `POST /auth/refresh`

```json
{ "refreshToken": "eyJhbGci…" }
```

Returns a fresh `SessionResponse`.

### `POST /auth/logout` (auth required)

Revokes all refresh tokens for the caller globally. Returns `{ "ok": true }`.

### `GET /auth/me` (auth required)

Returns the `user` portion of `SessionResponse` for the caller.

---

## Admin endpoints (`ADMIN` only)

Headers: `Authorization: Bearer <admin-jwt>`

| Method | Path | Purpose |
|---|---|---|
| `GET`   | `/admin/users`              | List all profiles |
| `POST`  | `/admin/users`              | Create user (skips email confirmation; body = `RegisterRequestDto` + explicit `role`) |
| `PATCH` | `/admin/users/:id/role`     | `{ "role": "OPERATOR" }` |
| `PATCH` | `/admin/users/:id/active`   | `{ "isActive": false }` — also revokes Supabase sessions |

---

## Client integration notes

- Persist `accessToken` and `refreshToken` on the RN side.
- When a request returns `401`, call `/auth/refresh`; if that also fails, force
  logout.
- Always include `user.role` / `user.permissions` in the auth context — UI
  guards must match server guards (see `RolesGuard` and `canControlDrone`).

---

## Guards

- [`JwtAuthGuard`](../src/common/auth/jwt-auth.guard.ts) — verifies Supabase
  HS256 JWT, loads the profile row, rejects deactivated users.
- [`RolesGuard`](../src/common/auth/roles.guard.ts) — enforces `@Roles(...)`
  metadata on handlers / controllers.

```ts
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("OPERATOR", "ADMIN")
@Post("takeoff")
takeoff() { /* ... */ }
```
