import { describe, it, expect } from "vitest";
import { getPermissions, hasPermission, type Permission } from "@/lib/auth/permissions";
import type { StaffRole } from "@/lib/auth/staff";

const ALL_ROLES: StaffRole[] = ["owner", "admin", "manager", "receptionist", "doctor"];

describe("getPermissions", () => {
  it("gives owner and admin the identical, full permission set", () => {
    const owner = getPermissions(["owner"]);
    const admin = getPermissions(["admin"]);
    expect([...owner].sort()).toEqual([...admin].sort());
    expect(owner.has("finance:view")).toBe(true);
    expect(owner.has("payments:manage")).toBe(true);
    expect(owner.has("catalog:manage")).toBe(true);
    expect(owner.has("taxonomy:manage")).toBe(true);
    expect(owner.has("content:manage")).toBe(true);
  });

  it("gives manager the operational management surface but never finance or admin-only config", () => {
    const manager = getPermissions(["manager"]);
    expect(manager.has("catalog:manage")).toBe(true);
    expect(manager.has("analytics:view")).toBe(true);
    expect(manager.has("settings:manage")).toBe(true);
    expect(manager.has("finance:view")).toBe(false);
    expect(manager.has("payments:manage")).toBe(false);
    // Specialty taxonomy and the bot FAQ knowledge base are owner/admin-only
    // configuration, not day-to-day operations (backend access is unchanged,
    // this only governs the manager dashboard's nav).
    expect(manager.has("taxonomy:manage")).toBe(false);
    expect(manager.has("content:manage")).toBe(false);
  });

  it("gives receptionist only base operations, no management or finance", () => {
    const receptionist = getPermissions(["receptionist"]);
    expect(receptionist.has("appointments:manage")).toBe(true);
    expect(receptionist.has("calendar:view")).toBe(true);
    expect(receptionist.has("conversations:manage")).toBe(true);
    expect(receptionist.has("patients:manage")).toBe(true);
    expect(receptionist.has("catalog:manage")).toBe(false);
    expect(receptionist.has("content:manage")).toBe(false);
    expect(receptionist.has("analytics:view")).toBe(false);
    expect(receptionist.has("settings:manage")).toBe(false);
    expect(receptionist.has("finance:view")).toBe(false);
    expect(receptionist.has("payments:manage")).toBe(false);
  });

  it("gives a pure doctor only the doctor workspace permission", () => {
    const doctor = getPermissions(["doctor"]);
    expect([...doctor]).toEqual(["doctor:workspace"]);
  });

  it("returns an empty set for no roles", () => {
    expect(getPermissions([]).size).toBe(0);
  });

  it("unions permissions for a hybrid identity (doctor + receptionist)", () => {
    const hybrid = getPermissions(["doctor", "receptionist"]);
    expect(hybrid.has("doctor:workspace")).toBe(true);
    expect(hybrid.has("appointments:manage")).toBe(true);
    expect(hybrid.has("finance:view")).toBe(false);
  });

  it("every real role maps to at least one permission", () => {
    for (const role of ALL_ROLES) {
      expect(getPermissions([role]).size).toBeGreaterThan(0);
    }
  });
});

describe("hasPermission", () => {
  it("matches getPermissions().has(...) for a spot check per role", () => {
    const cases: Array<[StaffRole, Permission, boolean]> = [
      ["owner", "finance:view", true],
      ["admin", "payments:manage", true],
      ["manager", "finance:view", false],
      ["receptionist", "catalog:manage", false],
      ["doctor", "doctor:workspace", true],
      ["doctor", "appointments:manage", false],
    ];
    for (const [role, permission, expected] of cases) {
      expect(hasPermission([role], permission)).toBe(expected);
    }
  });
});
