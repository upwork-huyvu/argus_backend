import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { SupabaseService } from "../common/supabase/supabase.service";
import { normalizeRole, type UserRole } from "../common/permissions";
import type { CreateThreadDto } from "./dto/create-thread.dto";
import type { SendMessageDto } from "./dto/send-message.dto";

type ThreadRow = {
  id: string;
  guest_id: string;
  operator_id: string;
  subject: string;
  status: string;
  last_message_at: string | null;
  last_message_preview: string | null;
  unread_for_guest: number;
  unread_for_operator: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

type ProfileLite = {
  id: string;
  full_name: string | null;
  username: string | null;
  avatar_url: string | null;
  role: string;
  last_login_at: string | null;
};

type MessageRow = {
  id: string;
  thread_id: string;
  sender_id: string | null;
  sender_role: "GUEST" | "OPERATOR" | "ADMIN" | "SYSTEM";
  body: string;
  message_type: "text" | "system" | "attachment";
  metadata: Record<string, unknown>;
  created_at: string;
};

export type ThreadDto = {
  id: string;
  subject: string;
  status: string;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unreadCount: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  counterpart: {
    id: string;
    fullName: string | null;
    username: string | null;
    avatarUrl: string | null;
    role: UserRole;
    isOnline: boolean;
  };
};

export type MessageDto = {
  id: string;
  threadId: string;
  senderId: string | null;
  senderRole: "GUEST" | "OPERATOR" | "ADMIN" | "SYSTEM";
  body: string;
  messageType: "text" | "system" | "attachment";
  metadata: Record<string, unknown>;
  createdAt: string;
};

const ONLINE_THRESHOLD_MINUTES = 5;

@Injectable()
export class ChatService {
  constructor(private readonly supabase: SupabaseService) {}

  // ---------------------------------------------------------------------------
  // Available operators — what a guest sees when picking who to chat with.
  // ---------------------------------------------------------------------------
  async listOperators(): Promise<
    Array<Pick<ThreadDto["counterpart"], "id" | "fullName" | "username" | "avatarUrl" | "role" | "isOnline">>
  > {
    const admin = this.supabase.getAdminClient();
    const { data, error } = await admin
      .from("app_users")
      .select("id,full_name,username,avatar_url,role,last_login_at,is_active")
      .in("role", ["OPERATOR", "ADMIN"])
      .eq("is_active", true)
      .order("full_name", { ascending: true })
      .returns<Array<ProfileLite & { is_active: boolean }>>();

    if (error) throw new BadRequestException(error.message);
    return (data ?? []).map((r) => ({
      id: r.id,
      fullName: r.full_name,
      username: r.username,
      avatarUrl: r.avatar_url,
      role: normalizeRole(r.role),
      isOnline: this.isOnline(r.last_login_at),
    }));
  }

  // ---------------------------------------------------------------------------
  // Threads — list / create
  // ---------------------------------------------------------------------------
  async listThreads(userId: string, role: UserRole): Promise<ThreadDto[]> {
    const admin = this.supabase.getAdminClient();
    const col = role === "GUEST" ? "guest_id" : "operator_id";
    const { data, error } = await admin
      .from("chat_threads")
      .select("*")
      .eq(col, userId)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .returns<ThreadRow[]>();
    if (error) throw new BadRequestException(error.message);

    const rows = data ?? [];
    if (rows.length === 0) return [];

    // Resolve counterpart profiles in one query.
    const counterpartIds = Array.from(
      new Set(rows.map((r) => (role === "GUEST" ? r.operator_id : r.guest_id))),
    );
    const { data: profiles, error: profErr } = await admin
      .from("app_users")
      .select("id,full_name,username,avatar_url,role,last_login_at")
      .in("id", counterpartIds)
      .returns<ProfileLite[]>();
    if (profErr) throw new BadRequestException(profErr.message);
    const byId = new Map((profiles ?? []).map((p) => [p.id, p]));

    return rows.map((r) => this.toThreadDto(r, role, byId.get(this.counterpartId(r, role))));
  }

  async createThread(guestUserId: string, body: CreateThreadDto): Promise<ThreadDto> {
    const admin = this.supabase.getAdminClient();

    // Validate target is OPERATOR or ADMIN and active.
    const { data: target, error: tErr } = await admin
      .from("app_users")
      .select("id,full_name,username,avatar_url,role,is_active,last_login_at")
      .eq("id", body.operatorId)
      .maybeSingle<ProfileLite & { is_active: boolean }>();
    if (tErr) throw new BadRequestException(tErr.message);
    if (!target) throw new NotFoundException("Target user not found.");
    const targetRole = normalizeRole(target.role);
    if (targetRole !== "OPERATOR" && targetRole !== "ADMIN") {
      throw new ForbiddenException("Can only open threads with operators or admins.");
    }
    if (!target.is_active) {
      throw new ForbiddenException("Target user is inactive.");
    }
    if (target.id === guestUserId) {
      throw new ForbiddenException("Cannot open a thread with yourself.");
    }

    const subject = body.subject.trim();
    if (!subject) throw new BadRequestException("Subject is required.");

    const { data: thread, error: insErr } = await admin
      .from("chat_threads")
      .insert({
        guest_id: guestUserId,
        operator_id: target.id,
        subject,
        status: "open",
      })
      .select("*")
      .maybeSingle<ThreadRow>();
    if (insErr || !thread) {
      throw new BadRequestException(insErr?.message ?? "Unable to create thread.");
    }

    // Optional initial message — posted as the guest.
    if (body.initialMessage?.trim()) {
      await admin.from("chat_messages").insert({
        thread_id: thread.id,
        sender_id: guestUserId,
        sender_role: "GUEST",
        body: body.initialMessage.trim(),
        message_type: "text",
      });
      // Re-read to get the refreshed last_message_* fields from the trigger.
      const { data: refreshed } = await admin
        .from("chat_threads")
        .select("*")
        .eq("id", thread.id)
        .maybeSingle<ThreadRow>();
      if (refreshed) {
        return this.toThreadDto(refreshed, "GUEST", {
          id: target.id,
          full_name: target.full_name,
          username: target.username,
          avatar_url: target.avatar_url,
          role: target.role,
          last_login_at: target.last_login_at,
        });
      }
    }

    return this.toThreadDto(thread, "GUEST", {
      id: target.id,
      full_name: target.full_name,
      username: target.username,
      avatar_url: target.avatar_url,
      role: target.role,
      last_login_at: target.last_login_at,
    });
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------
  async listMessages(
    userId: string,
    threadId: string,
    before: string | undefined,
    limit: number,
  ): Promise<MessageDto[]> {
    await this.ensureParticipant(userId, threadId);
    const admin = this.supabase.getAdminClient();
    let query = admin
      .from("chat_messages")
      .select("*")
      .eq("thread_id", threadId)
      .order("created_at", { ascending: false })
      .limit(Math.min(Math.max(limit, 1), 200));
    if (before) query = query.lt("created_at", before);
    const { data, error } = await query.returns<MessageRow[]>();
    if (error) throw new BadRequestException(error.message);
    return (data ?? []).map(this.toMessageDto).reverse(); // oldest first for UI consumption
  }

  async sendMessage(
    userId: string,
    role: UserRole,
    threadId: string,
    body: SendMessageDto,
  ): Promise<MessageDto> {
    const thread = await this.ensureParticipant(userId, threadId);
    const text = body.body.trim();
    if (!text) throw new BadRequestException("Message body is required.");

    // Guests cannot emit system messages; the UX path for that is operator-only.
    const messageType = body.messageType ?? "text";
    if (messageType === "system" && role === "GUEST") {
      throw new ForbiddenException("Guests cannot send system messages.");
    }

    const senderRole =
      messageType === "system" ? "SYSTEM" : (role as "GUEST" | "OPERATOR" | "ADMIN");

    const admin = this.supabase.getAdminClient();
    const { data, error } = await admin
      .from("chat_messages")
      .insert({
        thread_id: threadId,
        sender_id: userId,
        sender_role: senderRole,
        body: text,
        message_type: messageType,
      })
      .select("*")
      .maybeSingle<MessageRow>();
    if (error || !data) {
      throw new BadRequestException(error?.message ?? "Unable to send message.");
    }

    // If the first message from an operator on an "open" thread, flip to "accepted".
    if (role !== "GUEST" && thread.status === "open" && messageType === "text") {
      await admin.from("chat_threads").update({ status: "accepted" }).eq("id", threadId);
    }
    return this.toMessageDto(data);
  }

  async markRead(userId: string, threadId: string, role: UserRole): Promise<void> {
    await this.ensureParticipant(userId, threadId);
    const admin = this.supabase.getAdminClient();
    const update = role === "GUEST" ? { unread_for_guest: 0 } : { unread_for_operator: 0 };
    const { error } = await admin.from("chat_threads").update(update).eq("id", threadId);
    if (error) throw new BadRequestException(error.message);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  private async ensureParticipant(userId: string, threadId: string): Promise<ThreadRow> {
    const admin = this.supabase.getAdminClient();
    const { data, error } = await admin
      .from("chat_threads")
      .select("*")
      .eq("id", threadId)
      .maybeSingle<ThreadRow>();
    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException("Thread not found.");
    if (data.guest_id !== userId && data.operator_id !== userId) {
      throw new ForbiddenException("Not a participant of this thread.");
    }
    return data;
  }

  private counterpartId(row: ThreadRow, role: UserRole): string {
    return role === "GUEST" ? row.operator_id : row.guest_id;
  }

  private toThreadDto(
    row: ThreadRow,
    viewerRole: UserRole,
    counterpart: ProfileLite | undefined,
  ): ThreadDto {
    const unread =
      viewerRole === "GUEST" ? row.unread_for_guest : row.unread_for_operator;
    return {
      id: row.id,
      subject: row.subject,
      status: row.status,
      lastMessageAt: row.last_message_at,
      lastMessagePreview: row.last_message_preview,
      unreadCount: unread,
      metadata: row.metadata ?? {},
      createdAt: row.created_at,
      counterpart: {
        id: counterpart?.id ?? "",
        fullName: counterpart?.full_name ?? null,
        username: counterpart?.username ?? null,
        avatarUrl: counterpart?.avatar_url ?? null,
        role: normalizeRole(counterpart?.role),
        isOnline: this.isOnline(counterpart?.last_login_at ?? null),
      },
    };
  }

  private toMessageDto = (row: MessageRow): MessageDto => ({
    id: row.id,
    threadId: row.thread_id,
    senderId: row.sender_id,
    senderRole: row.sender_role,
    body: row.body,
    messageType: row.message_type,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
  });

  private isOnline(lastLoginAt: string | null): boolean {
    if (!lastLoginAt) return false;
    const diffMin = (Date.now() - new Date(lastLoginAt).getTime()) / 60_000;
    return diffMin <= ONLINE_THRESHOLD_MINUTES;
  }
}
