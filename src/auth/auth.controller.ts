import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { AuthService } from "./auth.service";
import { LoginRequestDto } from "./dto/login-request.dto";
import { RegisterRequestDto } from "./dto/register-request.dto";
import { ForgotPasswordDto } from "./dto/forgot-password.dto";
import { ChangePasswordDto } from "./dto/change-password.dto";
import { RefreshTokenDto } from "./dto/refresh-token.dto";
import { JwtAuthGuard } from "../common/auth/jwt-auth.guard";

const AuthUserResponseSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    email: { type: "string" },
    fullName: { type: "string", nullable: true },
    username: { type: "string", nullable: true },
    phone: { type: "string", nullable: true },
    organization: { type: "string", nullable: true },
    avatarUrl: { type: "string", nullable: true },
    role: { type: "string", enum: ["GUEST", "OPERATOR", "ADMIN"] },
    isActive: { type: "boolean" },
    permissions: {
      type: "object",
      properties: {
        canControlDrone: { type: "boolean" },
        canManageUsers: { type: "boolean" },
        canEditMissions: { type: "boolean" },
        canViewDashboard: { type: "boolean" },
      },
      required: ["canControlDrone", "canManageUsers", "canEditMissions", "canViewDashboard"],
    },
  },
  required: ["id", "email", "role", "isActive", "permissions"],
};

const SessionResponseSchema = {
  type: "object",
  properties: {
    accessToken: { type: "string" },
    refreshToken: { type: "string" },
    expiresAt: { type: "number", nullable: true },
    user: AuthUserResponseSchema,
  },
  required: ["accessToken", "refreshToken", "user"],
};

@Controller("auth")
@ApiTags("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // ---------------------------------------------------------------------------
  @ApiBody({ type: LoginRequestDto })
  @ApiOkResponse({ schema: SessionResponseSchema })
  @ApiResponse({ status: 401, description: "Invalid credentials." })
  @HttpCode(200)
  @Post("login")
  async login(@Body() body: LoginRequestDto) {
    return this.authService.login(body.email, body.password);
  }

  // ---------------------------------------------------------------------------
  @ApiBody({ type: RegisterRequestDto })
  @ApiOkResponse({ schema: SessionResponseSchema })
  @ApiResponse({ status: 409, description: "Email already registered." })
  @HttpCode(200)
  @Post("register")
  async register(@Body() body: RegisterRequestDto) {
    return this.authService.register(body);
  }

  // ---------------------------------------------------------------------------
  @ApiBody({ type: ForgotPasswordDto })
  @ApiOkResponse({
    schema: {
      type: "object",
      properties: { sent: { type: "boolean", example: true } },
      required: ["sent"],
    },
  })
  @HttpCode(200)
  @Post("forgot-password")
  async forgotPassword(@Body() body: ForgotPasswordDto) {
    return this.authService.forgotPassword(body.email);
  }

  // ---------------------------------------------------------------------------
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth("bearerAuth")
  @ApiBody({ type: ChangePasswordDto })
  @ApiOkResponse({
    schema: {
      type: "object",
      properties: { ok: { type: "boolean", example: true } },
      required: ["ok"],
    },
  })
  @ApiResponse({ status: 401, description: "Unauthorized or wrong current password." })
  @HttpCode(200)
  @Post("change-password")
  async changePassword(@Req() req: Request, @Body() body: ChangePasswordDto) {
    return this.authService.changePassword(
      req.user!.accessToken,
      body.currentPassword,
      body.newPassword,
    );
  }

  // ---------------------------------------------------------------------------
  @ApiBody({ type: RefreshTokenDto })
  @ApiOkResponse({ schema: SessionResponseSchema })
  @ApiResponse({ status: 401, description: "Session expired." })
  @HttpCode(200)
  @Post("refresh")
  async refresh(@Body() body: RefreshTokenDto) {
    return this.authService.refresh(body.refreshToken);
  }

  // ---------------------------------------------------------------------------
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth("bearerAuth")
  @ApiOkResponse({
    schema: {
      type: "object",
      properties: { ok: { type: "boolean", example: true } },
      required: ["ok"],
    },
  })
  @HttpCode(200)
  @Post("logout")
  async logout(@Req() req: Request) {
    return this.authService.logout(req.user!.accessToken);
  }

  // ---------------------------------------------------------------------------
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth("bearerAuth")
  @ApiOkResponse({ schema: AuthUserResponseSchema })
  @Get("me")
  async me(@Req() req: Request) {
    return this.authService.getMe(req.user!.userId);
  }
}
