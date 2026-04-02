import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ArksService } from "../arks/arks.service";
import { type DeploymentType } from "../common/deployment-types";
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

  async chat(identity: AuthedIdentity, body: AiChatRequestDto): Promise<AiChatResponse> {
    const availableMissions = await this.resolveAvailableMissions(identity, body);
    const droneState = await this.resolveDroneState(identity, body);
    const userMessage = body.user_message.trim();
    const sessionKey = this.buildSessionKey(identity.userId, body.deployment_id, body.drone_id);
    const previousMemory = await this.memory.get(sessionKey);

    const intent = this.detectIntent(userMessage, previousMemory?.lastIntent);

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
    }

    const llm = await this.tryLlmStructured({
      userMessage,
      availableMissions,
      droneState,
      chatHistory: this.toPromptHistory(previousMemory),
    });
    if (llm) {
      const response = this.safeResponse(this.enforceConstraints(llm, availableMissions, droneState));
      await this.persistMemory(sessionKey, response, userMessage, previousMemory);
      return response;
    }

    const response = this.safeResponse({
      type: "text",
      message:
        "I can help with drone status checks and mission planning. Ask for a status summary, or describe the sequence you want and I will map it to available missions.",
      data: {},
    });
    await this.persistMemory(sessionKey, response, userMessage, previousMemory);
    return response;
  }

  private detectIntent(
    message: string,
    previousIntent?: "text" | "status" | "mission_plan",
  ): "text" | "status" | "mission_plan" {
    const lower = message.toLowerCase();
    if (/\b(status|battery|health|signal|telemetry|gps|location|power)\b/.test(lower)) {
      return "status";
    }
    if (/\b(plan|sequence|mission|route|sweep|inspect|patrol|run)\b/.test(lower)) {
      return "mission_plan";
    }
    if (this.isMissionPlanAdjustmentRequest(lower) && previousIntent === "mission_plan") {
      return "mission_plan";
    }
    if (this.isFollowUpMissionRequest(lower) && previousIntent === "mission_plan") {
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

  private mapMissions(message: string, missions: MissionInput[]): MissionPlanItem[] {
    const q = message.toLowerCase();
    const scored = missions.map((m) => {
      let score = 0;
      if (q.includes(m.id.toLowerCase())) score = Math.max(score, 1);
      if (q.includes(m.name.toLowerCase())) score = Math.max(score, 0.92);
      if (m.aliases?.some((a) => q.includes(a.toLowerCase()))) score = Math.max(score, 0.78);
      const terms = m.name
        .toLowerCase()
        .split(/\s+/)
        .map((x) => x.trim())
        .filter(Boolean);
      const overlap = terms.filter((t) => q.includes(t)).length;
      if (overlap > 0) score = Math.max(score, Math.min(0.55 + overlap * 0.12, 0.86));
      return { mission: m, score };
    });

    return scored
      .filter((x) => x.score >= 0.72)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((x, index) => ({
        id: x.mission.id,
        name: x.mission.name,
        order: index + 1,
        reason: "Matched from your request",
      }));
  }

  private async resolveAvailableMissions(
    identity: AuthedIdentity,
    _body: AiChatRequestDto,
  ): Promise<MissionInput[]> {
    try {
      const promptDeploymentId: DeploymentType = "construction";
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
        `Failed loading construction missions from Supabase: ${
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
          temperature: 0.1,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "Return JSON only. No markdown." },
            { role: "user", content: prompt },
          ],
        }),
      });

      if (!response.ok) return null;
      const raw = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = raw.choices?.[0]?.message?.content;
      if (!content) return null;
      return JSON.parse(content) as AiChatResponse;
    } catch (error) {
      this.logger.warn(
        `LLM fallback failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      return null;
    }
  }

  private enforceConstraints(
    candidate: AiChatResponse,
    availableMissions: MissionInput[],
    droneState: Record<string, unknown>,
  ): AiChatResponse {
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
        return {
          type: "text",
          message:
            "I could not map that request to the available mission catalog yet. Please mention mission names directly, or ask me to suggest a plan from the construction mission set.",
          data: {},
        };
      }

      return {
        type: "mission_plan",
        message: candidate.message || "Mission plan generated.",
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
          candidate.message ||
          "I captured the requested drone status from the current state and filtered it to valid telemetry fields.",
        data: { status: Object.keys(status).length > 0 ? status : droneState },
      };
    }

    return {
      type: "text",
      message: candidate.message || "I processed your request and returned the safest structured response.",
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

    return {
      type: candidate.type,
      message: String(candidate.message || "I processed your request successfully."),
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
    const maxTurns = Number(this.config.get<string>("AI_MEMORY_TURNS") ?? "10");
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

    await this.memory.set(sessionKey, {
      lastIntent: response.type,
      lastMessage: userMessage,
      lastMissions:
        response.type === "mission_plan"
          ? (response.data.missions ?? []).map((m) => ({
              id: m.id,
              name: m.name,
              order: m.order,
            }))
          : [],
      turns: nextTurns,
      updatedAt: new Date().toISOString(),
    });
  }

  private toPromptHistory(previousMemory?: AiSessionMemory | null) {
    return (previousMemory?.turns ?? []).slice(-8);
  }
}
