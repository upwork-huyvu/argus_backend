import { Module } from "@nestjs/common";
import { MqttModule } from "../mqtt/mqtt.module";
import { DrawerCommandsService } from "./drawer-commands.service";
import { DrawerCommandsController } from "./drawer-commands.controller";
import { DrawerCommandsReconciler } from "./drawer-commands.reconciler";

// SupabaseModule is @Global. MqttModule exports MqttService for publishing.
@Module({
  imports: [MqttModule],
  controllers: [DrawerCommandsController],
  providers: [DrawerCommandsService, DrawerCommandsReconciler],
  exports: [DrawerCommandsService],
})
export class DrawerCommandsModule {}
