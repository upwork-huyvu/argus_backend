import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../common/auth/jwt-auth.guard";
import { RolesGuard } from "../common/auth/roles.guard";
import { Roles } from "../common/auth/roles.decorator";
import { ArksService } from "./arks.service";
import { CreateArkDto } from "./dto/create-ark.dto";
import { UpdateArkDto } from "./dto/update-ark.dto";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiTags,
} from "@nestjs/swagger";

type AuthedRequest = Request & { user?: { userId: string; accessToken: string; role: string } };

@Controller("arks")
@ApiTags("arks")
@ApiBearerAuth("bearerAuth")
export class ArksController {
  constructor(private readonly arks: ArksService) {}

  @UseGuards(JwtAuthGuard)
  @ApiOkResponse({
    isArray: true,
    schema: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          location: { type: "string" },
          status: { type: "string", enum: ["online", "offline"] },
          power: { type: "number" },
          network: { type: "string" },
          coreTemp: { type: "number" },
          dockStatus: { type: "string", enum: ["locked", "unlocked"] },
          droneCount: { type: "number" },
          droneModel: { type: "string", nullable: true },
          threatLevel: { type: "string", enum: ["low", "medium", "high"] },
          lastSync: { type: "string" },
          firmware: { type: "string" },
          operator: { type: "string" },
          deploymentType: { type: "string" },
          heroImage: { type: "string", nullable: true },
        },
      },
    },
    examples: {
      success: {
        summary: "Example arks list",
        value: [
          {
            id: "ark-01",
            name: "ARK-01 Orlando",
            location: "Orlando, FL",
            status: "online",
            power: 92,
            network: "Secure LTE",
            coreTemp: 38,
            dockStatus: "locked",
            droneCount: 3,
            droneModel: "Mavic Air 2",
            threatLevel: "low",
            lastSync: "12:42 PM",
            firmware: "v1.0.3",
            operator: "Capt. Daniel Reyes",
            deploymentType: "Construction",
            heroImage: "/assets/original/arv_1.png",
          },
        ],
      },
    },
  })
  @Get()
  async getArks(@Req() req: AuthedRequest) {
    return this.arks.getArks(req.user!.userId, req.user!.accessToken);
  }

  /**
   * ADMIN only: every ark across all users, with owner info.
   * MUST stay declared above `@Get(":id")` or "/arks/all" resolves as id="all".
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("ADMIN")
  @Get("all")
  @ApiOkResponse({ description: "All arks with their owner (admin view)." })
  async listAllArks() {
    return this.arks.listAllArks();
  }

  /** Owner-scoped single ark. Returns 404 if it isn't yours. */
  @UseGuards(JwtAuthGuard)
  @Get(":id")
  @ApiOkResponse({ description: "A single ark owned by the caller." })
  async getArkById(@Req() req: AuthedRequest, @Param("id") id: string) {
    const ark = await this.arks.getArkById(req.user!.userId, req.user!.accessToken, id);
    if (!ark) throw new NotFoundException("Ark not found.");
    return ark;
  }

  // ─── Admin ────────────────────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("ADMIN")
  @Post()
  @ApiBody({ type: CreateArkDto })
  @ApiOkResponse({ description: "201 — ark created for the given user." })
  async createArk(@Body() body: CreateArkDto) {
    return this.arks.createArk(body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("ADMIN")
  @Patch(":id")
  @ApiBody({ type: UpdateArkDto })
  @ApiOkResponse({ description: "Partial update. Sending userId transfers ownership." })
  async updateArk(@Param("id") id: string, @Body() body: UpdateArkDto) {
    return this.arks.updateArk(id, body);
  }

  /**
   * Cascades: deletes the ark's drones + drawer_commands, and unassigns
   * (SET NULL) any drawer_controllers pointing at it.
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("ADMIN")
  @Delete(":id")
  @HttpCode(200)
  @ApiOkResponse({ description: "{ id, deleted: true }" })
  async deleteArk(@Param("id") id: string) {
    return this.arks.deleteArk(id);
  }
}

