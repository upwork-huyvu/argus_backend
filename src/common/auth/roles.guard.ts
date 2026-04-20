import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { ROLES_METADATA_KEY } from "./roles.decorator";
import type { UserRole } from "../permissions";

/**
 * Enforces `@Roles(...)` metadata set on a handler or controller.
 * Must run AFTER `JwtAuthGuard` so `req.user` is populated.
 *
 * Behavior:
 *  - No `@Roles` metadata → allow (guard is a no-op when the route doesn't opt in).
 *  - Metadata present and `req.user.role` matches one of the listed roles → allow.
 *  - Otherwise → 403.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[] | undefined>(
      ROLES_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const role = req.user?.role;
    if (!role || !required.includes(role)) {
      throw new ForbiddenException("Insufficient permissions.");
    }
    return true;
  }
}
