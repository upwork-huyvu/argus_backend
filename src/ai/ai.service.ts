import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { type DeploymentType, isDeploymentType } from "../common/deployment-types";
import { DeploymentsService } from "../deployments/deployments.service";
import { AiMemoryService } from "./ai-memory.service";
import type { AiSessionMemory } from "./ai-memory.service";
import { type AiChatRequestDto, type ClientContextDto } from "./dto/ai-chat-request.dto";
import {
  buildContextBlock,
  DEFAULT_NAV_CATALOG,
  NAV_ROUTE_ALLOWLIST,
  type ContextInput,
} from "./prompt-template.service";
import { PromptLoaderService } from "./prompt-loader.service";

type MissionInput = {
  id: string;
  name: string;
  description?: string;
  aliases?: string[];
};

type MissionPlanItem = {
  id: string;
  name: string;
  reason?: string;
  order: number;
};

export type StatusQuery =
  | "BATTERY_LEVEL"
  | "GPS_STATUS"
  | "ALTITUDE"
  | "SPEED"
  | "DISTANCE_HOME"
  | "CONNECTION"
  | "ALL";

// Catalog of drone commands AI can detect and return.
// Mobile app / backend reads `action.name` to trigger SDK calls.
//
// ASCEND / ORBIT (added 2026-04) cover free-form requests like
// "go up 5m" or "circle once" without needing a predefined mission.
export const DRONE_ACTIONS = [
  "TAKEOFF",
  "LAND",
  "EMERGENCY_LAND",
  "RETURN_HOME",
  "HOVER",
  "FOLLOW_ME",
  "GO_TO_WAYPOINT",
  "RUN_MISSION",
  "ASCEND",
  "ORBIT",
] as const;

export type DroneActionName = (typeof DRONE_ACTIONS)[number];

export type DroneAction = {
  name: DroneActionName;
  params: Record<string, unknown>;
};

export type AiChatResponse = {
  /**
   * - "info"             → grounded answer (time / location / drone state) sourced from client_context.
   * - "navigation"       → instruction for the FE to navigate to a route in NAVIGATION_CATALOG.
   * - "command_sequence" → ordered list of drone actions executed in one turn.
   */
  type:
    | "text"
    | "info"
    | "status"
    | "mission_plan"
    | "command"
    | "command_sequence"
    | "navigation";
  message: string;
  /** Non-null when the response maps to a single direct drone command. */
  action: DroneAction | null;
  /** 0.0–1.0 — how confident the AI is in this interpretation. */
  confidence: number;
  query?: StatusQuery;
  requires_confirmation?: boolean;
  data: {
    status?: Record<string, unknown>;
    missions?: MissionPlanItem[];
    /** type=command_sequence: ordered actions to execute. */
    actions?: DroneAction[];
    /** type=navigation: route + optional params (route MUST be allowlisted). */
    route?: string;
    params?: Record<string, unknown>;
    /** type=info: structured key/value pairs the FE may render alongside the message. */
    fields?: Record<string, string>;
  };
};

type AuthedIdentity = {
  userId: string;
  accessToken: string;
};

/** Shown when OpenAI returns 429 + insufficient_quota (billing / credit limit). */
const OPENAI_INSUFFICIENT_QUOTA_MESSAGE =
  "OpenAI API quota or billing limit was hit (insufficient_quota). Add credits or check your plan: https://platform.openai.com/account/billing — AI chat will work again once quota is available.";

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    private readonly deployments: DeploymentsService,
    private readonly config: ConfigService,
    private readonly memory: AiMemoryService,
    private readonly prompts: PromptLoaderService,
  ) {}

  /** gpt-5* / o-series: `max_completion_tokens` (not `max_tokens`) and no custom `temperature` (default 1 only). */
  private openAiReasoningStyleApi(model: string): boolean {
    const m = model.toLowerCase();
    return (
      m.startsWith("gpt-5") ||
      m.startsWith("o1") ||
      m.startsWith("o3") ||
      m.startsWith("o4")
    );
  }

  private openAiTokenLimitParams(model: string, limit: number): Record<string, number> {
    const force = this.config.get<string>("OPENAI_USE_MAX_COMPLETION_TOKENS")?.trim().toLowerCase();
    const useCompletion =
      force === "1" || force === "true" || this.openAiReasoningStyleApi(model);
    return useCompletion ? { max_completion_tokens: limit } : { max_tokens: limit };
  }

  /** Omit temperature for models that only support the API default (1). */
  private openAiTemperatureParams(model: string, value: number): Record<string, number> {
    const omit = this.config.get<string>("OPENAI_OMIT_TEMPERATURE")?.trim().toLowerCase();
    if (omit === "1" || omit === "true" || this.openAiReasoningStyleApi(model)) {
      return {};
    }
    return { temperature: value };
  }

  async chat(identity: AuthedIdentity, body: AiChatRequestDto): Promise<AiChatResponse> {
    return this.computeChat(identity, body);
  }

  /**
   * Core chat pipeline shared by the non-streaming {@link chat} and the
   * streaming {@link chatStream}. When `onToken` is supplied, the freeform LLM
   * reply is streamed delta-by-delta through it (Tier B latency overlap);
   * when it is omitted the behavior is byte-for-byte identical to the legacy
   * non-streaming `/ai/chat` path. All side effects (memory persistence,
   * structured envelope, constraint enforcement) are unchanged.
   */
  private async computeChat(
    identity: AuthedIdentity,
    body: AiChatRequestDto,
    onToken?: (delta: string) => void,
  ): Promise<AiChatResponse> {
    const availableMissions = await this.resolveAvailableMissions(identity, body);
    const userMessage = body.user_message.trim();
    const sessionKey = this.buildSessionKey(identity.userId, body.deployment_id, body.drone_id);
    const previousMemory = await this.memory.get(sessionKey);

    // Short-circuit time / location / "what deployment am I in" — these are
    // pure CONTEXT lookups. We don't need to spend a model call when the
    // client already gave us the answer in `client_context`.
    if (body.client_context && this.isInfoGroundingQuery(userMessage)) {
      const response = this.buildInfoResponse(userMessage, body.client_context);
      if (response) {
        await this.persistMemory(sessionKey, response, userMessage, previousMemory);
        return response;
      }
    }

    const intent = this.detectIntent(userMessage, previousMemory?.lastIntent);

    if (intent === "status") {
      const response = this.buildStatusResponse(userMessage);
      await this.persistMemory(sessionKey, response, userMessage, previousMemory);
      return response;
    }

    if (intent === "mission_plan") {
      if (previousMemory?.lastMissions?.length) {
        const adjusted = this.adjustPreviousMissionPlan(userMessage, previousMemory.lastMissions);
        if (adjusted) {
          const response = this.safeResponse({
            type: "mission_plan",
            message: "Mission sequence updated per your follow-up. Review before executing.",
            action: null,
            confidence: 0.9,
            data: { missions: adjusted },
          });
          await this.persistMemory(sessionKey, response, userMessage, previousMemory);
          return response;
        }
      }

      const mapped = this.mapMissions(userMessage, availableMissions);
      if (mapped.length > 0) {
        const response = this.safeResponse({
          type: "mission_plan",
          message: `${mapped.length}-step mission sequence ready. Review and execute individually or all at once.`,
          action: null,
          confidence: 0.88,
          data: { missions: mapped },
        });
        await this.persistMemory(sessionKey, response, userMessage, previousMemory);
        return response;
      }

      if (this.isFollowUpMissionRequest(userMessage) && previousMemory?.lastMissions?.length) {
        const response = this.safeResponse({
          type: "mission_plan",
          message: "Previous mission plan reloaded from session.",
          action: null,
          confidence: 0.75,
          data: { missions: previousMemory.lastMissions },
        });
        await this.persistMemory(sessionKey, response, userMessage, previousMemory);
        return response;
      }

      const relaxed = this.mapMissions(userMessage, availableMissions, {
        minScore: 0.42,
        maxCount: 5,
        reasonLabel: "Closest catalog match for your description",
      });
      if (relaxed.length > 0) {
        const response = this.safeResponse({
          type: "mission_plan",
          message: "Closest catalog matches — confirm order before running.",
          action: null,
          confidence: 0.6,
          data: { missions: relaxed },
        });
        await this.persistMemory(sessionKey, response, userMessage, previousMemory);
        return response;
      }

      if (this.wantsMissionOrOpsPlanning(userMessage)) {
        const fromCatalogOnly = this.catalogOnlyMissionPlan(userMessage, availableMissions, 10);
        if (fromCatalogOnly.length > 0) {
          const response = this.safeResponse({
            type: "mission_plan",
            message: "Showing all deployment missions ordered by relevance to your request.",
            action: null,
            confidence: 0.5,
            data: { missions: fromCatalogOnly },
          });
          await this.persistMemory(sessionKey, response, userMessage, previousMemory);
          return response;
        }
      }
    }

    const llm = await this.tryLlmStructured({
      userMessage,
      availableMissions,
      deploymentType: body.deployment_id,
      chatHistory: this.toPromptHistory(previousMemory),
      clientContext: body.client_context,
    });
    if (llm) {
      let response = this.safeResponse(
        await this.enforceConstraints(
          llm,
          availableMissions,
          userMessage,
          previousMemory,
        ),
      );
      if (response.type === "text" && !response.message.trim()) {
        const fill = await this.tryLlmFreeformChat(
          userMessage,
          this.toPromptHistory(previousMemory),
          onToken,
        );
        if (fill?.trim()) {
          response = { ...response, message: fill.trim() };
        }
      }
      await this.persistMemory(sessionKey, response, userMessage, previousMemory);
      return response;
    }

    const response = this.safeResponse(
      await this.buildSmartFallback(userMessage, availableMissions, previousMemory, onToken),
    );
    await this.persistMemory(sessionKey, response, userMessage, previousMemory);
    return response;
  }

  /** User is asking for missions / site flight ops — not general small talk. */
  private wantsMissionOrOpsPlanning(message: string): boolean {
    const lower = message.toLowerCase();
    if (
      /\b(missions?|flight plan|mission plan|sequence|patrol|perimeter|thermal|survey|waypoint|waypoints|site scan|sweep|flight ops|nhiệm vụ bay|kế hoạch bay|chạy mission|chạy nhiệm vụ)\b/.test(
        lower,
      )
    ) {
      return true;
    }
    if (/\b(run|execute|start|launch)\b/.test(lower) && /\b(mission|missions|patrol|survey|sweep|inspection)\b/.test(lower)) {
      return true;
    }
    if (
      /\b(inspect|inspection)\b/.test(lower) &&
      /\b(site|roof|fence|yard|building|area|perimeter|construction|zone)\b/.test(lower)
    ) {
      return true;
    }
    if (
      /\b(drone|uav|aircraft|quad|multicopter|ark)\b/.test(lower) &&
      /\b(plan|mission|patrol|survey|scan|route|fly|should do|need to|what to run)\b/.test(lower)
    ) {
      return true;
    }
    return false;
  }

  private detectIntent(
    message: string,
    previousIntent?: AiChatResponse["type"],
  ): "text" | "status" | "mission_plan" {
    const lower = message.toLowerCase();
    if (
      /\b(battery|telemetry|signal|gps|location|power|network|altitude|speed|distance|home)\b/.test(lower) &&
      /\b(drone|aircraft|uav|ark|remote|controller)\b/.test(lower)
    ) {
      return "status";
    }
    if (/\b(drone|aircraft|uav|ark)\b/.test(lower) && /\b(status|health)\b/.test(lower)) {
      return "status";
    }
    if (this.isMissionPlanAdjustmentRequest(lower) && previousIntent === "mission_plan") {
      return "mission_plan";
    }
    if (this.isFollowUpMissionRequest(lower) && previousIntent === "mission_plan") {
      return "mission_plan";
    }
    if (this.wantsMissionOrOpsPlanning(message)) {
      return "mission_plan";
    }
    return "text";
  }

  private buildStatusResponse(message: string): AiChatResponse {
    const query = this.detectStatusQuery(message);
    return {
      type: "status",
      message: this.buildStatusIntro(query),
      action: null,
      confidence: 1.0,
      query,
      data: {},
    };
  }

  private detectStatusQuery(message: string): StatusQuery {
    const lower = message.toLowerCase();
    if (/\bbattery|power\b/.test(lower)) return "BATTERY_LEVEL";
    if (/\bgps|satellite|location|position\b/.test(lower)) return "GPS_STATUS";
    if (/\baltitude|height\b/.test(lower)) return "ALTITUDE";
    if (/\bspeed|velocity\b/.test(lower)) return "SPEED";
    if (/\bdistance.*home|home.*distance|rth distance\b/.test(lower)) return "DISTANCE_HOME";
    if (/\bconnect|connected|connection|model|online|offline\b/.test(lower)) return "CONNECTION";
    return "ALL";
  }

  private buildStatusIntro(query: StatusQuery): string {
    switch (query) {
      case "BATTERY_LEVEL":
        return "Checking battery level.";
      case "GPS_STATUS":
        return "Checking GPS status.";
      case "ALTITUDE":
        return "Checking altitude.";
      case "SPEED":
        return "Checking speed.";
      case "DISTANCE_HOME":
        return "Checking distance to home.";
      case "CONNECTION":
        return "Checking connection state.";
      case "ALL":
      default:
        return "Checking live drone telemetry.";
    }
  }

  private scoreMissionAgainstQuery(q: string, m: MissionInput): number {
    let score = 0;
    if (q.includes(m.id.toLowerCase())) score = Math.max(score, 1);
    if (q.includes(m.name.toLowerCase())) score = Math.max(score, 0.92);
    if (m.aliases?.some((a) => q.includes(a.toLowerCase()))) score = Math.max(score, 0.78);
    const nameTerms = m.name
      .toLowerCase()
      .split(/\s+/)
      .map((x) => x.trim())
      .filter((t) => t.length > 2);
    const nameOverlap = nameTerms.filter((t) => q.includes(t)).length;
    if (nameOverlap > 0) score = Math.max(score, Math.min(0.55 + nameOverlap * 0.12, 0.86));

    const desc = (m.description ?? "").toLowerCase();
    if (desc.length > 0) {
      const descTerms = desc
        .split(/\s+/)
        .map((x) => x.replace(/[^a-z0-9]/gi, ""))
        .filter((t) => t.length > 3);
      const descHits = descTerms.filter((t) => q.includes(t)).length;
      if (descHits > 0) score = Math.max(score, Math.min(0.4 + descHits * 0.1, 0.78));
    }

    const blob = `${m.name} ${m.description ?? ""}`.toLowerCase();
    const qTokens = q.split(/[^a-z0-9]+/).filter((t) => t.length > 3);
    let tokenHits = 0;
    for (const t of qTokens) {
      if (blob.includes(t)) tokenHits++;
    }
    if (tokenHits > 0) score = Math.max(score, Math.min(0.32 + tokenHits * 0.08, 0.72));

    return score;
  }

  private mapMissions(
    message: string,
    missions: MissionInput[],
    opts?: { minScore?: number; maxCount?: number; reasonLabel?: string },
  ): MissionPlanItem[] {
    const minScore = opts?.minScore ?? 0.72;
    const maxCount = opts?.maxCount ?? 5;
    const reasonLabel = opts?.reasonLabel ?? "Matched from your request";
    const q = message.toLowerCase();
    const scored = missions.map((m) => ({ mission: m, score: this.scoreMissionAgainstQuery(q, m) }));

    return scored
      .filter((x) => x.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxCount)
      .map((x, index) => ({
        id: x.mission.id,
        name: x.mission.name,                                                                 
        order: index + 1,
        reason: reasonLabel,
      }));
  }

  /** Always subsets of `missions`; ranked by score vs message, then name. Never invents missions. */
  private catalogOnlyMissionPlan(
    message: string,
    missions: MissionInput[],
    maxCount: number,
  ): MissionPlanItem[] {
    if (!missions.length || maxCount < 1) return [];
    const q = message.toLowerCase();
    const ranked = missions
      .map((m) => ({ m, score: this.scoreMissionAgainstQuery(q, m) }))
      .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.m.name.localeCompare(b.m.name)));
    return ranked.slice(0, maxCount).map((x, i) => ({
      id: x.m.id,
      name: x.m.name,
      order: i + 1,
      reason: x.score > 0 ? "Catalog — ranked by match to your message" : "Catalog mission",
    }));
  }

  private async buildSmartFallback(
    userMessage: string,
    availableMissions: MissionInput[],
    previousMemory?: AiSessionMemory | null,
    onToken?: (delta: string) => void,
  ): Promise<AiChatResponse> {
    const guidance = this.heuristicOperationalGuidance(userMessage);
    if (guidance) {
      return { type: "text", message: guidance, action: null, confidence: 0.75, data: {} };
    }

    if (this.wantsMissionOrOpsPlanning(userMessage)) {
      const loose = this.mapMissions(userMessage, availableMissions, {
        minScore: 0.35,
        maxCount: 6,
        reasonLabel: "Heuristic match from your wording and mission text",
      });
      if (loose.length > 0) {
        return {
          type: "mission_plan",
          message: "Closest catalog matches — confirm order before flying.",
          action: null,
          confidence: 0.5,
          data: { missions: loose },
        };
      }

      if (availableMissions.length > 0) {
        const catalog = this.catalogOnlyMissionPlan(userMessage, availableMissions, 10);
        return {
          type: "mission_plan",
          message: "All deployment missions ordered by relevance.",
          action: null,
          confidence: 0.4,
          data: { missions: catalog },
        };
      }

      return {
        type: "text",
        message: "No mission catalog loaded. Pass deployment_id or available_missions.",
        action: null,
        confidence: 1.0,
        data: {},
      };
    }

    const freeform = await this.tryLlmFreeformChat(
      userMessage,
      this.toPromptHistory(previousMemory),
      onToken,
    );
    if (freeform !== null) {
      return { type: "text", message: freeform, action: null, confidence: 0.7, data: {} };
    }

    return { type: "text", message: "", action: null, confidence: 0, data: {} };
  }

  /**
   * Plain chat completion—no JSON envelope. Used when structured chat fails or
   * is skipped. When `onToken` is supplied, the reply is streamed token-by-token
   * (the streaming OpenAI API) and each delta is forwarded; the full assembled
   * text is still returned. Without `onToken` it behaves exactly as before.
   */
  private async tryLlmFreeformChat(
    userMessage: string,
    chatHistory: Array<{ role: "user" | "assistant"; content: string; responseType?: string; at: string }>,
    onToken?: (delta: string) => void,
  ): Promise<string | null> {
    const apiKey = this.config.get<string>("OPENAI_API_KEY")?.trim();
    if (!apiKey) return null;

    const model = this.config.get<string>("OPENAI_MODEL")?.trim() || "gpt-4.1-mini";
    const historyMsgs = chatHistory.map((t) => ({
      role: t.role as "user" | "assistant",
      content: t.content,
    }));
    const messages = [
      {
        role: "system",
        content:
          "You are ARGUS, a drone operations assistant. Reply in plain text only — no JSON. 1-2 sentences unless asked for more. Be direct and operational.",
      },
      ...historyMsgs,
      { role: "user", content: userMessage },
    ];

    if (onToken) {
      return this.streamOpenAiFreeform(apiKey, model, messages, onToken);
    }

    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          ...this.openAiTemperatureParams(model, 0.75),
          ...this.openAiTokenLimitParams(model, 1024),
          messages,
        }),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        if (this.isOpenAiInsufficientQuota(response.status, errText)) {
          this.logger.warn("OpenAI insufficient_quota (freeform chat)");
          return OPENAI_INSUFFICIENT_QUOTA_MESSAGE;
        }
        this.logger.warn(
          `OpenAI freeform HTTP ${response.status}: ${errText.slice(0, 400)}`,
        );
        return null;
      }
      const raw = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = raw.choices?.[0]?.message?.content?.trim();
      return text && text.length > 0 ? text : null;
    } catch (error) {
      this.logger.warn(
        `LLM freeform chat failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      return null;
    }
  }

  /**
   * Streaming counterpart of {@link tryLlmFreeformChat}: calls OpenAI with
   * `stream:true`, parses the SSE `data:` frames, forwards each content delta to
   * `onToken`, and returns the fully assembled text (or null on failure). Used
   * only by {@link chatStream} (Tier B) so TTS can begin while the LLM is still
   * generating. The legacy non-streaming helper is untouched.
   */
  private async streamOpenAiFreeform(
    apiKey: string,
    model: string,
    messages: Array<{ role: string; content: string }>,
    onToken: (delta: string) => void,
  ): Promise<string | null> {
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          ...this.openAiTemperatureParams(model, 0.75),
          ...this.openAiTokenLimitParams(model, 1024),
          messages,
          stream: true,
        }),
      });

      if (!response.ok || !response.body) {
        const errText = await response.text().catch(() => "");
        if (this.isOpenAiInsufficientQuota(response.status, errText)) {
          this.logger.warn("OpenAI insufficient_quota (freeform stream)");
          onToken(OPENAI_INSUFFICIENT_QUOTA_MESSAGE);
          return OPENAI_INSUFFICIENT_QUOTA_MESSAGE;
        }
        this.logger.warn(
          `OpenAI freeform stream HTTP ${response.status}: ${errText.slice(0, 400)}`,
        );
        return null;
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let assembled = "";

      const handleLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) return;
        const payload = trimmed.slice("data:".length).trim();
        if (!payload || payload === "[DONE]") return;
        try {
          const json = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) {
            assembled += delta;
            onToken(delta);
          }
        } catch {
          // Ignore keep-alive / non-JSON lines.
        }
      };

      // Node's `fetch` returns a web ReadableStream that is async-iterable.
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let nlIndex: number;
        while ((nlIndex = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nlIndex);
          buffer = buffer.slice(nlIndex + 1);
          handleLine(line);
        }
      }
      if (buffer.trim()) handleLine(buffer);

      const text = assembled.trim();
      return text.length > 0 ? text : null;
    } catch (error) {
      this.logger.warn(
        `LLM freeform stream failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      return null;
    }
  }

  /**
   * Streaming entry point for `POST /ai/chat/stream` (Tier B). Runs the exact
   * same pipeline as {@link chat} (intent detection, structured envelope,
   * constraint enforcement, memory persistence) but streams the freeform LLM
   * prose through `emit.token` as it is generated. Emits the structured
   * envelope via `emit.meta` (message omitted) and the fully reconciled
   * response via `emit.done`. For non-LLM / canned / structured replies (no
   * prose stream) the single `message` is emitted once as a `token` so the
   * client can still speak it. Returns the final response for logging.
   */
  async chatStream(
    identity: AuthedIdentity,
    body: AiChatRequestDto,
    emit: {
      meta: (envelope: Omit<AiChatResponse, "message">) => void;
      token: (delta: string) => void;
      done: (response: AiChatResponse) => void;
    },
  ): Promise<AiChatResponse> {
    let streamedAny = false;
    const onToken = (delta: string) => {
      if (!delta) return;
      streamedAny = true;
      emit.token(delta);
    };

    const response = await this.computeChat(identity, body, onToken);

    // Structured envelope without the prose (the prose arrived as token deltas).
    const envelope = { ...response } as Partial<AiChatResponse>;
    delete envelope.message;
    emit.meta(envelope as Omit<AiChatResponse, "message">);
    if (!streamedAny && response.message) {
      emit.token(response.message);
    }
    emit.done(response);
    return response;
  }

  private heuristicOperationalGuidance(
    message: string,
  ): string | null {
    const lower = message.toLowerCase();

    if (
      /\b(connect|connection|pair|pairing|bind|binding|link|linked|offline|not connected|won't connect|wont connect|can't connect|cant connect|no link|mất kết nối|kết nối)\b/.test(
        lower,
      )
    ) {
      return "Check RC/drone power cycle, verify bind state, and retry connection. Ask for status to read live DJI SDK fields.";
    }

    if (/\b(battery|charge|charging|low power|power low|dead battery|pin yếu|sạc)\b/.test(lower)) {
      return "Ask for battery status and the app will pull live telemetry directly from DJI SDK.";
    }

    if (/\b(gps|gnss|satellite|weak signal|lost signal|no gps|mất gps)\b/.test(lower)) {
      return "For GPS/GNSS: move to open sky and ask for GPS status to inspect live satellite and fix quality.";
    }

    return null;
  }

  private async resolveAvailableMissions(
    identity: AuthedIdentity,
    body: AiChatRequestDto,
  ): Promise<MissionInput[]> {
    if (body.available_missions?.length) {
      return body.available_missions.map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        aliases: m.aliases ?? [],
      }));
    }

    try {
      const promptDeploymentId: DeploymentType =
        body.deployment_id && isDeploymentType(body.deployment_id) ? body.deployment_id : "construction";
      const deployment = await this.deployments.getDeploymentById(
        identity.userId,
        promptDeploymentId,
        identity.accessToken,
      );
      return deployment.missions.map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        aliases: [],
      }));
    } catch (error) {
      this.logger.warn(
        `Failed loading missions for deployment from Supabase: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
      return [];
    }
  }

  private isOpenAiInsufficientQuota(httpStatus: number, errBody: string): boolean {
    if (httpStatus !== 429) return false;
    return errBody.includes("insufficient_quota");
  }

  private stripJsonMarkdownFence(content: string): string {
    let s = content.trim();
    if (s.startsWith("```")) {
      s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/m, "").trim();
    }
    return s;
  }

  private pickAssistantMessageFromObject(o: Record<string, unknown>): string {
    for (const k of ["message", "reply", "answer", "content", "text", "body"]) {
      const v = o[k];
      if (typeof v === "string" && v.trim().length > 0) return v.trim();
    }
    const data = o.data;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const d = data as Record<string, unknown>;
      for (const k of ["message", "reply", "answer"]) {
        const v = d[k];
        if (typeof v === "string" && v.trim().length > 0) return v.trim();
      }
    }
    return "";
  }

  /** Normalize the LLM JSON payload → typed AiChatResponse.
   *  Handles: wrong type labels, missions at top level, new action/confidence fields,
   *  plus the new types: info / navigation / command_sequence.
   */
  private normalizeStructuredLlmPayload(parsed: unknown): AiChatResponse | null {
    if (!parsed || typeof parsed !== "object") return null;
    const o = parsed as Record<string, unknown>;

    // --- type ---
    const t = o.type;
    const knownType =
      t === "text" ||
      t === "info" ||
      t === "status" ||
      t === "mission_plan" ||
      t === "command" ||
      t === "command_sequence" ||
      t === "navigation";
    const type: AiChatResponse["type"] = knownType
      ? (t as AiChatResponse["type"])
      : typeof t === "string" && /sequence/i.test(t)
        ? "command_sequence"
        : typeof t === "string" && /nav/i.test(t)
          ? "navigation"
          : typeof t === "string" && /info|context|grounded/i.test(t)
            ? "info"
            : typeof t === "string" && /command/i.test(t)
              ? "command"
              : typeof t === "string" && /mission/i.test(t)
                ? "mission_plan"
                : typeof t === "string" && /status|telemetry/i.test(t)
                  ? "status"
                  : "text";

    // --- data ---
    let dataObj: Record<string, unknown> = {};
    if (o.data && typeof o.data === "object" && !Array.isArray(o.data)) {
      dataObj = { ...(o.data as Record<string, unknown>) };
    }
    if (!Array.isArray(dataObj.missions) && Array.isArray(o.missions)) {
      dataObj.missions = o.missions;
    }
    if (!Array.isArray(dataObj.actions) && Array.isArray(o.actions)) {
      dataObj.actions = o.actions;
    }
    if (typeof dataObj.route !== "string" && typeof o.route === "string") {
      dataObj.route = o.route;
    }
    if (!dataObj.fields && o.fields && typeof o.fields === "object" && !Array.isArray(o.fields)) {
      dataObj.fields = o.fields;
    }
    if (!dataObj.status && o.status && typeof o.status === "object" && !Array.isArray(o.status)) {
      dataObj.status = o.status;
    }

    const missionsArr = dataObj.missions;
    const hasMissions = Array.isArray(missionsArr) && missionsArr.length > 0;
    const actionsArr = dataObj.actions;
    const hasActions = Array.isArray(actionsArr) && actionsArr.length > 0;
    let resolvedType: AiChatResponse["type"] = type;
    if (hasActions && type !== "command") resolvedType = "command_sequence";
    else if (
      hasMissions &&
      type !== "status" &&
      type !== "command" &&
      type !== "command_sequence" &&
      type !== "navigation"
    )
      resolvedType = "mission_plan";

    // --- action: validate name against DRONE_ACTIONS catalog ---
    const parseAction = (raw: unknown): DroneAction | null => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      const a = raw as Record<string, unknown>;
      const actionName = typeof a.name === "string" ? a.name.toUpperCase() : "";
      if (!(DRONE_ACTIONS as readonly string[]).includes(actionName)) return null;
      return {
        name: actionName as DroneActionName,
        params: (a.params && typeof a.params === "object" && !Array.isArray(a.params)
          ? a.params
          : {}) as Record<string, unknown>,
      };
    };

    const action = parseAction(o.action);

    // --- normalized actions[] (drop unknown action names) ---
    const sequencedActions: DroneAction[] = Array.isArray(actionsArr)
      ? actionsArr
          .map((a) => parseAction(a))
          .filter((a): a is DroneAction => a !== null)
      : [];

    // --- route (validated against allowlist later, in enforceConstraints) ---
    const route = typeof dataObj.route === "string" ? dataObj.route : undefined;
    const params =
      dataObj.params && typeof dataObj.params === "object" && !Array.isArray(dataObj.params)
        ? (dataObj.params as Record<string, unknown>)
        : undefined;

    // --- confidence: clamp to [0,1] ---
    const rawConf = o.confidence;
    const confidence =
      typeof rawConf === "number" && isFinite(rawConf) ? Math.min(1, Math.max(0, rawConf)) : 0.8;

    const message = this.pickAssistantMessageFromObject(o);
    const rawQuery = typeof o.query === "string" ? o.query.toUpperCase() : "";
    const query: StatusQuery | undefined =
      rawQuery === "BATTERY_LEVEL" ||
      rawQuery === "GPS_STATUS" ||
      rawQuery === "ALTITUDE" ||
      rawQuery === "SPEED" ||
      rawQuery === "DISTANCE_HOME" ||
      rawQuery === "CONNECTION" ||
      rawQuery === "ALL"
        ? (rawQuery as StatusQuery)
        : undefined;
    const requiresConfirmation =
      typeof o.requires_confirmation === "boolean" ? o.requires_confirmation : undefined;
    return {
      type: resolvedType,
      message,
      action,
      confidence,
      query,
      requires_confirmation: requiresConfirmation,
      data: {
        status: dataObj.status as Record<string, unknown> | undefined,
        missions: dataObj.missions as MissionPlanItem[] | undefined,
        actions: sequencedActions.length > 0 ? sequencedActions : undefined,
        route,
        params,
        fields: dataObj.fields as Record<string, string> | undefined,
      },
    };
  }

  /**
   * Builds the OpenAI messages array. Layered system context so the model
   * always sees:
   *
   *   [system: runtime instructions / response schema]   ← prompts/ai-chat.runtime.prompt.txt
   *   [system: app knowledge — screens / nav / flows]    ← prompts/argus.detail.prompt.txt
   *   [system: drone feature catalog / parameter shapes] ← prompts/drone.features.prompt.txt
   *   [system: dynamic CONTEXT block built per request]
   *   [...recent chat history...]
   *   [user: current message]
   *
   * The first three are static across requests (cached on first read by
   * PromptLoaderService); the fourth is rebuilt every turn from
   * `client_context` so NOW / PHONE_LOCATION / DRONE_STATE are fresh.
   *
   * Token budget note: ~6–7k tokens of system context per call. Acceptable
   * for gpt-4.1-mini's 128k window; revisit if we need to cut cost.
   */
  private buildMessagesArray(input: {
    userMessage: string;
    availableMissions: MissionInput[];
    deploymentType?: string;
    chatHistory: Array<{ role: "user" | "assistant"; content: string }>;
    clientContext?: ClientContextDto;
  }): Array<{ role: string; content: string }> {
    // Required — throws InternalServerErrorException if the file is missing.
    const runtime = this.prompts.getRuntimePrompt();
    const appDetail = this.prompts.getAppDetailPrompt();
    const droneFeatures = this.prompts.getDroneFeaturesPrompt();

    const contextInput: ContextInput = {
      availableMissions: input.availableMissions,
      deploymentType: input.deploymentType,
      navCatalog: DEFAULT_NAV_CATALOG,
      nowIso: input.clientContext?.now_iso,
      timezone: input.clientContext?.timezone,
      locale: input.clientContext?.locale,
      currentRoute: input.clientContext?.current_route,
      phoneLocation: input.clientContext?.phone_location
        ? {
            latitude: input.clientContext.phone_location.latitude,
            longitude: input.clientContext.phone_location.longitude,
            accuracyM: input.clientContext.phone_location.accuracy_m,
            label: input.clientContext.phone_location_label,
          }
        : undefined,
      droneState: input.clientContext?.drone_state
        ? {
            connected: !!input.clientContext.drone_state.connected,
            batteryPct: input.clientContext.drone_state.battery_pct,
            altitudeM: input.clientContext.drone_state.altitude_m,
            satelliteCount: input.clientContext.drone_state.satellite_count,
            droneLatitude: input.clientContext.drone_state.drone_latitude,
            droneLongitude: input.clientContext.drone_state.drone_longitude,
            model: input.clientContext.drone_state.model,
          }
        : undefined,
    };
    const contextBlock = buildContextBlock(contextInput);

    // Keep last 6 turns (3 exchanges) to cap history tokens
    const recentHistory = input.chatHistory.slice(-6);

    const messages: Array<{ role: string; content: string }> = [
      { role: "system", content: runtime },
    ];
    if (appDetail.trim().length > 0) {
      messages.push({
        role: "system",
        content: `== APP KNOWLEDGE ==\n${appDetail}`,
      });
    }
    if (droneFeatures.trim().length > 0) {
      messages.push({
        role: "system",
        content: `== DRONE FEATURE CATALOG ==\n${droneFeatures}`,
      });
    }
    messages.push({ role: "system", content: contextBlock });
    for (const t of recentHistory) {
      messages.push({ role: t.role, content: t.content });
    }
    messages.push({ role: "user", content: input.userMessage });
    return messages;
  }

  private async tryLlmStructured(input: {
    userMessage: string;
    availableMissions: MissionInput[];
    deploymentType?: string;
    chatHistory: Array<{ role: "user" | "assistant"; content: string; responseType?: string; at: string }>;
    clientContext?: ClientContextDto;
  }): Promise<AiChatResponse | null> {
    const apiKey = this.config.get<string>("OPENAI_API_KEY")?.trim();
    if (!apiKey) return null;

    const model = this.config.get<string>("OPENAI_MODEL")?.trim() || "gpt-4.1-mini";
    const messages = this.buildMessagesArray({
      userMessage: input.userMessage,
      availableMissions: input.availableMissions,
      deploymentType: input.deploymentType,
      chatHistory: input.chatHistory,
      clientContext: input.clientContext,
    });

    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          // Low temperature for deterministic JSON output (was 0.45)
          ...this.openAiTemperatureParams(model, 0.15),
          // Our schema is small — 600 tokens is more than enough (was 2048)
          ...this.openAiTokenLimitParams(model, 600),
          response_format: { type: "json_object" },
          messages,
        }),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        if (this.isOpenAiInsufficientQuota(response.status, errText)) {
          this.logger.warn("OpenAI insufficient_quota (structured chat)");
          return {
            type: "text",
            message: OPENAI_INSUFFICIENT_QUOTA_MESSAGE,
            action: null,
            confidence: 1.0,
            data: {},
          };
        }
        this.logger.warn(`OpenAI chat/completions HTTP ${response.status}: ${errText.slice(0, 400)}`);
        return null;
      }
      const raw = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = raw.choices?.[0]?.message?.content;
      if (!content) return null;
      const stripped = this.stripJsonMarkdownFence(content);
      let parsed: unknown;
      try {
        parsed = JSON.parse(stripped);
      } catch {
        this.logger.warn("LLM returned non-JSON content after fence strip");
        return null;
      }
      return this.normalizeStructuredLlmPayload(parsed);
    } catch (error) {
      this.logger.warn(
        `LLM fallback failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      return null;
    }
  }

  /**
   * Validate an action's params against the catalog ranges declared in
   * `prompts/ai-chat.runtime.prompt.txt`. Returns either a normalized
   * DroneAction (numeric coercion + defaults applied) or a string reason
   * the action was rejected. The caller decides how to surface the reason
   * (drop it from the sequence, downgrade to text, etc).
   */
  private validateActionParams(action: DroneAction): DroneAction | string {
    const p: Record<string, unknown> =
      action.params && typeof action.params === "object" && !Array.isArray(action.params)
        ? { ...action.params }
        : {};

    const num = (v: unknown): number | null => {
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string" && v.trim() !== "") {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      }
      return null;
    };
    const inRange = (n: number, lo: number, hi: number) => n >= lo && n <= hi;

    switch (action.name) {
      case "TAKEOFF":
      case "LAND":
      case "EMERGENCY_LAND":
      case "RETURN_HOME":
      case "HOVER":
      case "FOLLOW_ME":
        return { name: action.name, params: {} };

      case "GO_TO_WAYPOINT": {
        const lat = num(p.latitude);
        const lon = num(p.longitude);
        if (lat == null || !inRange(lat, -90, 90)) {
          return `GO_TO_WAYPOINT requires a numeric "latitude" in [-90, 90].`;
        }
        if (lon == null || !inRange(lon, -180, 180)) {
          return `GO_TO_WAYPOINT requires a numeric "longitude" in [-180, 180].`;
        }
        const out: Record<string, unknown> = { latitude: lat, longitude: lon };
        const alt = num(p.altitude_m);
        if (alt != null) {
          if (!inRange(alt, 0, 500)) {
            return `GO_TO_WAYPOINT "altitude_m" must be in [0, 500].`;
          }
          out.altitude_m = alt;
        }
        return { name: "GO_TO_WAYPOINT", params: out };
      }

      case "ASCEND": {
        const delta = num(p.delta_m);
        if (delta == null || delta === 0) {
          return `ASCEND requires non-zero numeric "delta_m" in [-50, 50].`;
        }
        if (!inRange(delta, -50, 50)) {
          return `ASCEND "delta_m" out of range [-50, 50] (got ${delta}).`;
        }
        const out: Record<string, unknown> = { delta_m: delta };
        const speed = num(p.max_speed_ms);
        if (speed != null) {
          if (!inRange(speed, 0.2, 4)) {
            return `ASCEND "max_speed_ms" must be in [0.2, 4].`;
          }
          out.max_speed_ms = speed;
        }
        return { name: "ASCEND", params: out };
      }

      case "ORBIT": {
        const out: Record<string, unknown> = {};
        const rev = num(p.revolutions);
        if (rev != null) {
          if (!inRange(rev, 0.25, 10)) {
            return `ORBIT "revolutions" must be in [0.25, 10].`;
          }
          out.revolutions = rev;
        }
        const radius = num(p.radius_m);
        if (radius != null) {
          if (!inRange(radius, 3, 200)) {
            return `ORBIT "radius_m" must be in [3, 200].`;
          }
          out.radius_m = radius;
        }
        const angVel = num(p.angular_velocity_deg_s);
        if (angVel != null) {
          if (!inRange(angVel, 3, 60)) {
            return `ORBIT "angular_velocity_deg_s" must be in [3, 60].`;
          }
          out.angular_velocity_deg_s = angVel;
        }
        if (typeof p.clockwise === "boolean") out.clockwise = p.clockwise;
        const altitude = num(p.altitude_m);
        if (altitude != null) {
          if (!inRange(altitude, 0, 500)) {
            return `ORBIT "altitude_m" must be in [0, 500].`;
          }
          out.altitude_m = altitude;
        }
        const lat = num(p.latitude);
        const lon = num(p.longitude);
        if ((lat != null) !== (lon != null)) {
          return `ORBIT requires either both "latitude" and "longitude" or neither.`;
        }
        if (lat != null && lon != null) {
          if (!inRange(lat, -90, 90)) return `ORBIT "latitude" out of range.`;
          if (!inRange(lon, -180, 180)) return `ORBIT "longitude" out of range.`;
          out.latitude = lat;
          out.longitude = lon;
        }
        return { name: "ORBIT", params: out };
      }

      case "RUN_MISSION": {
        const mid = typeof p.mission_id === "string" ? p.mission_id.trim() : "";
        if (!mid) return `RUN_MISSION requires a non-empty string "mission_id".`;
        return { name: "RUN_MISSION", params: { mission_id: mid } };
      }

      default:
        // DRONE_ACTIONS guard already ensured `action.name` is in the catalog;
        // unknown names land here only if the catalog grew without an
        // updated validator. Fail closed.
        return `Unknown action "${action.name}" — no validator wired.`;
    }
  }

  private async enforceConstraints(
    candidate: AiChatResponse,
    availableMissions: MissionInput[],
    userMessage: string,
    previousMemory?: AiSessionMemory | null,
  ): Promise<AiChatResponse> {
    const missionIdSet = new Set(availableMissions.map((m) => m.id));
    const missionNameById = new Map(availableMissions.map((m) => [m.id, m.name]));
    const msg = (v: unknown) =>
      v != null && String(v).trim().length > 0 ? String(v).trim() : "";

    if (candidate.type === "mission_plan") {
      const missions = (candidate.data.missions ?? [])
        .filter((m) => missionIdSet.has(m.id))
        .map((m, index) => ({
          id: m.id,
          name: missionNameById.get(m.id) ?? m.name,
          order: index + 1,
          reason: m.reason,
        }));

      if (missions.length === 0) {
        return this.buildSmartFallback(userMessage, availableMissions, previousMemory);
      }

      return {
        type: "mission_plan",
        message: msg(candidate.message),
        action: null,
        confidence: candidate.confidence,
        data: { missions },
      };
    }

    if (candidate.type === "status") {
      return {
        type: "status",
        message: msg(candidate.message),
        action: null,
        confidence: candidate.confidence,
        query: candidate.query ?? "ALL",
        data: {},
      };
    }

    if (candidate.type === "command") {
      // Reject commands whose action couldn't be validated against the catalog.
      if (!candidate.action) {
        return {
          type: "text",
          message: msg(candidate.message) || "I couldn't map that to a valid drone command.",
          action: null,
          confidence: candidate.confidence,
          data: {},
        };
      }
      const validated = this.validateActionParams(candidate.action);
      if (typeof validated === "string") {
        // Param outside the documented range (e.g. "ascend 80m" → > 50m cap)
        // → downgrade to text so the user knows why.
        return {
          type: "text",
          message: msg(candidate.message) || validated,
          action: null,
          confidence: candidate.confidence,
          data: {},
        };
      }
      return {
        type: "command",
        message: msg(candidate.message),
        action: validated,
        confidence: candidate.confidence,
        requires_confirmation: true,
        data: {},
      };
    }

    if (candidate.type === "command_sequence") {
      const raw = candidate.data.actions ?? [];
      const validated: DroneAction[] = [];
      const rejected: string[] = [];
      for (const a of raw) {
        const v = this.validateActionParams(a);
        if (typeof v === "string") rejected.push(`${a.name}: ${v}`);
        else validated.push(v);
      }
      if (validated.length === 0) {
        const detail =
          rejected.length > 0
            ? ` Rejected: ${rejected.join("; ")}`
            : "";
        return {
          type: "text",
          message:
            (msg(candidate.message) ||
              "I couldn't break that into valid drone commands. Please rephrase.") +
            detail,
          action: null,
          confidence: candidate.confidence,
          data: {},
        };
      }
      return {
        type: "command_sequence",
        message: msg(candidate.message),
        action: null,
        confidence: candidate.confidence,
        requires_confirmation: true,
        data: { actions: validated },
      };
    }

    if (candidate.type === "navigation") {
      const route = candidate.data.route;
      if (!route || !NAV_ROUTE_ALLOWLIST.has(route)) {
        return {
          type: "text",
          message:
            msg(candidate.message) ||
            `I can't open that screen — "${route ?? "unknown"}" is not a known route.`,
          action: null,
          confidence: candidate.confidence,
          data: {},
        };
      }
      return {
        type: "navigation",
        message: msg(candidate.message),
        action: null,
        confidence: candidate.confidence,
        requires_confirmation: false,
        data: {
          route,
          params: candidate.data.params,
        },
      };
    }

    if (candidate.type === "info") {
      return {
        type: "info",
        message: msg(candidate.message),
        action: null,
        confidence: candidate.confidence,
        requires_confirmation: false,
        data: { fields: candidate.data.fields },
      };
    }

    return {
      type: "text",
      message: msg(candidate.message),
      action: candidate.action,
      confidence: candidate.confidence,
      data: {},
    };
  }

  private safeResponse(candidate: AiChatResponse): AiChatResponse {
    if (!candidate || typeof candidate !== "object") {
      return { type: "text", message: "Request could not be processed.", action: null, confidence: 0, data: {} };
    }

    const allowedTypes: AiChatResponse["type"][] = [
      "text",
      "info",
      "status",
      "mission_plan",
      "command",
      "command_sequence",
      "navigation",
    ];
    if (!allowedTypes.includes(candidate.type)) {
      return { type: "text", message: "Request could not be processed.", action: null, confidence: 0, data: {} };
    }

    const msg =
      candidate.message != null && String(candidate.message).length > 0
        ? String(candidate.message)
        : "";
    const sideEffectType =
      candidate.type === "command" ||
      candidate.type === "command_sequence" ||
      candidate.type === "mission_plan";
    return {
      type: candidate.type,
      message: msg,
      action: candidate.action ?? null,
      confidence: typeof candidate.confidence === "number" ? candidate.confidence : 0.8,
      query: candidate.type === "status" ? (candidate.query ?? "ALL") : undefined,
      requires_confirmation: sideEffectType
        ? (candidate.requires_confirmation ?? true)
        : false,
      data: {
        status: undefined,
        missions: candidate.data?.missions,
        actions: candidate.data?.actions,
        route: candidate.data?.route,
        params: candidate.data?.params,
        fields: candidate.data?.fields,
      },
    };
  }

  private isFollowUpMissionRequest(message: string): boolean {
    return /\b(continue|next|same|again|reuse|tiếp|lại|như cũ)\b/i.test(message);
  }

  private isMissionPlanAdjustmentRequest(message: string): boolean {
    return /\b(remove|delete|drop|exclude|keep|only|except|bỏ|xóa|loại|chỉ|giữ)\b/i.test(message);
  }

  private adjustPreviousMissionPlan(
    message: string,
    previousMissions: Array<{ id: string; name: string; order: number }>,
  ): Array<{ id: string; name: string; order: number; reason?: string }> | null {
    if (!previousMissions.length) return null;
    const lower = message.toLowerCase();
    if (!this.isMissionPlanAdjustmentRequest(lower)) return null;

    const byOrder = previousMissions
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((m, idx) => ({ ...m, orderRef: idx + 1 }));

    const targets = new Set<string>();
    const numberMatches = lower.match(/\b\d+\b/g) ?? [];
    for (const raw of numberMatches) {
      const asNumber = Number(raw);
      const target = byOrder.find((m) => m.orderRef === asNumber);
      if (target) targets.add(target.id);
    }

    for (const m of byOrder) {
      if (lower.includes(m.id.toLowerCase()) || lower.includes(m.name.toLowerCase())) {
        targets.add(m.id);
      }
    }

    const hasOnlyIntent = /\b(only|chỉ|just|duy nhất)\b/i.test(lower);
    const hasKeepIntent = /\b(keep|giữ)\b/i.test(lower);
    const hasRemoveIntent = /\b(remove|delete|drop|exclude|bỏ|xóa|loại)\b/i.test(lower);

    let next = byOrder.slice();

    if ((hasOnlyIntent || hasKeepIntent) && targets.size > 0) {
      next = next.filter((m) => targets.has(m.id));
    } else if (hasRemoveIntent && targets.size > 0) {
      next = next.filter((m) => !targets.has(m.id));
    } else {
      return null;
    }

    if (!next.length) return null;

    return next.map((m, idx) => ({
      id: m.id,
      name: m.name,
      order: idx + 1,
      reason: "Adjusted from previous plan by follow-up request",
    }));
  }

  private buildSessionKey(userId: string, deploymentId?: string, droneId?: string): string {
    return `${userId}:${deploymentId ?? "none"}:${droneId ?? "none"}`;
  }

  private async persistMemory(
    sessionKey: string,
    response: AiChatResponse,
    userMessage: string,
    previousMemory?: AiSessionMemory | null,
  ): Promise<void> {
    // Each exchange adds user + assistant (2 items). 20 ≈ last 10 user questions.
    const maxTurns = Number(this.config.get<string>("AI_MEMORY_TURNS") ?? "20");
    const previousTurns = previousMemory?.turns ?? [];
    const nextTurns = [
      ...previousTurns,
      {
        role: "user" as const,
        content: userMessage,
        at: new Date().toISOString(),
      },
      {
        role: "assistant" as const,
        content: response.message,
        responseType: response.type,
        at: new Date().toISOString(),
      },
    ].slice(-Math.max(maxTurns, 2));

    const nextLastMissions =
      response.type === "mission_plan"
        ? (response.data.missions ?? []).map((m) => ({
            id: m.id,
            name: m.name,
            order: m.order,
          }))
        : (previousMemory?.lastMissions ?? []);

    await this.memory.set(sessionKey, {
      lastIntent: response.type,
      lastMessage: userMessage,
      lastMissions: nextLastMissions,
      turns: nextTurns,
      updatedAt: new Date().toISOString(),
    });
  }

  private toPromptHistory(previousMemory?: AiSessionMemory | null) {
    const maxTurns = Number(this.config.get<string>("AI_MEMORY_TURNS") ?? "20");
    return (previousMemory?.turns ?? []).slice(-Math.max(maxTurns, 2));
  }

  // ── Info / grounding short-circuit ──────────────────────────────────────
  // For pure-context questions (time, today, where am I, drone state) we
  // skip the LLM round-trip and answer directly from `client_context`.

  private isInfoGroundingQuery(message: string): boolean {
    const lower = message.toLowerCase();
    if (/\b(what|tell me).*\b(time|date|day)\b/.test(lower)) return true;
    if (/\b(time|date)\b.*\b(now|today|right now)\b/.test(lower)) return true;
    if (/^\s*(time|now|today|date)\s*\??\s*$/.test(lower)) return true;
    if (/\b(what is today|what day is it|what's the date)\b/.test(lower)) return true;
    if (/\b(mấy giờ|hôm nay là (ngày|thứ)|bây giờ là)\b/.test(lower)) return true;
    if (/\b(where am i|my location|where i am)\b/.test(lower)) return true;
    if (/^\s*location\b/.test(lower)) return true;
    if (/\b(tôi đang ở đâu|vị trí của tôi|ở đâu)\b/.test(lower)) return true;
    if (/\b(what deployment|which deployment|what site|what project)\b/.test(lower)) return true;
    if (/\b(what screen|what page|where am i in the app)\b/.test(lower)) return true;
    return false;
  }

  private buildInfoResponse(
    message: string,
    ctx: ClientContextDto,
  ): AiChatResponse | null {
    const lower = message.toLowerCase();
    const fields: Record<string, string> = {};

    // -- TIME / DATE --------------------------------------------------------
    if (
      /\b(time|now|date|day|today)\b/.test(lower) ||
      /\b(mấy giờ|hôm nay|bây giờ)\b/.test(lower)
    ) {
      if (!ctx.now_iso) {
        return {
          type: "info",
          message:
            "I don't have your device clock yet — please update the app or retry.",
          action: null,
          confidence: 1.0,
          requires_confirmation: false,
          data: {},
        };
      }
      const tz = ctx.timezone ?? "UTC";
      fields.now = ctx.now_iso;
      fields.tz = tz;
      const isAskingDate = /\b(today|date|day|hôm nay)\b/.test(lower);
      const isAskingTime = /\b(time|now|mấy giờ|bây giờ)\b/.test(lower);
      const date = new Date(ctx.now_iso);
      const human = (() => {
        try {
          const fmt = new Intl.DateTimeFormat(ctx.locale ?? "en-US", {
            timeZone: tz,
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          });
          return fmt.format(date);
        } catch {
          return date.toISOString();
        }
      })();
      let msg = `It is ${human}.`;
      if (isAskingDate && !isAskingTime) {
        try {
          const fmt = new Intl.DateTimeFormat(ctx.locale ?? "en-US", {
            timeZone: tz,
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
          });
          msg = `Today is ${fmt.format(date)}.`;
          fields.today = date.toISOString().slice(0, 10);
        } catch {
          /* keep default */
        }
      }
      return {
        type: "info",
        message: msg,
        action: null,
        confidence: 1.0,
        requires_confirmation: false,
        data: { fields },
      };
    }

    // -- LOCATION -----------------------------------------------------------
    if (
      /\b(location|where am i|my location)\b/.test(lower) ||
      /\b(ở đâu|vị trí)\b/.test(lower)
    ) {
      if (!ctx.phone_location) {
        return {
          type: "info",
          message:
            "Phone location is not available — enable location permission in Settings.",
          action: null,
          confidence: 1.0,
          requires_confirmation: false,
          data: {},
        };
      }
      const { latitude, longitude, accuracy_m } = ctx.phone_location;
      fields.phone_lat = latitude.toFixed(5);
      fields.phone_lon = longitude.toFixed(5);
      if (accuracy_m != null) fields.accuracy_m = String(Math.round(accuracy_m));
      const label = ctx.phone_location_label ?? `${fields.phone_lat}, ${fields.phone_lon}`;
      const acc = accuracy_m != null ? ` (±${Math.round(accuracy_m)} m)` : "";
      return {
        type: "info",
        message: `You're at ${label}${acc}.`,
        action: null,
        confidence: 1.0,
        requires_confirmation: false,
        data: { fields },
      };
    }

    // -- DEPLOYMENT / ROUTE -------------------------------------------------
    if (/\b(deployment|site|project)\b/.test(lower)) {
      // Deployment isn't on ClientContextDto directly; fall through to LLM
      // (ai.service.chat sees deployment_id in the body and can describe it).
      return null;
    }
    if (/\b(screen|page|app)\b/.test(lower)) {
      if (!ctx.current_route) return null;
      fields.current_route = ctx.current_route;
      return {
        type: "info",
        message: `You're on the ${ctx.current_route} screen.`,
        action: null,
        confidence: 1.0,
        requires_confirmation: false,
        data: { fields },
      };
    }

    return null;
  }
}
