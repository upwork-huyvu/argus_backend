import { Module } from "@nestjs/common";
import { DronesController } from "./drones.controller";
import { DronesService } from "./drones.service";

// SupabaseModule is @Global so no explicit import needed.
@Module({
  controllers: [DronesController],
  providers: [DronesService],
  exports: [DronesService],
})
export class DronesModule {}
