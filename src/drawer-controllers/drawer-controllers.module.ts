import { Module } from "@nestjs/common";
import { DrawerControllersService } from "./drawer-controllers.service";
import { DrawerControllersController } from "./drawer-controllers.controller";
import { DrawerProvisioningController } from "./drawer-provisioning.controller";
import { DrawerControllerKeyGuard } from "./drawer-controller-key.guard";

// SupabaseModule is @Global; ConfigModule is global.
@Module({
  controllers: [DrawerProvisioningController, DrawerControllersController],
  providers: [DrawerControllersService, DrawerControllerKeyGuard],
  exports: [DrawerControllersService],
})
export class DrawerControllersModule {}
