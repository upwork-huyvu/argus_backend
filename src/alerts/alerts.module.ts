import { Module } from "@nestjs/common";
import { SupabaseModule } from "../common/supabase/supabase.module";
import { DeploymentsModule } from "../deployments/deployments.module";
import { AlertsController } from "./alerts.controller";
import { AlertsService } from "./alerts.service";

@Module({
  imports: [SupabaseModule, DeploymentsModule],
  controllers: [AlertsController],
  providers: [AlertsService],
})
export class AlertsModule {}

