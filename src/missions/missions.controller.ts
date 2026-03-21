import {
  BadRequestException,
  Controller,
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
import { ApiBearerAuth, ApiOkResponse, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";

type AuthedRequest = Request & { user?: { userId: string; role: string; accessToken: string } };

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
}

