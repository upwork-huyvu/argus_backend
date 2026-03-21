import { Controller, Get, NotFoundException, Param, Req, UseGuards } from "@nestjs/common";
import { DeploymentsService } from "./deployments.service";
import { JwtAuthGuard } from "../common/auth/jwt-auth.guard";
import type { Request } from "express";
import { isDeploymentType } from "../common/deployment-types";
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiParam,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";

type AuthedRequest = Request & { user?: { userId: string; accessToken: string } };

@Controller("deployments")
@ApiTags("deployments")
@ApiBearerAuth("bearerAuth")
export class DeploymentsController {
  constructor(private readonly deployments: DeploymentsService) {}

  @UseGuards(JwtAuthGuard)
  @ApiOkResponse({
    isArray: true,
    schema: {
      type: "array",
      items: {
        type: "object",
      },
    },
    examples: {
      success: {
        summary: "Example hydrated deployments",
        value: [
          {
            id: "construction",
            name: "Construction",
            location: "Industrial Zone",
            constraints: {
              maxCustomMissions: 2,
              canEditMissions: true,
              canToggleMissions: true,
            },
            missions: [
              {
                id: "perimeter",
                name: "Perimeter Sweep",
                description: "Patrol fence lines and boundaries for unauthorized access",
                duration: "15 min",
                enabled: true,
                editable: false,
                customizable: true,
              },
            ],
          },
        ],
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: "Unauthorized",
    schema: { type: "object", properties: { message: { type: "string" } } },
  })
  @Get()
  async getDeployments(@Req() req: AuthedRequest) {
    return this.deployments.getDeployments(req.user!.userId, req.user!.accessToken);
  }

  @UseGuards(JwtAuthGuard)
  @ApiParam({
    name: "deploymentId",
    type: "string",
    enum: ["construction", "commercial", "school", "sports", "estate", "residential"],
  })
  @ApiOkResponse({
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        location: { type: "string" },
        missions: { type: "array" },
        constraints: { type: "object" },
      },
    },
    examples: {
      success: {
        summary: "Example single deployment",
        value: {
          id: "construction",
          name: "Construction",
          location: "Industrial Zone",
          constraints: {
            maxCustomMissions: 2,
            canEditMissions: true,
            canToggleMissions: true,
          },
          missions: [
            {
              id: "perimeter",
              name: "Perimeter Sweep",
              description: "Patrol fence lines and boundaries for unauthorized access",
              duration: "15 min",
              enabled: true,
              editable: false,
              customizable: true,
            },
          ],
        },
      },
    },
  })
  @Get(":deploymentId")
  async getDeploymentById(
    @Req() req: AuthedRequest,
    @Param("deploymentId") deploymentId: string,
  ) {
    if (!isDeploymentType(deploymentId)) throw new NotFoundException("Unknown deployment id.");
    return this.deployments.getDeploymentById(req.user!.userId, deploymentId, req.user!.accessToken);
  }
}

