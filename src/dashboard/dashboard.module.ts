import { Module } from "@nestjs/common";
import { SupabaseModule } from "../common/supabase/supabase.module";
import { DeploymentsModule } from "../deployments/deployments.module";
import { DashboardController } from "./dashboard.controller";
import { DashboardService } from "./dashboard.service";

@Module({
  imports: [SupabaseModule, DeploymentsModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}

