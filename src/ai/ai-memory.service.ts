import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { RedisService } from "../common/redis/redis.service";

/**
 * Mirrors the response-type union in `ai.service.ts`. Kept as a string-set
 * here so this file stays free of cross-imports — `ai.service.ts` is what
 * stamps these values onto memory rows.
 */
export type AiResponseTypeLabel =
  | "text"
  | "info"
  | "status"
  | "mission_plan"
  | "command"
  | "command_sequence"
  | "navigation";

export type AiSessionTurn = {
  role: "user" | "assistant";
  content: string;
  responseType?: AiResponseTypeLabel;
  at: string;
};

export type AiSessionMemory = {
  lastIntent: AiResponseTypeLabel;
  lastMessage: string;
  lastMissions: Array<{ id: string; name: string; order: number }>;
  turns: AiSessionTurn[];
  updatedAt: string;
};

@Injectable()
export class AiMemoryService {
  private readonly localFallback = new Map<string, AiSessionMemory>();

  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  async get(key: string): Promise<AiSessionMemory | null> {
    const client = await this.redis.getClient();
    if (client) {
      const raw = await client.get(this.asRedisKey(key));
      if (!raw) return null;
      return JSON.parse(raw) as AiSessionMemory;
    }
    return this.localFallback.get(key) ?? null;
  }

  async set(key: string, value: AiSessionMemory): Promise<void> {
    const client = await this.redis.getClient();
    if (client) {
      const ttl = Number(this.config.get<string>("AI_MEMORY_TTL_SECONDS") ?? "3600");
      await client.set(this.asRedisKey(key), JSON.stringify(value), { EX: Math.max(ttl, 60) });
      return;
    }
    this.localFallback.set(key, value);
  }

  private asRedisKey(key: string): string {
    return `argus:ai:session:${key}`;
  }
}
