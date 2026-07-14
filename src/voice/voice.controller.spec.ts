import { HttpException, HttpStatus } from "@nestjs/common";
import type { Request } from "express";
import { VoiceController } from "./voice.controller";
import type { VoiceService } from "./voice.service";
import type { MintTokenResponse } from "./dto/mint-token.dto";

const SAMPLE: MintTokenResponse = {
  sttToken: "stt-token",
  ttsToken: "tts-token",
  expiresAt: "2026-06-09T12:00:00.000Z",
  voiceId: "voice-george",
  sttModel: "scribe_v2_realtime",
  ttsModel: "eleven_flash_v2_5",
  outputFormat: "pcm_24000",
  language: "en",
};

function reqWith(userId: string): Request & { user?: { userId: string; accessToken: string } } {
  return { user: { userId, accessToken: "jwt" } } as Request & {
    user?: { userId: string; accessToken: string };
  };
}

describe("VoiceController", () => {
  it("returns the dual-token payload for an authenticated user", async () => {
    const service = {
      assertWithinRate: jest.fn(),
      mintTokens: jest.fn().mockResolvedValue(SAMPLE),
    } as unknown as VoiceService;

    const controller = new VoiceController(service);
    const res = await controller.mintToken(reqWith("user-1"));

    expect(res).toEqual(SAMPLE);
    expect(service.assertWithinRate).toHaveBeenCalledWith("user-1");
    expect(service.mintTokens).toHaveBeenCalledTimes(1);
  });

  it("propagates the rate-guard 429 and does not mint", async () => {
    const service = {
      assertWithinRate: jest.fn(() => {
        throw new HttpException("slow down", HttpStatus.TOO_MANY_REQUESTS);
      }),
      mintTokens: jest.fn(),
    } as unknown as VoiceService;

    const controller = new VoiceController(service);
    const err = await controller.mintToken(reqWith("user-1")).catch((e) => e);

    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect(service.mintTokens).not.toHaveBeenCalled();
  });
});
