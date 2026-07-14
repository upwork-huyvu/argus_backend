import { Body, Controller, Param, Put, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { ApiBody, ApiOkResponse, ApiSecurity, ApiTags } from "@nestjs/swagger";
import { DrawerControllersService } from "./drawer-controllers.service";
import { DrawerControllerKeyGuard } from "./drawer-controller-key.guard";
import { RegisterControllerDto } from "./dto/register-controller.dto";

/**
 * ESP32-facing registration. Idempotent create-or-update keyed by the MAC in the
 * URL. Auth is the shared `X-Controller-Key` (MVP). Not behind JwtAuthGuard —
 * devices have no user token. See docs/ESP32_DEVICE_MVP_PLAN.md §7.
 */
@Controller("drawer-provisioning")
@ApiTags("drawer-provisioning")
@ApiSecurity("controllerKey")
@UseGuards(DrawerControllerKeyGuard)
export class DrawerProvisioningController {
  constructor(private readonly controllers: DrawerControllersService) {}

  @Put(":mac")
  @ApiBody({ type: RegisterControllerDto })
  @ApiOkResponse({
    description: "201 when created, 200 when already registered.",
    schema: {
      type: "object",
      properties: {
        controllerId: { type: "string", format: "uuid" },
        macAddress: { type: "string", example: "7CDFA1123456" },
        registrationOutcome: { type: "string", enum: ["CREATED", "ALREADY_REGISTERED"] },
        lifecycleStatus: { type: "string", enum: ["UNASSIGNED", "ACTIVE", "DISABLED"] },
        serverTime: { type: "string", format: "date-time" },
      },
    },
  })
  async register(
    @Param("mac") mac: string,
    @Body() body: RegisterControllerDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.controllers.register(mac, body);
    res.status(result.created ? 201 : 200);
    return result.body;
  }
}
