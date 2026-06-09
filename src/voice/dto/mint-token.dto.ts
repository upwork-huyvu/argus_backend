/**
 * Response shape for `POST /voice/elevenlabs-token`.
 *
 * The mobile client uses these short-lived single-use tokens to connect to
 * ElevenLabs DIRECTLY over WebSocket (STT = Scribe v2 realtime, TTS =
 * multi-stream-input). The master `ELEVENLABS_API_KEY` is NEVER returned.
 * camelCase on the wire (project convention for new endpoints).
 */
export type MintTokenResponse = {
  /** Single-use token scoped to Scribe realtime STT (`realtime_scribe`). */
  sttToken: string;
  /** Single-use token scoped to the TTS WebSocket (`tts_websocket`). */
  ttsToken: string;
  /** Advisory expiry (ISO 8601) — client cache hint, not the EL token's own TTL. */
  expiresAt: string;
  /** Default voice (English / British) the client should synthesize with. */
  voiceId: string;
  /** Scribe model id, e.g. `scribe_v2_realtime`. */
  sttModel: string;
  /** TTS model id, e.g. `eleven_flash_v2_5`. */
  ttsModel: string;
  /** TTS output format, e.g. `pcm_24000` (client wraps PCM → WAV). */
  outputFormat: string;
  /** Default spoken language, e.g. `en`. */
  language: string;
};
