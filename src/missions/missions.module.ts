import { Module } from "@nestjs/common";
import { SupabaseModule } from "../common/supabase/supabase.module";
import { DeploymentsModule } from "../deployments/deployments.module";
import { MissionsCollectionController, MissionsController } from "./missions.controller";
import { MissionsService } from "./missions.service";

@Module({
  imports: [SupabaseModule, DeploymentsModule],
  controllers: [MissionsCollectionController, MissionsController],
  providers: [MissionsService],
})
export class MissionsModule {}

