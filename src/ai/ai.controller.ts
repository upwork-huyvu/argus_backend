import { Body, Controller, Logger, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../common/auth/jwt-auth.guard";
import { AiService } from "./ai.service";
import { AiChatRequestDto } from "./dto/ai-chat-request.dto";
import { AiChatStreamRequestDto } from "./dto/ai-chat-stream-request.dto";

type AuthedRequest = Request & { user?: { userId: string; accessToken: string } };

/** Express response that may expose a `flush()` (e.g. behind compression). */
type FlushableResponse = Response & { flush?: () => void };

@Controller("ai")
@ApiTags("ai")
@ApiBearerAuth("bearerAuth")
export class AiController {
  private readonly logger = new Logger(AiController.name);

  constructor(private readonly ai: AiService) {}

  @UseGuards(JwtAuthGuard)
  @ApiBody({
    type: AiChatRequestDto,
    examples: {
      missionPlan: {
        summary: "Mission planning request",
        value: {
          user_message: "Run perimeter first then thermal scan",
          deployment_id: "construction",
          drone_id: "ark-01",
        },
      },
    },
  })
  @ApiOkResponse({
    schema: {
      type: "object",
      properties: {
        type: {
          type: 'string',
          enum: [
            'text',
            'info',
            'status',
            'mission_plan',
            'command',
            'command_sequence',
            'navigation',
          ],
        },
        message: { type: 'string' },
        action: {
          nullable: true,
          type: 'object',
          description:
            'Populated when the response maps to a single direct drone command',
          properties: {
            name: {
              type: 'string',
              enum: [
                'TAKEOFF',
                'LAND',
                'EMERGENCY_LAND',
                'RETURN_HOME',
                'HOVER',
                'FOLLOW_ME',
                'GO_TO_WAYPOINT',
                'RUN_MISSION',
                'ASCEND',
                'ORBIT',
              ],
            },
            params: { type: 'object' },
          },
        },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        requires_confirmation: { type: 'boolean' },
        data: {
          type: 'object',
          description:
            'Type-specific payload: { missions } | { actions } | { route, params } | { fields } | { status }',
        },
      },
      required: ['type', 'message', 'action', 'confidence', 'data'],
    },
  })
  @Post("chat")
  async chat(@Req() req: AuthedRequest, @Body() body: AiChatRequestDto) {
    const startedAt = Date.now();
    const identity = {
      userId: req.user!.userId,
      accessToken: req.user!.accessToken,
    };
    const result = await this.ai.chat(identity, body);
    const latencyMs = Date.now() - startedAt;
    this.logger.log(
      JSON.stringify({
        event: "ai_chat_completed",
        userId: identity.userId,
        deploymentId: body.deployment_id ?? null,
        droneId: body.drone_id ?? null,
        requestedIntent: body.user_message.slice(0, 60),
        responseType: result.type,
        missionCount: result.data.missions?.length ?? 0,
        statusKeys: Object.keys(result.data.status ?? {}).length,
        latencyMs,
      }),
    );
    return result;
  }

  /**
   * Streaming sibling of {@link chat} (Tier B). Same request body as `/ai/chat`,
   * but responds with Server-Sent Events so the client can begin TTS while the
   * LLM is still generating. Event types: `token` (incremental prose deltas),
   * `meta` (structured envelope, message omitted), `done` (full reconciled
   * response), and `error`. NOTE on ordering: for a streamed text reply the
   * `token` deltas arrive DURING generation and `meta` is emitted just before
   * `done` (so the actual order is `token* → meta → done`); for a non-LLM /
   * canned reply nothing streams, so the order is `meta → token(once) → done`.
   * The client treats `done` as the authoritative structured response and
   * `meta` as optional, so the variable ordering is harmless. The legacy
   * `POST /ai/chat` is untouched.
   *
   * Uses a manual Express stream (not `@Sse`) so it can accept a POST body and
   * set the no-buffer headers Vercel/proxies need. Errors before the first
   * write surface as normal HTTP errors via the global exception filter; errors
   * mid-stream emit an `error` frame then close.
   */
  @UseGuards(JwtAuthGuard)
  @ApiBody({ type: AiChatStreamRequestDto })
  @Post("chat/stream")
  async chatStream(
    @Req() req: AuthedRequest,
    @Body() body: AiChatStreamRequestDto,
    @Res() res: FlushableResponse,
  ): Promise<void> {
    const startedAt = Date.now();
    const identity = {
      userId: req.user!.userId,
      accessToken: req.user!.accessToken,
    };

    res.set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable proxy/serverless response buffering so frames flush immediately.
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      res.flush?.();
    };

    // Heartbeat comment frame defeats proxy/serverless idle-buffering (FR-2/FR-4)
    // so the first real frames are not held back on Vercel. It is a comment
    // (`:ping`), not an `event:`/`data:` frame, so the FE SSE parser skips it.
    const heartbeat = setInterval(() => {
      res.write(":ping\n\n");
      res.flush?.();
    }, 15_000);

    // Telemetry to diagnose/prove the TTFT win (FR-5): time to first token,
    // time to the structured envelope, total time, and whether prose actually
    // streamed incrementally (≥2 token frames) vs a single canned emit.
    let firstTokenAt: number | undefined;
    let metaAt: number | undefined;
    let tokenFrames = 0;

    try {
      const result = await this.ai.chatStream(identity, body, {
        meta: (envelope) => {
          if (metaAt === undefined) metaAt = Date.now();
          send("meta", envelope);
        },
        token: (delta) => {
          if (firstTokenAt === undefined) firstTokenAt = Date.now();
          tokenFrames += 1;
          send("token", { delta });
        },
        done: (response) => send("done", response),
      });
      const totalMs = Date.now() - startedAt;
      this.logger.log(
        JSON.stringify({
          event: "ai_chat_stream_completed",
          userId: identity.userId,
          deploymentId: body.deployment_id ?? null,
          droneId: body.drone_id ?? null,
          requestedIntent: body.user_message.slice(0, 60),
          responseType: result.type,
          missionCount: result.data.missions?.length ?? 0,
          statusKeys: Object.keys(result.data.status ?? {}).length,
          firstTokenMs: firstTokenAt !== undefined ? firstTokenAt - startedAt : null,
          metaMs: metaAt !== undefined ? metaAt - startedAt : null,
          streamedIncrementally: tokenFrames > 1,
          totalMs,
          // Kept for backward-compatible log consumers (was the only field before).
          latencyMs: totalMs,
        }),
      );
    } catch (error) {
      this.logger.error(
        `ai_chat_stream failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      // The stream has already started (headers sent); surface a frame, not a 500.
      send("error", { message: "AI chat failed. Please try again." });
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  }
}
