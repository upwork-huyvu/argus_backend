import { SetMetadata } from "@nestjs/common";
import type { UserRole } from "../permissions";

export const ROLES_METADATA_KEY = "argus:roles";

/**
 * Mark a route as requiring the caller to hold at least one of the listed roles.
 * Always pair with `@UseGuards(JwtAuthGuard, RolesGuard)`.
 *
 * @example
 *   @Roles("ADMIN")
 *   @Roles("OPERATOR", "ADMIN")
 */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_METADATA_KEY, roles);
