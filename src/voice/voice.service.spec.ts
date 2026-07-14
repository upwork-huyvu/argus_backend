import { HttpException, ServiceUnavailableException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";

/**
 * Unit tests for the ElevenLabs dual-token mint via the official
 * `@elevenlabs/elevenlabs-js` SDK (mocked — no real network call). We assert:
 * success returns both tokens + config, a missing key fails closed (503
 * ServiceUnavailable), an ElevenLabs 429 maps to a friendly 429, an empty token
 * → 503, and the per-user rate-guard trips at 429.
 */

// Shared SDK mock. `mock`-prefixed so jest's factory hoist allows the reference.
const mockCreate = jest.fn();
jest.mock("@elevenlabs/elevenlabs-js", () => ({
  ElevenLabsClient: jest.fn().mockImplementation(() => ({
    tokens: { singleUse: { create: mockCreate } },
  })),
  ElevenLabsError: class ElevenLabsError extends Error {
    statusCode?: number;
    constructor(args?: { message?: string; statusCode?: number }) {
      super(args?.message);
      this.statusCode = args?.statusCode;
    }
  },
}));

// Imported AFTER the mock is registered.
import { ElevenLabsError } from "@elevenlabs/elevenlabs-js";
import { VoiceService } from "./voice.service";

function makeConfig(overrides: Record<string, string | undefined> = {}): ConfigService {
  const values: Record<string, string | undefined> = {
    ELEVENLABS_API_KEY: "secret-key",
    ELEVENLABS_VOICE_ID: "voice-george",
    ELEVENLABS_STT_MODEL: "scribe_v2_realtime",
    ELEVENLABS_TTS_MODEL: "eleven_flash_v2_5",
    ELEVENLABS_OUTPUT_FORMAT: "pcm_24000",
    ELEVENLABS_DEFAULT_LANGUAGE: "en",
    ELEVENLABS_TOKEN_TTL_SECONDS: "60",
    VOICE_MINT_RATE_PER_MINUTE: "3",
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

describe("VoiceService", () => {
  beforeEach(() => mockCreate.mockReset());

  it("mints both tokens (per scope) and returns the model/voice config", async () => {
    mockCreate.mockImplementation((scope: string) =>
      Promise.resolve({ token: scope === "realtime_scribe" ? "stt-token" : "tts-token" }),
    );

    const svc = new VoiceService(makeConfig());
    const res = await svc.mintTokens();

    expect(res.sttToken).toBe("stt-token");
    expect(res.ttsToken).toBe("tts-token");
    expect(res.voiceId).toBe("voice-george");
    expect(res.sttModel).toBe("scribe_v2_realtime");
    expect(res.ttsModel).toBe("eleven_flash_v2_5");
    expect(res.outputFormat).toBe("pcm_24000");
    expect(res.language).toBe("en");
    expect(typeof res.expiresAt).toBe("string");

    const scopes = mockCreate.mock.calls.map((c) => c[0]);
    expect(scopes).toEqual(expect.arrayContaining(["realtime_scribe", "tts_websocket"]));
  });

  it("fails closed (ServiceUnavailable) when the API key is missing and never calls the SDK", async () => {
    const svc = new VoiceService(makeConfig({ ELEVENLABS_API_KEY: undefined }));
    await expect(svc.mintTokens()).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("maps an ElevenLabs 429 to a friendly HTTP 429", async () => {
    mockCreate.mockRejectedValue(new ElevenLabsError({ statusCode: 429, message: "rate limited" }));
    const svc = new VoiceService(makeConfig());
    const err = await svc.mintTokens().catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
  });

  it("maps other SDK errors (e.g. bad key 401) to 503", async () => {
    mockCreate.mockRejectedValue(new ElevenLabsError({ statusCode: 401, message: "unauthorized" }));
    const svc = new VoiceService(makeConfig());
    await expect(svc.mintTokens()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("treats an empty token in the response as upstream failure (503)", async () => {
    mockCreate.mockResolvedValue({ token: "" });
    const svc = new VoiceService(makeConfig());
    await expect(svc.mintTokens()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("enforces the per-user mint rate-guard (429 after the limit)", () => {
    const svc = new VoiceService(makeConfig({ VOICE_MINT_RATE_PER_MINUTE: "2" }));
    expect(() => svc.assertWithinRate("user-1")).not.toThrow();
    expect(() => svc.assertWithinRate("user-1")).not.toThrow();
    const err = (() => {
      try {
        svc.assertWithinRate("user-1");
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect(() => svc.assertWithinRate("user-2")).not.toThrow();
  });
});
