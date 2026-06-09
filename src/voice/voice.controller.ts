import { Controller, Logger, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { ApiBearerAuth, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../common/auth/jwt-auth.guard";
import { VoiceService } from "./voice.service";
import type { MintTokenResponse } from "./dto/mint-token.dto";

type AuthedRequest = Request & { user?: { userId: string; accessToken: string } };

@Controller("voice")
@ApiTags("voice")
@ApiBearerAuth("bearerAuth")
export class VoiceController {
  private readonly logger = new Logger(VoiceController.name);

  constructor(private readonly voice: VoiceService) {}

  /**
   * Mints the short-lived single-use ElevenLabs tokens the app needs to connect
   * directly to Scribe STT + the TTS WebSocket. JWT-protected; identity comes
   * from the token, so the request takes no body. The master ElevenLabs key is
   * never returned or logged.
   */
  @UseGuards(JwtAuthGuard)
  @Post("elevenlabs-token")
  @ApiOkResponse({
    schema: {
      type: "object",
      properties: {
        sttToken: { type: "string" },
        ttsToken: { type: "string" },
        expiresAt: { type: "string", format: "date-time" },
        voiceId: { type: "string" },
        sttModel: { type: "string" },
        ttsModel: { type: "string" },
        outputFormat: { type: "string" },
        language: { type: "string" },
      },
      required: [
        "sttToken",
        "ttsToken",
        "expiresAt",
        "voiceId",
        "sttModel",
        "ttsModel",
        "outputFormat",
        "language",
      ],
    },
  })
  async mintToken(@Req() req: AuthedRequest): Promise<MintTokenResponse> {
    const userId = req.user!.userId;
    const startedAt = Date.now();
    this.voice.assertWithinRate(userId);
    const tokens = await this.voice.mintTokens();
    this.logger.log(
      JSON.stringify({
        event: "voice_token_minted",
        userId,
        voiceId: tokens.voiceId,
        latencyMs: Date.now() - startedAt,
      }),
    );
    return tokens;
  }
}
