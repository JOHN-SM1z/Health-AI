import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createStaffClient: async () => null }));

import {
  LAB_CATALOG_READ_ROLES,
  LAB_CONFIG_ROLES,
  adminWorkspaceRedirect,
  hasAnyRole,
  hasRole,
  isLabOnlyStaff,
  roleAtLeast,
  type StaffContext,
  type StaffRole,
} from "@/lib/auth/staff";

const ctx = (roles: StaffRole[], over: Partial<StaffContext> = {}): StaffContext => ({
  profileId: "p", clinicId: "c", clinicName: "C", clinicTimezone: "Asia/Tashkent", roles, platformAdmin: false, ...over,
});

describe("laboratory staff role — authorization helpers", () => {
  it("no weight-based check admits lab_staff, whatever minimum is asked for (it is admitted only where it is named)", () => {
    for (const min of ["owner", "admin", "manager", "doctor", "receptionist", "lab_staff"] as StaffRole[]) {
      // Only the role itself satisfies its own minimum; nothing below it exists.
      expect(roleAtLeast(["lab_staff"], min), min).toBe(min === "lab_staff");
    }
    expect(hasRole(ctx(["lab_staff"]), "receptionist")).toBe(false);
    // …while every other role still outranks it where weights are used.
    for (const role of ["owner", "admin", "manager", "doctor", "receptionist"] as StaffRole[]) expect(roleAtLeast([role], "lab_staff"), role).toBe(true);
  });

  it("configuration is management's; reading the configuration is also the technician's; nobody else's", () => {
    expect([...LAB_CONFIG_ROLES].sort()).toEqual(["admin", "manager", "owner"]);
    expect([...LAB_CATALOG_READ_ROLES].sort()).toEqual(["admin", "lab_staff", "manager", "owner"]);
    for (const role of ["doctor", "receptionist"] as StaffRole[]) {
      expect(hasAnyRole([role], LAB_CONFIG_ROLES), role).toBe(false);
      expect(hasAnyRole([role], LAB_CATALOG_READ_ROLES), role).toBe(false);
    }
    expect(hasAnyRole(["lab_staff"], LAB_CONFIG_ROLES)).toBe(false);
  });

  it("a technician is sent to the laboratory workspace — never into a redirect loop with /admin and /doctor", () => {
    expect(adminWorkspaceRedirect(ctx(["lab_staff"]))).toBe("/lab");
    expect(isLabOnlyStaff(ctx(["lab_staff"]))).toBe(true);
    // A doctor who is also lab staff keeps the doctor workspace; management and reception stay in the admin workspace.
    expect(adminWorkspaceRedirect(ctx(["doctor", "lab_staff"]))).toBe("/doctor");
    expect(isLabOnlyStaff(ctx(["doctor", "lab_staff"]))).toBe(false);
    expect(adminWorkspaceRedirect(ctx(["receptionist", "lab_staff"]))).toBeNull();
    expect(adminWorkspaceRedirect(ctx(["owner"]))).toBeNull();
    expect(adminWorkspaceRedirect(ctx(["doctor"]))).toBe("/doctor");
    expect(adminWorkspaceRedirect(ctx([], { platformAdmin: true, clinicId: null }))).toBe("/platform");
    expect(isLabOnlyStaff(ctx([], { platformAdmin: true }))).toBe(false);
    expect(isLabOnlyStaff(null)).toBe(false);
  });
});
