import { Controller, Get, Param, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { ApiBearerAuth, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../common/auth/jwt-auth.guard";
import { DrawerControllersService } from "./drawer-controllers.service";

/**
 * Owner-scoped read of a drawer's last reported state. Separate from
 * DrawerControllersController because that one is ADMIN-only at class level —
 * a normal owner must be able to see whether their drawer is OPEN/CLOSED.
 */
@Controller("arks/:arkId/drawer-controllers/:controllerId")
@ApiTags("drawer-controllers")
@ApiBearerAuth("bearerAuth")
@UseGuards(JwtAuthGuard)
export class DrawerStateController {
  constructor(private readonly controllers: DrawerControllersService) {}

  @Get("state")
  @ApiOkResponse({
    description:
      "Last sensor-reported drawer state + MQTT presence. drawerState is null until the device publishes.",
    schema: {
      type: "object",
      properties: {
        controllerId: { type: "string", format: "uuid" },
        arkId: { type: "string" },
        lifecycleStatus: { type: "string", enum: ["UNASSIGNED", "ACTIVE", "DISABLED"] },
        online: { type: "boolean" },
        lastSeenAt: { type: "string", format: "date-time", nullable: true },
        drawerState: {
          type: "string",
          nullable: true,
          enum: ["UNKNOWN", "CLOSED", "OPENING", "OPEN", "CLOSING", "BLOCKED", "FAULT"],
        },
        lightState: { type: "string", nullable: true, enum: ["ON", "OFF"] },
        lockState: { type: "string", nullable: true },
        sensorState: { type: "object", nullable: true },
        bootId: { type: "string", nullable: true },
        reportedAt: { type: "string", format: "date-time", nullable: true },
      },
    },
  })
  async getState(
    @Req() req: Request,
    @Param("arkId") arkId: string,
    @Param("controllerId") controllerId: string,
  ) {
    return this.controllers.getStateForArk(req.user!.userId, arkId, controllerId);
  }
}
