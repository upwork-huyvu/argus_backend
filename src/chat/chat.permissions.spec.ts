/**
 * Unit tests for ChatService guard logic. Runs offline against a hand-stubbed
 * SupabaseService — the real admin client is never touched. Covers the rules
 * the product guarantees:
 *
 *   - Guests can only open threads with OPERATOR / ADMIN targets.
 *   - Guests can't talk to themselves.
 *   - Inactive targets are rejected.
 *   - Guests can't emit SYSTEM messages.
 *   - Only participants can send / read a thread.
 */
import { ChatService } from "./chat.service";

type Handler = (...args: any[]) => any;

function stubThreadRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "t1",
    guest_id: "guest1",
    operator_id: "op1",
    subject: "hi",
    status: "open",
    last_message_at: null,
    last_message_preview: null,
    unread_for_guest: 0,
    unread_for_operator: 0,
    metadata: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function stubUserRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "op1",
    full_name: "Op",
    username: "op",
    avatar_url: null,
    role: "OPERATOR",
    is_active: true,
    last_login_at: null,
    ...overrides,
  };
}

/**
 * Build a minimal fake `admin` client from a manifest of table → handler.
 * The handler receives the chained call arguments and returns the next table
 * (or final row). Keeps tests readable vs. mocking Supabase's fluent API.
 */
function makeSupabaseStub(tables: Record<string, Handler>) {
  const builder = (table: string) => tables[table]?.();
  return { from: builder, auth: {} };
}

describe("ChatService — guest ↔ operator rules", () => {
  it("rejects createThread when target is GUEST", async () => {
    const supabase: any = {
      getAdminClient: () =>
        makeSupabaseStub({
          app_users: () => ({
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: stubUserRow({ role: "GUEST" }), error: null }),
              }),
            }),
          }),
        }),
    };
    const svc = new ChatService(supabase);
    await expect(
      svc.createThread("guest1", { operatorId: "someGuest", subject: "hi" }),
    ).rejects.toThrow(/operators or admins/i);
  });

  it("rejects createThread when target is inactive", async () => {
    const supabase: any = {
      getAdminClient: () =>
        makeSupabaseStub({
          app_users: () => ({
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: stubUserRow({ is_active: false }),
                  error: null,
                }),
              }),
            }),
          }),
        }),
    };
    const svc = new ChatService(supabase);
    await expect(
      svc.createThread("guest1", { operatorId: "op1", subject: "hi" }),
    ).rejects.toThrow(/inactive/i);
  });

  it("rejects createThread when guest targets themselves", async () => {
    const supabase: any = {
      getAdminClient: () =>
        makeSupabaseStub({
          app_users: () => ({
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: stubUserRow({ id: "guest1", role: "OPERATOR" }),
                  error: null,
                }),
              }),
            }),
          }),
        }),
    };
    const svc = new ChatService(supabase);
    await expect(
      svc.createThread("guest1", { operatorId: "guest1", subject: "hi" }),
    ).rejects.toThrow(/yourself/i);
  });

  it("rejects GUEST sending a SYSTEM message", async () => {
    const supabase: any = {
      getAdminClient: () =>
        makeSupabaseStub({
          chat_threads: () => ({
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: stubThreadRow(), error: null }),
              }),
            }),
          }),
        }),
    };
    const svc = new ChatService(supabase);
    await expect(
      svc.sendMessage("guest1", "GUEST", "t1", {
        body: "dispatch!",
        messageType: "system",
      }),
    ).rejects.toThrow(/Guests cannot send system/);
  });

  it("rejects non-participant from sending", async () => {
    const supabase: any = {
      getAdminClient: () =>
        makeSupabaseStub({
          chat_threads: () => ({
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: stubThreadRow({ guest_id: "someone", operator_id: "other" }),
                  error: null,
                }),
              }),
            }),
          }),
        }),
    };
    const svc = new ChatService(supabase);
    await expect(
      svc.sendMessage("intruder", "OPERATOR", "t1", { body: "hi" }),
    ).rejects.toThrow(/Not a participant/);
  });
});
