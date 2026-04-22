# Chat feature

Realtime messaging between guests and operators/admins.

- Guests can open a thread with an OPERATOR or ADMIN only. Guest↔guest is
  blocked at the DB layer (CHECK + trigger) and at the BE layer (role
  lookup before `INSERT`).
- Operators / admins see every thread where they are `operator_id`.
- Admin superset semantics (view ALL threads) is deferred until a real
  use case surfaces.

## Data model

### `chat_threads`
| Column | Type | Notes |
|---|---|---|
| `id` | uuid | pk |
| `guest_id` | uuid | fk auth.users ON DELETE CASCADE |
| `operator_id` | uuid | fk auth.users ON DELETE CASCADE |
| `subject` | text | one-line inbox label |
| `status` | `chat_thread_status` | `open` / `accepted` / `closed` |
| `last_message_at` | timestamptz | trigger-updated |
| `last_message_preview` | text | 140-char snippet |
| `unread_for_guest` | int | trigger-updated when the other side sends |
| `unread_for_operator` | int | trigger-updated when the other side sends |
| `metadata` | jsonb | priority, tags, etc |
| `created_at` / `updated_at` | timestamptz |  |

Constraint: `guest_id <> operator_id`.

### `chat_messages`
| Column | Type | Notes |
|---|---|---|
| `id` | uuid | pk |
| `thread_id` | uuid | fk CASCADE |
| `sender_id` | uuid \| null | fk, null on user-deleted rows |
| `sender_role` | text | `GUEST` / `OPERATOR` / `ADMIN` / `SYSTEM` |
| `body` | text | |
| `message_type` | text | `text` / `system` / `attachment` |
| `metadata` | jsonb | |
| `created_at` | timestamptz | indexed `(thread_id, created_at desc)` |

### Triggers
- `handle_new_chat_message()` bumps `last_message_*` + the
  counterpart's `unread_for_*` on every insert. SYSTEM messages only
  update preview.
- `set_updated_at()` keeps `chat_threads.updated_at` in sync.

### RLS
- `chat_threads` / `chat_messages` are participant-only for `select`;
  writes flow through the backend (service_role). Realtime publication
  `supabase_realtime` includes both tables.

## REST API (`/chat/*`)

All routes require `JwtAuthGuard`. `RolesGuard` is applied where the
operation is role-specific.

| Method | Path | Role | Body |
|---|---|:-:|---|
| `GET`  | `/chat/operators`                 | GUEST       | — |
| `GET`  | `/chat/threads`                   | any         | — |
| `POST` | `/chat/threads`                   | GUEST       | `{ operatorId, subject, initialMessage? }` |
| `GET`  | `/chat/threads/:id/messages`      | participant | query `before` (ISO), `limit` (≤200) |
| `POST` | `/chat/threads/:id/messages`      | participant | `{ body, messageType? }` |
| `PATCH`| `/chat/threads/:id/read`          | participant | — |

### Thread DTO (shape returned to RN)
```
{
  id, subject, status,
  lastMessageAt, lastMessagePreview, unreadCount,
  counterpart: { id, fullName, username, avatarUrl, role, isOnline },
  createdAt,
}
```

`counterpart.isOnline` is a 5-minute threshold on `last_login_at`. We
skip a true Presence channel in v1; revisit when we need "typing…".

### Message DTO
```
{
  id, threadId, senderId, senderRole,
  body, messageType, createdAt,
}
```

## Realtime

Client subscribes to `supabase_realtime` publication via
`@supabase/supabase-js`. The RN `ChatContext` opens ONE channel per
user and fans INSERTs out to per-thread listeners, so page navigation
doesn't cause websocket churn.

Auth refresh: when `accessToken` changes, `supabase-client.ts` returns
a new client and `ChatContext`'s effect re-subscribes (dependency on
`user?.id`). For shorter-lived tokens, add a token-refresh listener.

## Role rules enforced server-side

- `POST /chat/threads` looks up target user and rejects with 403 if
  target isn't OPERATOR or ADMIN.
- `POST /chat/threads/:id/messages` verifies the caller is a
  participant of the thread.
- Only OPERATOR/ADMIN can emit `messageType: "system"`; guests sending
  `system` get 403.
- First OPERATOR/ADMIN text reply flips thread `status` to `accepted`.

## Known limits (v1)

- No attachments yet — schema has `attachment` type reserved.
- Presence is derived (5-min threshold); no live "typing" indicator.
- Admin superset view isn't implemented; admins only see threads they
  are assigned as `operator_id`.
- Realtime token refresh is event-driven; long-idle sessions may need
  manual `subscribe()` re-entry after 1+ hour.
- System messages ("Patrol dispatched") are currently operator-emitted;
  drone-dispatch events don't auto-post.
