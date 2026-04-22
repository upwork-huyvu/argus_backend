import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "../common/auth/jwt-auth.guard";
import { RolesGuard } from "../common/auth/roles.guard";
import { Roles } from "../common/auth/roles.decorator";
import { ChatService } from "./chat.service";
import { CreateThreadDto } from "./dto/create-thread.dto";
import { SendMessageDto } from "./dto/send-message.dto";

const ThreadCounterpartSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    fullName: { type: "string", nullable: true },
    username: { type: "string", nullable: true },
    avatarUrl: { type: "string", nullable: true },
    role: { type: "string", enum: ["GUEST", "OPERATOR", "ADMIN"] },
    isOnline: { type: "boolean" },
  },
};

const ThreadSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    subject: { type: "string" },
    status: { type: "string", enum: ["open", "accepted", "closed"] },
    lastMessageAt: { type: "string", nullable: true },
    lastMessagePreview: { type: "string", nullable: true },
    unreadCount: { type: "number" },
    counterpart: ThreadCounterpartSchema,
    createdAt: { type: "string" },
  },
};

const MessageSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    threadId: { type: "string" },
    senderId: { type: "string", nullable: true },
    senderRole: { type: "string", enum: ["GUEST", "OPERATOR", "ADMIN", "SYSTEM"] },
    body: { type: "string" },
    messageType: { type: "string", enum: ["text", "system", "attachment"] },
    createdAt: { type: "string" },
  },
};

@Controller("chat")
@ApiTags("chat")
@ApiBearerAuth("bearerAuth")
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  // ─── Operators picker (guest flow) ──────────────────────────────────────────
  @Get("operators")
  @UseGuards(RolesGuard)
  @Roles("GUEST")
  @ApiOkResponse({ schema: { type: "array", items: ThreadCounterpartSchema } })
  async listOperators() {
    return this.chat.listOperators();
  }

  // ─── Threads ────────────────────────────────────────────────────────────────
  @Get("threads")
  @ApiOkResponse({ schema: { type: "array", items: ThreadSchema } })
  async listThreads(@Req() req: Request) {
    return this.chat.listThreads(req.user!.userId, req.user!.role);
  }

  @Post("threads")
  @UseGuards(RolesGuard)
  @Roles("GUEST")
  @ApiBody({ type: CreateThreadDto })
  @ApiOkResponse({ schema: ThreadSchema })
  async createThread(@Req() req: Request, @Body() body: CreateThreadDto) {
    return this.chat.createThread(req.user!.userId, body);
  }

  // ─── Messages ───────────────────────────────────────────────────────────────
  @Get("threads/:id/messages")
  @ApiQuery({ name: "before", required: false, description: "ISO timestamp cursor (exclusive)." })
  @ApiQuery({ name: "limit", required: false, description: "Default 50; max 200." })
  @ApiOkResponse({ schema: { type: "array", items: MessageSchema } })
  async listMessages(
    @Req() req: Request,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Query("before") before: string | undefined,
    @Query("limit", new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ) {
    return this.chat.listMessages(req.user!.userId, id, before, limit);
  }

  @Post("threads/:id/messages")
  @ApiBody({ type: SendMessageDto })
  @ApiOkResponse({ schema: MessageSchema })
  async sendMessage(
    @Req() req: Request,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: SendMessageDto,
  ) {
    return this.chat.sendMessage(req.user!.userId, req.user!.role, id, body);
  }

  @Patch("threads/:id/read")
  @HttpCode(200)
  @ApiOkResponse({ schema: { type: "object", properties: { ok: { type: "boolean" } } } })
  async markRead(@Req() req: Request, @Param("id", new ParseUUIDPipe()) id: string) {
    await this.chat.markRead(req.user!.userId, id, req.user!.role);
    return { ok: true };
  }
}
