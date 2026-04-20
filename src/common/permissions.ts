// -----------------------------------------------------------------------------
// Role & permission model.
// Aligns with the `user_role` Postgres enum and the RN auth context.
// -----------------------------------------------------------------------------

export type UserRole = "GUEST" | "OPERATOR" | "ADMIN";

export const USER_ROLES: UserRole[] = ["GUEST", "OPERATOR", "ADMIN"];

export type UserPermissions = {
  /** OPERATOR + ADMIN — may issue commands to the drone SDK. */
  canControlDrone: boolean;
  /** ADMIN — may list users and change roles / active status. */
  canManageUsers: boolean;
  /** OPERATOR + ADMIN — may edit mission definitions. */
  canEditMissions: boolean;
  /** Everyone — dashboards / telemetry are read-only for GUESTs. */
  canViewDashboard: boolean;
};

export const ROLE_PERMISSIONS: Record<UserRole, UserPermissions> = {
  GUEST: {
    canControlDrone: false,
    canManageUsers: false,
    canEditMissions: false,
    canViewDashboard: true,
  },
  OPERATOR: {
    canControlDrone: true,
    canManageUsers: false,
    canEditMissions: true,
    canViewDashboard: true,
  },
  ADMIN: {
    canControlDrone: true,
    canManageUsers: true,
    canEditMissions: true,
    canViewDashboard: true,
  },
};

/**
 * Legacy role mapping — used only when reading rows from DBs that haven't yet
 * been migrated. New writes always use the canonical enum values above.
 */
export const LEGACY_ROLE_MAP: Record<string, UserRole> = {
  client_admin: "ADMIN",
  treycor_operator: "OPERATOR",
  viewer: "GUEST",
};

export function normalizeRole(input: string | null | undefined): UserRole {
  if (!input) return "GUEST";
  const upper = input.toUpperCase();
  if (upper === "GUEST" || upper === "OPERATOR" || upper === "ADMIN") {
    return upper as UserRole;
  }
  return LEGACY_ROLE_MAP[input] ?? "GUEST";
}
