import { Controller, Get, NotFoundException, Param, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { DeploymentsService } from "../deployments/deployments.service";
import { JwtAuthGuard } from "../common/auth/jwt-auth.guard";
import { isDeploymentType, type DeploymentType } from "../common/deployment-types";
import { AlertsService } from "./alerts.service";
import { ApiBearerAuth, ApiOkResponse, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";

type AuthedRequest = Request & { user?: { userId: string; accessToken: string; role: string } };

@Controller("deployments/:deploymentId/alerts")
@ApiTags("alerts")
@ApiBearerAuth("bearerAuth")
export class AlertsController {
  constructor(private readonly alerts: AlertsService, private readonly deployments: DeploymentsService) {}

  @UseGuards(JwtAuthGuard)
  @ApiParam({
    name: "deploymentId",
    type: "string",
    enum: ["construction", "commercial", "school", "sports", "estate", "residential"],
  })
  @ApiOkResponse({
    isArray: true,
    schema: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          message: { type: "string" },
          time: { type: "string" },
          tone: { type: "string", enum: ["critical", "warning", "success", "info"] },
        },
      },
    },
    examples: {
      success: {
        summary: "Example alerts list",
        value: [
          {
            id: "construction:critical-breach",
            title: "Breach on Back Gate",
            message: "Sending live view",
            time: "Just now",
            tone: "critical",
          },
        ],
      },
    },
  })
  @Get()
  async getAlerts(@Req() req: AuthedRequest, @Param("deploymentId") deploymentId: string) {
    if (!isDeploymentType(deploymentId)) throw new NotFoundException("Unknown deployment id.");
    await this.deployments.getDeploymentById(req.user!.userId, deploymentId as DeploymentType, req.user!.accessToken);
    return this.alerts.getAlerts(req.user!.userId, deploymentId as DeploymentType, req.user!.accessToken);
  }
}

