import { Controller, Get, NotFoundException, Param, Req, UseGuards } from "@nestjs/common";
import { DeploymentsService } from "../deployments/deployments.service";
import { JwtAuthGuard } from "../common/auth/jwt-auth.guard";
import { isDeploymentType, type DeploymentType } from "../common/deployment-types";
import { DashboardService } from "./dashboard.service";
import type { Request } from "express";
import { ApiBearerAuth, ApiOkResponse, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";

type AuthedRequest = Request & { user?: { userId: string; accessToken: string; role: string } };

@Controller("deployments/:deploymentId/dashboard-kpis")
@ApiTags("dashboard")
@ApiBearerAuth("bearerAuth")
export class DashboardController {
  constructor(private readonly dashboard: DashboardService, private readonly deployments: DeploymentsService) {}

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
          label: { type: "string" },
          value: { type: "string" },
          change: { type: "string" },
        },
      },
    },
    examples: {
      success: {
        summary: "Example dashboard KPIs",
        value: [
          { label: "Active Drones", value: "4", change: "+1 today" },
          { label: "Battery Average", value: "87%", change: "Healthy" },
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
  async getDashboardKpis(@Req() req: AuthedRequest, @Param("deploymentId") deploymentId: string) {
    if (!isDeploymentType(deploymentId)) throw new NotFoundException("Unknown deployment id.");
    // Hydrate ensures RLS for dashboard_kpis select.
    await this.deployments.getDeploymentById(req.user!.userId, deploymentId as DeploymentType, req.user!.accessToken);
    return this.dashboard.getKpis(req.user!.userId, deploymentId as DeploymentType, req.user!.accessToken);
  }
}

