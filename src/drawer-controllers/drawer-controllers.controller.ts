import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../common/auth/jwt-auth.guard";
import { RolesGuard } from "../common/auth/roles.guard";
import { Roles } from "../common/auth/roles.decorator";
import { DrawerControllersService } from "./drawer-controllers.service";
import { AssignControllerDto, SetLifecycleStatusDto } from "./dto/admin-controller.dto";

/**
 * Admin management of drawer controllers: list, assign to an ark (activates it),
 * enable/disable. MVP stand-in for the post-MVP claim/activation flow.
 * See docs/ESP32_DEVICE_MVP_PLAN.md §13, §15 Phase 5.
 */
@Controller("drawer-controllers")
@ApiTags("drawer-controllers")
@ApiBearerAuth("bearerAuth")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("ADMIN")
export class DrawerControllersController {
  constructor(private readonly controllers: DrawerControllersService) {}

  @Get()
  @ApiOkResponse({ description: "All drawer controllers." })
  async list() {
    return this.controllers.list();
  }

  @Patch(":id/assign")
  @ApiOkResponse({ description: "Assign to an ark and activate (UNASSIGNED → ACTIVE)." })
  async assign(@Param("id") id: string, @Body() body: AssignControllerDto) {
    return this.controllers.assignToArk(id, body.arkId);
  }

  @Patch(":id/status")
  @ApiOkResponse({ description: "Set lifecycle status (enable/disable)." })
  async setStatus(@Param("id") id: string, @Body() body: SetLifecycleStatusDto) {
    return this.controllers.setLifecycleStatus(id, body.lifecycleStatus);
  }

  /**
   * Deletes the controller and its commands/state/events; drones docked in it
   * are unassigned but kept. Also clears the broker's retained presence/state
   * so the topics don't outlive the row.
   */
  @Delete(":id")
  @HttpCode(200)
  @ApiOkResponse({ description: "{ id, deleted: true, dronesUnassigned }" })
  async remove(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.controllers.remove(id);
  }
}
