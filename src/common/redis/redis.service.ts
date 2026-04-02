import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createClient } from "redis";

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: ReturnType<typeof createClient> | null = null;
  private initialized = false;
  private disabled = false;

  constructor(private readonly config: ConfigService) {}

  async getClient(): Promise<ReturnType<typeof createClient> | null> {
    if (this.disabled) return null;
    if (this.client?.isOpen) return this.client;
    if (this.initialized) return this.client;

    this.initialized = true;
    const redisUrl = this.config.get<string>("REDIS_URL")?.trim();
    if (!redisUrl) {
      this.logger.log("REDIS_URL not configured. Redis memory disabled.");
      this.disabled = true;
      return null;
    }

    try {
      const client = createClient({ url: redisUrl });
      client.on("error", (error: unknown) => {
        this.logger.warn(
          `Redis client error: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      await client.connect();
      this.client = client;
      this.logger.log("Redis connected.");
      return this.client;
    } catch (error) {
      this.logger.warn(
        `Redis connect failed. Falling back to in-memory only: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.disabled = true;
      return null;
    }
  }

  async onModuleDestroy() {
    if (this.client?.isOpen) {
      await this.client.quit();
    }
  }
}
