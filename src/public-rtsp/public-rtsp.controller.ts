import { Body, Controller, Get, Put, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../common/auth/jwt-auth.guard";
import { PutPublicRtspDto } from "./dto/put-public-rtsp.dto";
import { PublicRtspService } from "./public-rtsp.service";
import { ApiBearerAuth, ApiOkResponse, ApiResponse, ApiTags } from "@nestjs/swagger";

type AuthedRequest = Request & { user?: { userId: string; accessToken: string } };

@Controller("public-rtsp")
@ApiTags("public-rtsp")
@ApiBearerAuth("bearerAuth")
export class PublicRtspController {
  constructor(private readonly publicRtsp: PublicRtspService) {}

  @UseGuards(JwtAuthGuard)
  @ApiOkResponse({
    schema: {
      type: "object",
      properties: {
        byDeployment: { type: "object", additionalProperties: { type: "array" } },
      },
    },
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @Get()
  async get(@Req() req: AuthedRequest) {
    const byDeployment = await this.publicRtsp.getMap(req.user!.userId);
    return { byDeployment };
  }

  @UseGuards(JwtAuthGuard)
  @ApiOkResponse({
    schema: {
      type: "object",
      properties: {
        byDeployment: { type: "object", additionalProperties: { type: "array" } },
      },
    },
  })
  @ApiResponse({ status: 400, description: "Validation failed" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @Put()
  async put(@Req() req: AuthedRequest, @Body() body: PutPublicRtspDto) {
    const byDeployment = await this.publicRtsp.putMap(req.user!.userId, body.byDeployment);
    return { byDeployment };
  }
}
