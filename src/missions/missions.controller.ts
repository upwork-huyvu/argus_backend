import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { DeploymentsService } from "../deployments/deployments.service";
import { JwtAuthGuard } from "../common/auth/jwt-auth.guard";
import { isDeploymentType, type DeploymentType } from "../common/deployment-types";
import { MissionsService } from "./missions.service";
import type { Request } from "express";
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";

type AuthedRequest = Request & { user?: { userId: string; role: string; accessToken: string } };

/**
 * Mission collection-level routes (CREATE).
 * Kept separate from the per-mission routes because of NestJS path-token shadowing.
 */
@Controller("deployments/:deploymentId/missions")
@ApiTags("missions")
@ApiBearerAuth("bearerAuth")
export class MissionsCollectionController {
  constructor(private readonly missions: MissionsService) {}

  @UseGuards(JwtAuthGuard)
  @ApiParam({
    name: "deploymentId",
    type: "string",
    enum: ["construction", "commercial", "school", "sports", "estate", "residential"],
  })
  @ApiBody({
    schema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", example: "After-hours Patrol" },
        description: { type: "string", example: "Evening perimeter sweep" },
        duration: { type: "string", example: "12 min" },
      },
    },
  })
  @ApiOkResponse({
    schema: {
      type: "object",
      properties: { deployment: { type: "object" } },
    },
  })
  @ApiResponse({ status: 400, description: "Validation failed / custom mission limit reached" })
  @Post()
  async create(
    @Req() req: AuthedRequest,
    @Param("deploymentId") deploymentId: string,
    @Body() body: { name?: string; description?: string; duration?: string },
  ) {
    if (!isDeploymentType(deploymentId)) throw new NotFoundException("Unknown deployment id.");
    const name = (body?.name ?? "").trim();
    if (!name) throw new BadRequestException({ message: "Validation failed." });
    return this.missions.createMission({
      userId: req.user!.userId,
      role: req.user!.role,
      accessToken: req.user!.accessToken,
      deploymentId: deploymentId as DeploymentType,
      name,
      description: (body?.description ?? "").trim(),
      duration: (body?.duration ?? "").trim() || "—",
    });
  }
}

@Controller("deployments/:deploymentId/missions/:missionId")
@ApiTags("missions")
@ApiBearerAuth("bearerAuth")
export class MissionsController {
  constructor(private readonly missions: MissionsService) {}

  @UseGuards(JwtAuthGuard)
  @ApiParam({
    name: "deploymentId",
    type: "string",
    enum: ["construction", "commercial", "school", "sports", "estate", "residential"],
  })
  @ApiParam({ name: "missionId", type: "string" })
  @ApiOkResponse({
    schema: {
      type: "object",
      properties: { deployment: { type: "object" } },
    },
    examples: {
      success: {
        summary: "Example toggle mission response",
        value: {
          deployment: {
            id: "construction",
            missions: [
              {
                id: "perimeter",
                enabled: false,
              },
            ],
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 403,
    description: "Forbidden",
    schema: { type: "object", properties: { message: { type: "string" } } },
  })
  @Post("toggle")
  async toggle(
    @Req() req: AuthedRequest,
    @Param("deploymentId") deploymentId: string,
    @Param("missionId") missionId: string,
  ) {
    if (!isDeploymentType(deploymentId)) throw new NotFoundException("Unknown deployment id.");
    if (!missionId) throw new BadRequestException({ message: "Validation failed." });
    return this.missions.toggleMission({
      userId: req.user!.userId,
      role: req.user!.role,
      accessToken: req.user!.accessToken,
      deploymentId: deploymentId as DeploymentType,
      missionId,
    });
  }

  @UseGuards(JwtAuthGuard)
  @ApiParam({
    name: "deploymentId",
    type: "string",
    enum: ["construction", "commercial", "school", "sports", "estate", "residential"],
  })
  @ApiParam({ name: "missionId", type: "string" })
  @ApiOkResponse({
    schema: {
      type: "object",
      properties: { deployment: { type: "object" } },
    },
    examples: {
      success: {
        summary: "Example duplicate mission response",
        value: {
          deployment: {
            id: "construction",
            missions: [
              {
                id: "custom_123",
                name: "Perimeter Sweep (Copy)",
                enabled: false,
                editable: true,
                customizable: true,
              },
            ],
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: "Custom mission limit reached",
    schema: { type: "object", properties: { message: { type: "string" } } },
  })
  @Post("duplicate")
  async duplicate(
    @Req() req: AuthedRequest,
    @Param("deploymentId") deploymentId: string,
    @Param("missionId") missionId: string,
  ) {
    if (!isDeploymentType(deploymentId)) throw new NotFoundException("Unknown deployment id.");
    if (!missionId) throw new BadRequestException({ message: "Validation failed." });
    return this.missions.duplicateMission({
      userId: req.user!.userId,
      role: req.user!.role,
      accessToken: req.user!.accessToken,
      deploymentId: deploymentId as DeploymentType,
      missionId,
    });
  }

  @UseGuards(JwtAuthGuard)
  @ApiParam({
    name: "deploymentId",
    type: "string",
    enum: ["construction", "commercial", "school", "sports", "estate", "residential"],
  })
  @ApiParam({ name: "missionId", type: "string" })
  @ApiOkResponse({
    schema: {
      type: "object",
      properties: { deployment: { type: "object" } },
    },
  })
  @ApiResponse({ status: 403, description: "Forbidden — non-customizable mission cannot be deleted" })
  @Delete()
  async remove(
    @Req() req: AuthedRequest,
    @Param("deploymentId") deploymentId: string,
    @Param("missionId") missionId: string,
  ) {
    if (!isDeploymentType(deploymentId)) throw new NotFoundException("Unknown deployment id.");
    if (!missionId) throw new BadRequestException({ message: "Validation failed." });
    return this.missions.deleteMission({
      userId: req.user!.userId,
      role: req.user!.role,
      accessToken: req.user!.accessToken,
      deploymentId: deploymentId as DeploymentType,
      missionId,
    });
  }
}
