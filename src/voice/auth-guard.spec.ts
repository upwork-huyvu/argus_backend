import "reflect-metadata";
import { JwtAuthGuard } from "../common/auth/jwt-auth.guard";
import { VoiceController } from "./voice.controller";
import { AiController } from "../ai/ai.controller";

/**
 * Security contract: both ElevenLabs/voice endpoints and the streaming chat
 * endpoint MUST be behind `JwtAuthGuard` (FR-13 / AC-4). NestJS records
 * `@UseGuards(JwtAuthGuard)` under the `__guards__` metadata key on the route
 * handler; assert it is present so an accidental removal fails CI rather than
 * shipping an unauthenticated endpoint. (A real over-HTTP 401 is covered by the
 * manual/e2e pass that needs a live Supabase env.)
 */
function guardsOf(handler: unknown): unknown[] {
  return (Reflect.getMetadata("__guards__", handler as object) as unknown[]) ?? [];
}

describe("voice/stream endpoints are JWT-protected", () => {
  it("POST /voice/elevenlabs-token uses JwtAuthGuard", () => {
    expect(guardsOf(VoiceController.prototype.mintToken)).toContain(JwtAuthGuard);
  });

  it("POST /ai/chat/stream uses JwtAuthGuard", () => {
    expect(guardsOf(AiController.prototype.chatStream)).toContain(JwtAuthGuard);
  });

  it("legacy POST /ai/chat is still JwtAuthGuard-protected (unchanged)", () => {
    expect(guardsOf(AiController.prototype.chat)).toContain(JwtAuthGuard);
  });
});
