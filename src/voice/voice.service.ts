import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ElevenLabsClient, ElevenLabsError } from "@elevenlabs/elevenlabs-js";
import type { MintTokenResponse } from "./dto/mint-token.dto";

/** Friendly message surfaced to the app when ElevenLabs is rate-limited / out of quota. */
const ELEVENLABS_QUOTA_MESSAGE =
  "Voice service is temporarily rate-limited or out of quota. It will work again once capacity is available.";

/** Friendly message when the per-user mint rate-guard trips. */
const RATE_GUARD_MESSAGE =
  "Too many voice sessions started in a short time. Please wait a moment and try again.";

/** ElevenLabs single-use token scopes (one per service). */
type TokenScope = "realtime_scribe" | "tts_websocket";

@Injectable()
export class VoiceService {
  private readonly logger = new Logger(VoiceService.name);

  /**
   * Best-effort in-memory per-user sliding-window rate guard (D11).
   * NOTE: on a serverless/multi-instance deploy (Vercel) this is per-instance
   * and therefore advisory only — it stops accidental client loops, not a
   * determined attacker. Upgrade to a Redis-backed guard if a hard limit is
   * ever required.
   */
  private readonly mintHits = new Map<string, number[]>();

  /** Lazily-built ElevenLabs SDK client (cached for the process lifetime). */
  private client: ElevenLabsClient | null = null;

  constructor(private readonly config: ConfigService) {}

  private getClient(apiKey: string): ElevenLabsClient {
    if (!this.client) {
      this.client = new ElevenLabsClient({ apiKey });
    }
    return this.client;
  }

  /**
   * Throws HTTP 429 when `userId` has exceeded `VOICE_MINT_RATE_PER_MINUTE`
   * mints in the last 60s. Call before {@link mintTokens}.
   */
  assertWithinRate(userId: string): void {
    const perMinute = Number(this.config.get<string>("VOICE_MINT_RATE_PER_MINUTE") ?? "20") || 20;
    const now = Date.now();
    const windowStart = now - 60_000;
    const recent = (this.mintHits.get(userId) ?? []).filter((t) => t > windowStart);
    if (recent.length >= perMinute) {
      throw new HttpException(RATE_GUARD_MESSAGE, HttpStatus.TOO_MANY_REQUESTS);
    }
    recent.push(now);
    this.mintHits.set(userId, recent);
    // Opportunistic cleanup so the map doesn't grow unbounded across users.
    if (this.mintHits.size > 5_000) {
      for (const [key, hits] of this.mintHits) {
        const live = hits.filter((t) => t > windowStart);
        if (live.length === 0) this.mintHits.delete(key);
        else this.mintHits.set(key, live);
      }
    }
  }

  /**
   * Mints the two single-use ElevenLabs tokens the client needs (Scribe STT +
   * TTS WebSocket) and returns them alongside the non-secret model/voice config
   * so the client never hardcodes ids. The master key stays server-side.
   */
  async mintTokens(): Promise<MintTokenResponse> {
    const apiKey = this.config.get<string>("ELEVENLABS_API_KEY")?.trim();
    if (!apiKey) {
      this.logger.error("ELEVENLABS_API_KEY is not configured");
      throw new ServiceUnavailableException("Voice service is not configured.");
    }

    const [sttToken, ttsToken] = await Promise.all([
      this.mintOne("realtime_scribe", apiKey),
      this.mintOne("tts_websocket", apiKey),
    ]);

    const ttlSeconds = Number(this.config.get<string>("ELEVENLABS_TOKEN_TTL_SECONDS") ?? "60") || 60;

    return {
      sttToken,
      ttsToken,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      voiceId: this.config.get<string>("ELEVENLABS_VOICE_ID")?.trim() || "",
      sttModel: this.config.get<string>("ELEVENLABS_STT_MODEL")?.trim() || "scribe_v2_realtime",
      ttsModel: this.config.get<string>("ELEVENLABS_TTS_MODEL")?.trim() || "eleven_flash_v2_5",
      outputFormat: this.config.get<string>("ELEVENLABS_OUTPUT_FORMAT")?.trim() || "pcm_24000",
      language: this.config.get<string>("ELEVENLABS_DEFAULT_LANGUAGE")?.trim() || "en",
    };
  }

  /**
   * Mints one single-use token via the official ElevenLabs SDK
   * (`tokens.singleUse.create(scope)` → `/v1/single-use-token/{scope}`). Maps a
   * 429 to a friendly HTTP 429; any other failure (bad/missing key, network,
   * 5xx) → HTTP 503 — and never echoes the master key or full error body.
   */
  private async mintOne(scope: TokenScope, apiKey: string): Promise<string> {
    try {
      const res = await this.getClient(apiKey).tokens.singleUse.create(scope);
      const token = res?.token?.trim();
      if (!token) {
        this.logger.warn(`ElevenLabs token mint returned no token (${scope})`);
        throw new ServiceUnavailableException("Voice service returned an invalid token.");
      }
      return token;
    } catch (error) {
      if (error instanceof HttpException) throw error; // our own 503 above
      if (error instanceof ElevenLabsError && error.statusCode === 429) {
        this.logger.warn(`ElevenLabs token mint 429 (${scope})`);
        throw new HttpException(ELEVENLABS_QUOTA_MESSAGE, HttpStatus.TOO_MANY_REQUESTS);
      }
      const status = error instanceof ElevenLabsError ? error.statusCode : undefined;
      this.logger.warn(
        `ElevenLabs token mint failed (${scope})${status != null ? ` HTTP ${status}` : ""}: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
      throw new ServiceUnavailableException("Voice service rejected the request.");
    }
  }
}
