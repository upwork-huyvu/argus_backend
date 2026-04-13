import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { RedisService } from "../common/redis/redis.service";

export type AiSessionTurn = {
  role: "user" | "assistant";
  content: string;
  responseType?: "text" | "status" | "mission_plan" | "command";
  at: string;
};

export type AiSessionMemory = {
  lastIntent: "text" | "status" | "mission_plan" | "command";
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
