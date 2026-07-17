import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../common/auth/jwt-auth.guard";
import { RolesGuard } from "../common/auth/roles.guard";
import { Roles } from "../common/auth/roles.decorator";
import { DronesService } from "./drones.service";
import { AssignDroneDto, CreateDroneDto, UpdateDroneDto } from "./dto/drone.dto";

/**
 * Drones + their mapping to a drawer controller.
 * Mutations are ADMIN-only; reads are owner-scoped.
 */
@Controller()
@ApiTags("drones")
@ApiBearerAuth("bearerAuth")
export class DronesController {
  constructor(private readonly drones: DronesService) {}

  /** Owner-scoped: drones of an ark you own. */
  @UseGuards(JwtAuthGuard)
  @Get("arks/:arkId/drones")
  @ApiOkResponse({ description: "Drones of the ark, incl. drawerControllerId mapping." })
  async listByArk(@Req() req: Request, @Param("arkId") arkId: string) {
    await this.drones.assertArkExists(arkId, req.user!.userId);
    return this.drones.listByArk(arkId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("ADMIN")
  @Post("drones")
  @ApiBody({ type: CreateDroneDto })
  @ApiOkResponse({ description: "201 — drone created under the given ark." })
  async create(@Body() body: CreateDroneDto) {
    return this.drones.create(body);
  }

  /**
   * Map / unmap a drone to the drawer it sits in. Send
   * `{"drawerControllerId": null}` to detach (e.g. drone in flight).
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("ADMIN")
  @Patch("drones/:id/assign")
  @ApiBody({ type: AssignDroneDto })
  @ApiOkResponse({ description: "Drone mapped to (or detached from) a drawer controller." })
  async assign(@Param("id", new ParseUUIDPipe()) id: string, @Body() body: AssignDroneDto) {
    return this.drones.assignToController(id, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("ADMIN")
  @Patch("drones/:id")
  @ApiBody({ type: UpdateDroneDto })
  @ApiOkResponse({ description: "Update model / serialNumber / status." })
  async update(@Param("id", new ParseUUIDPipe()) id: string, @Body() body: UpdateDroneDto) {
    return this.drones.update(id, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("ADMIN")
  @Delete("drones/:id")
  @HttpCode(200)
  @ApiOkResponse({ description: "{ id, deleted: true }" })
  async remove(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.drones.remove(id);
  }
}
