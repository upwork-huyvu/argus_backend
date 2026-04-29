import { Body, Controller, Logger, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../common/auth/jwt-auth.guard";
import { AiService } from "./ai.service";
import { AiChatRequestDto } from "./dto/ai-chat-request.dto";

type AuthedRequest = Request & { user?: { userId: string; accessToken: string } };

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
}
