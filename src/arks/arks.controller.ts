import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../common/auth/jwt-auth.guard";
import { ArksService } from "./arks.service";
import { ApiBearerAuth, ApiOkResponse, ApiTags } from "@nestjs/swagger";

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
}

