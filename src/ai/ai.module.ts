import { Module } from "@nestjs/common";
import { ArksModule } from "../arks/arks.module";
import { RedisModule } from "../common/redis/redis.module";
import { DeploymentsModule } from "../deployments/deployments.module";
import { AiController } from "./ai.controller";
import { AiMemoryService } from "./ai-memory.service";
import { AiService } from "./ai.service";
import { PromptLoaderService } from "./prompt-loader.service";

@Module({
  imports: [DeploymentsModule, ArksModule, RedisModule],
  controllers: [AiController],
  providers: [AiService, AiMemoryService, PromptLoaderService],
})
export class AiModule {}
