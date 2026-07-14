import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../common/auth/jwt-auth.guard";
import { RolesGuard } from "../common/auth/roles.guard";
import { Roles } from "../common/auth/roles.decorator";
import { DrawerCommandsService } from "./drawer-commands.service";
import { CreateDrawerCommandDto } from "./dto/create-drawer-command.dto";

/**
 * App-facing command API. Routed under ark + controller because an ark can own
 * multiple controllers. OPERATOR/ADMIN only (canControlDrone) + ark ownership.
 * See docs/ESP32_DEVICE_MVP_PLAN.md §10.
 */
@Controller("arks/:arkId/drawer-controllers/:controllerId/commands")
@ApiTags("drawer-commands")
@ApiBearerAuth("bearerAuth")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("OPERATOR", "ADMIN")
export class DrawerCommandsController {
  constructor(private readonly commands: DrawerCommandsService) {}

  @Post()
  @HttpCode(202)
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiBody({ type: CreateDrawerCommandDto })
  @ApiOkResponse({ description: "202 Accepted — command queued/published." })
  async create(
    @Req() req: Request,
    @Param("arkId") arkId: string,
    @Param("controllerId") controllerId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: CreateDrawerCommandDto,
  ) {
    return this.commands.createCommand(
      { userId: req.user!.userId, role: req.user!.role },
      arkId,
      controllerId,
      idempotencyKey,
      body,
    );
  }

  @Get(":commandId")
  @ApiOkResponse({ description: "Command status for App polling." })
  async get(
    @Req() req: Request,
    @Param("arkId") arkId: string,
    @Param("controllerId") controllerId: string,
    @Param("commandId") commandId: string,
  ) {
    return this.commands.getCommand(req.user!.userId, arkId, controllerId, commandId);
  }
}
