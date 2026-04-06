import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ArksService } from "../arks/arks.service";
import { type DeploymentType, isDeploymentType } from "../common/deployment-types";
import { DeploymentsService } from "../deployments/deployments.service";
import { AiMemoryService } from "./ai-memory.service";
import type { AiSessionMemory } from "./ai-memory.service";
import { type AiChatRequestDto } from "./dto/ai-chat-request.dto";
import { PromptTemplateService } from "./prompt-template.service";

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

export type AiChatResponse = {
  type: "text" | "status" | "mission_plan";
  message: string;
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
    private readonly arks: ArksService,
    private readonly config: ConfigService,
    private readonly memory: AiMemoryService,
    private readonly promptTemplate: PromptTemplateService,
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
    const droneState = await this.resolveDroneState(identity, body);
    const userMessage = body.user_message.trim();
    const sessionKey = this.buildSessionKey(identity.userId, body.deployment_id, body.drone_id);
    const previousMemory = await this.memory.get(sessionKey);

    const intent = this.detectIntent(userMessage, previousMemory?.lastIntent, droneState);

    if (intent === "status") {
      const response = this.buildStatusResponse(userMessage, droneState);
      await this.persistMemory(sessionKey, response, userMessage, previousMemory);
      return response;
    }

    if (intent === "mission_plan") {
      if (previousMemory?.lastMissions?.length) {
        const adjusted = this.adjustPreviousMissionPlan(userMessage, previousMemory.lastMissions);
        if (adjusted) {
          const response = this.safeResponse({
            type: "mission_plan",
            message:
              "I updated the previous mission sequence based on your follow-up instruction. Review the revised steps before running.",
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
          message: `I prepared a ${mapped.length}-step mission sequence based on your request. You can review and execute each step individually or run accepted missions together.`,
          data: { missions: mapped },
        });
        await this.persistMemory(sessionKey, response, userMessage, previousMemory);
        return response;
      }

      if (this.isFollowUpMissionRequest(userMessage) && previousMemory?.lastMissions?.length) {
        const response = this.safeResponse({
          type: "mission_plan",
          message:
            "I reused your previous mission plan from this session context. Review the accepted steps and run when ready.",
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
          message:
            "Closest matches from your deployment mission list only—confirm order before running.",
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
            message:
              "Suggestions use only missions from your deployment. Order follows best match to your message (by name when match is weak).",
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
      droneState,
      chatHistory: this.toPromptHistory(previousMemory),
    });
    if (llm) {
      let response = this.safeResponse(
        await this.enforceConstraints(
          llm,
          availableMissions,
          droneState,
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
      await this.buildSmartFallback(userMessage, availableMissions, droneState, previousMemory),
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
    previousIntent?: "text" | "status" | "mission_plan",
    droneState?: Record<string, unknown>,
  ): "text" | "status" | "mission_plan" {
    const lower = message.toLowerCase();
    const hasTelemetry = droneState && Object.keys(droneState).length > 0;
    if (
      /\b(battery|telemetry|signal|gps|location|power|network)\b/.test(lower) &&
      (hasTelemetry || /\b(drone|aircraft|uav|ark|remote|controller)\b/.test(lower))
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

  private buildStatusResponse(message: string, droneState: Record<string, unknown>): AiChatResponse {
    if (Object.keys(droneState).length === 0) {
      return {
        type: "text",
        message:
          "I do not have live drone telemetry for this request yet. Please select a drone or provide drone_state so I can return an accurate status summary.",
        data: {},
      };
    }

    const lower = message.toLowerCase();
    const status: Record<string, unknown> = {};
    if (/\bbattery|power\b/.test(lower) && "power" in droneState) status.power = droneState.power;
    if (/\bgps\b/.test(lower) && "gps" in droneState) status.gps = droneState.gps;
    if (/\blocation\b/.test(lower) && "location" in droneState) status.location = droneState.location;
    if (/\bsignal|network\b/.test(lower) && "network" in droneState) status.network = droneState.network;

    const picked = Object.keys(status).length > 0 ? status : droneState;
    return {
      type: "status",
      message:
        "I pulled the current drone status from the latest available telemetry state. Here are the most relevant fields for your request.",
      data: { status: picked },
    };
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
    droneState: Record<string, unknown>,
    previousMemory?: AiSessionMemory | null,
  ): Promise<AiChatResponse> {
    const guidance = this.heuristicOperationalGuidance(userMessage, droneState);
    if (guidance) {
      return { type: "text", message: guidance, data: {} };
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
          message:
            "Closest fits from your mission list—double-check order on site before flying.",
          data: { missions: loose },
        };
      }

      if (availableMissions.length > 0) {
        const catalog = this.catalogOnlyMissionPlan(userMessage, availableMissions, 10);
        return {
          type: "mission_plan",
          message:
            "Only missions from your deployment list; ordered by how close they are to what you asked (then name).",
          data: { missions: catalog },
        };
      }

      return {
        type: "text",
        message:
          "You're asking about flying or missions but I don't have a mission catalog loaded—set deployment_id or pass available_missions.",
        data: {},
      };
    }

    const freeform = await this.tryLlmFreeformChat(userMessage, this.toPromptHistory(previousMemory));
    if (freeform !== null) {
      return { type: "text", message: freeform, data: {} };
    }

    return { type: "text", message: "", data: {} };
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
                "You are a friendly teammate. Reply naturally to the user. Plain text only—no JSON wrappers. Be concise unless they want detail.",
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
    droneState: Record<string, unknown>,
  ): string | null {
    const lower = message.toLowerCase();
    const hasTelemetry = Object.keys(droneState).length > 0;

    if (
      /\b(connect|connection|pair|pairing|bind|binding|link|linked|offline|not connected|won't connect|wont connect|can't connect|cant connect|no link|mất kết nối|kết nối)\b/.test(
        lower,
      )
    ) {
      if (!hasTelemetry) {
        return "Link troubleshooting without live telemetry: power RC then aircraft, confirm USB/data link or Wi‑Fi path per your setup, and check the DJI/GCS screen for bind errors. Reseat cables, try another port/cable, ensure no other controller is bound. Reply with drone_id so I can pull the last known Ark record, or paste the exact error string from the app.";
      }
      return "You have some telemetry—confirm status and lastSync look current. If the app still shows disconnected, cold-reboot RC and drone, re-run SDK connection from the device, and verify no duplicate GCS session is holding the link.";
    }

    if (/\b(battery|charge|charging|low power|power low|dead battery|pin yếu|sạc)\b/.test(lower)) {
      const power = droneState.power;
      if (power !== undefined) {
        return `Power snapshot from current state: ${typeof power === "object" ? JSON.stringify(power) : String(power)}. If SOC/voltage is marginal, land or swap packs; if readings look stale, refresh telemetry from the drone feed.`;
      }
      return "No structured power field in the current drone state. Include drone_id or put battery/SOC/voltage under drone_state in your request so I can answer numerically, and say whether you're on the ground or airborne.";
    }

    if (/\b(gps|gnss|satellite|weak signal|lost signal|no gps|mất gps)\b/.test(lower)) {
      if (hasTelemetry && droneState.location !== undefined) {
        return `GNSS/location context: ${JSON.stringify(droneState.location)}. Poor fixes often clear with open sky and distance from metal structures; follow OEM calibration if heading or position jumps.`;
      }
      return "For GPS/GNSS: open sky, interference-free area, current firmware. Wire location into drone_state or ask for a status with 'gps' once telemetry includes fix quality so I can interpret it.";
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

  private async resolveDroneState(
    identity: AuthedIdentity,
    body: AiChatRequestDto,
  ): Promise<Record<string, unknown>> {
    if (body.drone_state && typeof body.drone_state === "object") {
      return body.drone_state;
    }

    if (body.drone_id) {
      const ark = await this.arks.getArkById(identity.userId, identity.accessToken, body.drone_id);
      if (!ark) return {};
      return {
        id: ark.id,
        name: ark.name,
        status: ark.status,
        power: ark.power,
        network: ark.network,
        location: ark.location,
        coreTemp: ark.coreTemp,
        threatLevel: ark.threatLevel,
        lastSync: ark.lastSync,
      };
    }

    return {};
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

  /** Models sometimes return wrong type label or missions at top level — normalize before constraints. */
  private normalizeStructuredLlmPayload(parsed: unknown): AiChatResponse | null {
    if (!parsed || typeof parsed !== "object") return null;
    const o = parsed as Record<string, unknown>;
    const t = o.type;
    const type: AiChatResponse["type"] =
      t === "text" || t === "status" || t === "mission_plan"
        ? t
        : typeof t === "string" && /mission/i.test(t)
          ? "mission_plan"
          : typeof t === "string" && /status|telemetry/i.test(t)
            ? "status"
            : "text";

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
      hasMissions && type !== "status" ? "mission_plan" : type;

    const message = this.pickAssistantMessageFromObject(o);
    return {
      type: resolvedType,
      message,
      data: {
        status: dataObj.status as Record<string, unknown> | undefined,
        missions: dataObj.missions as MissionPlanItem[] | undefined,
      },
    };
  }

  private async tryLlmStructured(input: {
    userMessage: string;
    availableMissions: MissionInput[];
    droneState: Record<string, unknown>;
    chatHistory: Array<{ role: "user" | "assistant"; content: string; responseType?: string; at: string }>;
  }): Promise<AiChatResponse | null> {
    const apiKey = this.config.get<string>("OPENAI_API_KEY")?.trim();
    if (!apiKey) return null;

    const model = this.config.get<string>("OPENAI_MODEL")?.trim() || "gpt-4.1-mini";
    const prompt = await this.promptTemplate.render({
      userMessage: input.userMessage,
      availableMissions: input.availableMissions,
      droneState: input.droneState,
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
          ...this.openAiTemperatureParams(model, 0.45),
          ...this.openAiTokenLimitParams(model, 2048),
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                'Return a single JSON object with keys type, message, data. If type is "text", message must be your full conversational reply (never empty). Use mission_plan only when ordering catalog missions.',
            },
            { role: "user", content: prompt },
          ],
        }),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        if (this.isOpenAiInsufficientQuota(response.status, errText)) {
          this.logger.warn("OpenAI insufficient_quota (structured chat)");
          return {
            type: "text",
            message: OPENAI_INSUFFICIENT_QUOTA_MESSAGE,
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
    droneState: Record<string, unknown>,
    userMessage: string,
    previousMemory?: AiSessionMemory | null,
  ): Promise<AiChatResponse> {
    const missionIdSet = new Set(availableMissions.map((m) => m.id));
    const missionNameById = new Map(availableMissions.map((m) => [m.id, m.name]));
    const droneStateKeys = new Set(Object.keys(droneState));

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
        return this.buildSmartFallback(userMessage, availableMissions, droneState, previousMemory);
      }

      return {
        type: "mission_plan",
        message:
          candidate.message != null && String(candidate.message).trim().length > 0
            ? String(candidate.message)
            : "",
        data: { missions },
      };
    }

    if (candidate.type === "status") {
      const source = candidate.data.status ?? {};
      const status = Object.fromEntries(
        Object.entries(source).filter(([key]) => droneStateKeys.has(key)),
      );
      return {
        type: "status",
        message:
          candidate.message != null && String(candidate.message).trim().length > 0
            ? String(candidate.message)
            : "",
        data: { status: Object.keys(status).length > 0 ? status : droneState },
      };
    }

    return {
      type: "text",
      message: candidate.message != null && String(candidate.message).length > 0 ? String(candidate.message) : "",
      data: {},
    };
  }

  private safeResponse(candidate: AiChatResponse): AiChatResponse {
    if (!candidate || typeof candidate !== "object") {
      return { type: "text", message: "I could not process that safely.", data: {} };
    }

    if (!["text", "status", "mission_plan"].includes(candidate.type)) {
      return { type: "text", message: "I could not process that safely.", data: {} };
    }

    const msg =
      candidate.message != null && String(candidate.message).length > 0
        ? String(candidate.message)
        : "";
    return {
      type: candidate.type,
      message: msg,
      data: {
        status: candidate.data?.status,
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
