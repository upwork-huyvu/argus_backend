export type UserRole = "treycor_operator" | "client_admin" | "viewer";

export type UserPermissions = {
  fullControl: boolean;
  canCustomize: boolean;
  canEdit: boolean;
  canToggle: boolean;
  canDuplicate: boolean;
};

export const ROLE_PERMISSIONS: Record<UserRole, UserPermissions> = {
  treycor_operator: {
    fullControl: true,
    canCustomize: true,
    canEdit: true,
    canToggle: true,
    canDuplicate: true,
  },
  client_admin: {
    fullControl: false,
    canCustomize: true,
    canEdit: true,
    canToggle: true,
    canDuplicate: true,
  },
  viewer: {
    fullControl: false,
    canCustomize: false,
    canEdit: false,
    canToggle: false,
    canDuplicate: false,
  },
};

