import {
  ROLE_PERMISSIONS,
  LEGACY_ROLE_MAP,
  normalizeRole,
  USER_ROLES,
} from "./permissions";

describe("normalizeRole", () => {
  it("accepts canonical role values case-insensitively", () => {
    expect(normalizeRole("GUEST")).toBe("GUEST");
    expect(normalizeRole("guest")).toBe("GUEST");
    expect(normalizeRole("Operator")).toBe("OPERATOR");
    expect(normalizeRole("ADMIN")).toBe("ADMIN");
  });

  it("translates legacy role strings", () => {
    expect(normalizeRole("client_admin")).toBe("ADMIN");
    expect(normalizeRole("treycor_operator")).toBe("OPERATOR");
    expect(normalizeRole("viewer")).toBe("GUEST");
  });

  it("falls back to GUEST for empty / unknown input", () => {
    expect(normalizeRole(null)).toBe("GUEST");
    expect(normalizeRole(undefined)).toBe("GUEST");
    expect(normalizeRole("")).toBe("GUEST");
    expect(normalizeRole("SUPERUSER")).toBe("GUEST");
  });
});

describe("LEGACY_ROLE_MAP", () => {
  it("covers every legacy value used in production", () => {
    expect(Object.keys(LEGACY_ROLE_MAP).sort()).toEqual([
      "client_admin",
      "treycor_operator",
      "viewer",
    ]);
  });
});

describe("ROLE_PERMISSIONS", () => {
  it("GUEST cannot control drones or manage users", () => {
    expect(ROLE_PERMISSIONS.GUEST).toEqual({
      canControlDrone: false,
      canManageUsers: false,
      canEditMissions: false,
      canViewDashboard: true,
    });
  });

  it("OPERATOR controls drones and edits missions but cannot manage users", () => {
    expect(ROLE_PERMISSIONS.OPERATOR.canControlDrone).toBe(true);
    expect(ROLE_PERMISSIONS.OPERATOR.canEditMissions).toBe(true);
    expect(ROLE_PERMISSIONS.OPERATOR.canManageUsers).toBe(false);
  });

  it("ADMIN has every permission", () => {
    expect(Object.values(ROLE_PERMISSIONS.ADMIN).every(Boolean)).toBe(true);
  });

  it("defines permissions for every role", () => {
    for (const role of USER_ROLES) {
      expect(ROLE_PERMISSIONS[role]).toBeDefined();
    }
  });
});
