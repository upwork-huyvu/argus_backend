import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { AdminService } from "./admin.service";
import { UpdateRoleDto } from "./dto/update-role.dto";
import { SetActiveDto } from "./dto/set-active.dto";
import { RegisterRequestDto } from "../auth/dto/register-request.dto";
import { JwtAuthGuard } from "../common/auth/jwt-auth.guard";
import { RolesGuard } from "../common/auth/roles.guard";
import { Roles } from "../common/auth/roles.decorator";

const AdminUserSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    email: { type: "string", nullable: true },
    fullName: { type: "string", nullable: true },
    phone: { type: "string", nullable: true },
    organization: { type: "string", nullable: true },
    avatarUrl: { type: "string", nullable: true },
    role: { type: "string", enum: ["GUEST", "OPERATOR", "ADMIN"] },
    isActive: { type: "boolean" },
    lastLoginAt: { type: "string", nullable: true },
    createdAt: { type: "string", nullable: true },
    updatedAt: { type: "string", nullable: true },
  },
  required: ["id", "role", "isActive"],
};

@Controller("admin/users")
@ApiTags("admin")
@ApiBearerAuth("bearerAuth")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("ADMIN")
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @ApiOkResponse({ schema: { type: "array", items: AdminUserSchema } })
  @Get()
  async list() {
    return this.admin.listUsers();
  }

  @ApiOkResponse({ schema: AdminUserSchema })
  @ApiResponse({ status: 409, description: "Email already registered." })
  @Post()
  async create(@Req() req: Request, @Body() body: RegisterRequestDto) {
    return this.admin.createUser({
      email: body.email,
      password: body.password,
      fullName: body.fullName,
      username: body.username,
      phone: body.phone,
      organization: body.organization,
      role: body.role,
      createdBy: req.user!.userId,
    });
  }

  @ApiOkResponse({ schema: AdminUserSchema })
  @Patch(":id/role")
  async updateRole(@Param("id") id: string, @Body() body: UpdateRoleDto) {
    return this.admin.updateRole(id, body.role);
  }

  @ApiOkResponse({ schema: AdminUserSchema })
  @Patch(":id/active")
  async setActive(@Param("id") id: string, @Body() body: SetActiveDto) {
    return this.admin.setActive(id, body.isActive);
  }
}
