import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { type DeploymentType, isDeploymentType } from "../common/deployment-types";
import { DeploymentsService } from "../deployments/deployments.service";
import { AiMemoryService } from "./ai-memory.service";
import type { AiSessionMemory } from "./ai-memory.service";
import { type AiChatRequestDto } from "./dto/ai-chat-request.dto";
import { ARGUS_SYSTEM_PROMPT, buildContextBlock } from "./prompt-template.service";

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
export const DRONE_ACTIONS = [
  "TAKEOFF",
  "LAND",
  "EMERGENCY_LAND",
  "RETURN_HOME",
  "HOVER",
  "FOLLOW_ME",
  "GO_TO_WAYPOINT",
  "RUN_MISSION",
] as const;

export type DroneActionName = (typeof DRONE_ACTIONS)[number];

export type DroneAction = {
  name: DroneActionName;
  params: Record<string, unknown>;
};

export type AiChatResponse = {
  type: "text" | "status" | "mission_plan" | "command";
  message: string;
  /** Non-null when the response maps to a direct drone command. */
  action: DroneAction | null;
  /** 0.0–1.0 — how confident the AI is in this interpretation. */
  confidence: number;
  query?: StatusQuery;
  requires_confirmation?: boolean;
  data: {
    status?: Record<string, unknown>;
    missions?: MissionPlanItem[];
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
    const availableMissions = await this.resolveAvailableMissions(identity, body);
    const userMessage = body.user_message.trim();
    const sessionKey = this.buildSessionKey(identity.userId, body.deployment_id, body.drone_id);
    const previousMemory = await this.memory.get(sessionKey);

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
        const fill = await this.tryLlmFreeformChat(userMessage, this.toPromptHistory(previousMemory));
        if (fill?.trim()) {
          response = { ...response, message: fill.trim() };
        }
      }
      await this.persistMemory(sessionKey, response, userMessage, previousMemory);
      return response;
    }

    const response = this.safeResponse(
      await this.buildSmartFallback(userMessage, availableMissions, previousMemory),
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
    previousIntent?: "text" | "status" | "mission_plan" | "command",
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

    const freeform = await this.tryLlmFreeformChat(userMessage, this.toPromptHistory(previousMemory));
    if (freeform !== null) {
      return { type: "text", message: freeform, action: null, confidence: 0.7, data: {} };
    }

    return { type: "text", message: "", action: null, confidence: 0, data: {} };
  }

  /** Plain chat completion—no JSON envelope. Used when structured chat fails or is skipped. */
  private async tryLlmFreeformChat(
    userMessage: string,
    chatHistory: Array<{ role: "user" | "assistant"; content: string; responseType?: string; at: string }>,
  ): Promise<string | null> {
    const apiKey = this.config.get<string>("OPENAI_API_KEY")?.trim();
    if (!apiKey) return null;

    const model = this.config.get<string>("OPENAI_MODEL")?.trim() || "gpt-4.1-mini";
    const historyMsgs = chatHistory.map((t) => ({
      role: t.role as "user" | "assistant",
      content: t.content,
    }));

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
          messages: [
            {
              role: "system",
              content:
                "You are ARGUS, a drone operations assistant. Reply in plain text only — no JSON. 1-2 sentences unless asked for more. Be direct and operational.",
            },
            ...historyMsgs,
            { role: "user", content: userMessage },
          ],
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
   *  Handles: wrong type labels, missions at top level, new action/confidence fields.
   */
  private normalizeStructuredLlmPayload(parsed: unknown): AiChatResponse | null {
    if (!parsed || typeof parsed !== "object") return null;
    const o = parsed as Record<string, unknown>;

    // --- type ---
    const t = o.type;
    const type: AiChatResponse["type"] =
      t === "text" || t === "status" || t === "mission_plan" || t === "command"
        ? t
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
    if (!dataObj.status && o.status && typeof o.status === "object" && !Array.isArray(o.status)) {
      dataObj.status = o.status;
    }

    const missionsArr = dataObj.missions;
    const hasMissions = Array.isArray(missionsArr) && missionsArr.length > 0;
    const resolvedType: AiChatResponse["type"] =
      hasMissions && type !== "status" && type !== "command" ? "mission_plan" : type;

    // --- action: validate name against DRONE_ACTIONS catalog ---
    let action: DroneAction | null = null;
    const rawAction = o.action;
    if (rawAction && typeof rawAction === "object" && !Array.isArray(rawAction)) {
      const a = rawAction as Record<string, unknown>;
      const actionName = typeof a.name === "string" ? a.name.toUpperCase() : "";
      if ((DRONE_ACTIONS as readonly string[]).includes(actionName)) {
        action = {
          name: actionName as DroneActionName,
          params: (a.params && typeof a.params === "object" && !Array.isArray(a.params)
            ? a.params
            : {}) as Record<string, unknown>,
        };
      }
    }

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
      },
    };
  }

  /**
   * Builds the OpenAI messages array using proper multi-turn structure:
   *   [system: persona] → [system: operational context] → [...history turns] → [user: current message]
   *
   * Benefits vs. old single-user-message approach:
   *   - Context is in the right role (system), not in user turn
   *   - History uses real OpenAI roles → better attention
   *   - Token efficient: no JSON-serialised chat_history blob in prompt
   */
  private buildMessagesArray(input: {
    userMessage: string;
    availableMissions: MissionInput[];
    deploymentType?: string;
    chatHistory: Array<{ role: "user" | "assistant"; content: string }>;
  }): Array<{ role: string; content: string }> {
    const contextBlock = buildContextBlock({
      availableMissions: input.availableMissions,
      deploymentType: input.deploymentType,
    });

    // Keep last 6 turns (3 exchanges) to cap history tokens
    const recentHistory = input.chatHistory.slice(-6);

    return [
      { role: "system", content: ARGUS_SYSTEM_PROMPT },
      { role: "system", content: contextBlock },
      ...recentHistory.map((t) => ({ role: t.role, content: t.content })),
      { role: "user", content: input.userMessage },
    ];
  }

  private async tryLlmStructured(input: {
    userMessage: string;
    availableMissions: MissionInput[];
    deploymentType?: string;
    chatHistory: Array<{ role: "user" | "assistant"; content: string; responseType?: string; at: string }>;
  }): Promise<AiChatResponse | null> {
    const apiKey = this.config.get<string>("OPENAI_API_KEY")?.trim();
    if (!apiKey) return null;

    const model = this.config.get<string>("OPENAI_MODEL")?.trim() || "gpt-4.1-mini";
    const messages = this.buildMessagesArray({
      userMessage: input.userMessage,
      availableMissions: input.availableMissions,
      deploymentType: input.deploymentType,
      chatHistory: input.chatHistory,
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
      return {
        type: "command",
        message: msg(candidate.message),
        action: candidate.action,
        confidence: candidate.confidence,
        requires_confirmation: true,
        data: {},
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

    if (!["text", "status", "mission_plan", "command"].includes(candidate.type)) {
      return { type: "text", message: "Request could not be processed.", action: null, confidence: 0, data: {} };
    }

    const msg =
      candidate.message != null && String(candidate.message).length > 0
        ? String(candidate.message)
        : "";
    return {
      type: candidate.type,
      message: msg,
      action: candidate.action ?? null,
      confidence: typeof candidate.confidence === "number" ? candidate.confidence : 0.8,
      query: candidate.type === "status" ? (candidate.query ?? "ALL") : undefined,
      requires_confirmation:
        candidate.type === "command" || candidate.type === "mission_plan"
          ? (candidate.requires_confirmation ?? true)
          : undefined,
      data: {
        status: undefined,
        missions: candidate.data?.missions,
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
}
