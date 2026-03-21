import { Module } from "@nestjs/common";
import { SupabaseModule } from "../common/supabase/supabase.module";
import { DeploymentsController } from "./deployments.controller";
import { DeploymentsService } from "./deployments.service";

@Module({
  imports: [SupabaseModule],
  controllers: [DeploymentsController],
  providers: [DeploymentsService],
  exports: [DeploymentsService],
})
export class DeploymentsModule {}

