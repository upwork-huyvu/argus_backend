import { Module } from "@nestjs/common";
import { MqttModule } from "../mqtt/mqtt.module";
import { DrawerControllersService } from "./drawer-controllers.service";
import { DrawerControllersController } from "./drawer-controllers.controller";
import { DrawerProvisioningController } from "./drawer-provisioning.controller";
import { DrawerStateController } from "./drawer-state.controller";
import { DrawerControllerKeyGuard } from "./drawer-controller-key.guard";

// SupabaseModule is @Global; ConfigModule is global.
// MqttModule provides MqttService for presence (online/offline) lookups.
@Module({
  imports: [MqttModule],
  controllers: [
    DrawerProvisioningController,
    DrawerControllersController,
    DrawerStateController,
  ],
  providers: [DrawerControllersService, DrawerControllerKeyGuard],
  exports: [DrawerControllersService],
})
export class DrawerControllersModule {}
