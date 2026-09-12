import { describe, it, expect } from "vitest";
import { adminWorkspaceRedirect, hasRole, type StaffContext } from "@/lib/auth/staff";

/**
 * Security-phase regression: hasRole() used to return true unconditionally
 * for any platformAdmin:true context, regardless of the requested role or
 * of ctx.roles being empty. The two direct callers (doctor/layout.tsx,
 * admin/layout.tsx) never route through requireStaff/requireRoles (which
 * separately and unconditionally reject platformAdmin before ever reaching
 * a role check), so this was the one place a platform admin's lack of any
 * clinic staff role could be silently papered over. Platform admins hold no
 * clinic staff role at all — see the "platform admin has zero clinic
 * powers" tests in role-authorization.test.ts — hasRole must never say
 * otherwise, at any role level.
 */

function ctx(overrides: Partial<StaffContext> = {}): StaffContext {
  return {
    profileId: "profile-1",
    clinicId: "clinic-a",
    clinicName: "Clinic A",
    clinicTimezone: "Asia/Tashkent",
    roles: [],
    platformAdmin: false,
    ...overrides,
  };
}

describe("hasRole", () => {
  it("returns false for a platform admin with no clinic roles, at every level", () => {
    const platformOnly = ctx({ platformAdmin: true, clinicId: null, roles: [] });
    expect(hasRole(platformOnly, "receptionist")).toBe(false);
    expect(hasRole(platformOnly, "doctor")).toBe(false);
    expect(hasRole(platformOnly, "manager")).toBe(false);
    expect(hasRole(platformOnly, "admin")).toBe(false);
    expect(hasRole(platformOnly, "owner")).toBe(false);
  });

  it("still checks role weight normally when platformAdmin is also true alongside real clinic roles", () => {
    // A hybrid identity (platform admin who also has a clinic staff row)
    // must be judged on their actual clinic role, never waved through.
    const hybridReceptionist = ctx({ platformAdmin: true, roles: ["receptionist"] });
    expect(hasRole(hybridReceptionist, "admin")).toBe(false);
    expect(hasRole(hybridReceptionist, "receptionist")).toBe(true);
  });

  it("returns false for null and for an unauthenticated-shaped context", () => {
    expect(hasRole(null, "receptionist")).toBe(false);
  });

  it("still admits sufficiently privileged real staff (no regression on the normal path)", () => {
    expect(hasRole(ctx({ roles: ["owner"] }), "admin")).toBe(true);
    expect(hasRole(ctx({ roles: ["manager"] }), "admin")).toBe(true); // admin == manager weight
    expect(hasRole(ctx({ roles: ["receptionist"] }), "admin")).toBe(false);
    expect(hasRole(ctx({ roles: ["doctor"] }), "receptionist")).toBe(true); // doctor outweighs receptionist
  });
});

/**
 * Dashboard-completion phase finding: admin/layout.tsx had no role-based
 * redirect at all, unlike the symmetric guard already in doctor/layout.tsx
 * (`if (!hasRole(ctx, "doctor")) redirect("/admin")`). A platform admin or
 * a pure doctor navigating to /admin would see the sidebar render normally
 * but every underlying /api/admin/* call reject them (requireRoles/
 * requireStaff never admit platformAdmin, and never admit a role outside
 * owner/admin/manager/receptionist) — a broken workspace for the wrong
 * persona instead of a redirect to the one that actually works for them.
 */
describe("adminWorkspaceRedirect", () => {
  it("sends a platform admin to /platform, even if they also hold a clinic role", () => {
    expect(adminWorkspaceRedirect(ctx({ platformAdmin: true, clinicId: null, roles: [] }))).toBe("/platform");
    expect(adminWorkspaceRedirect(ctx({ platformAdmin: true, roles: ["owner"] }))).toBe("/platform");
  });

  it("sends a pure doctor (no management/reception role) to /doctor", () => {
    expect(adminWorkspaceRedirect(ctx({ roles: ["doctor"] }))).toBe("/doctor");
  });

  it("keeps every admin-workspace role on /admin (no redirect)", () => {
    for (const role of ["owner", "admin", "manager", "receptionist"] as const) {
      expect(adminWorkspaceRedirect(ctx({ roles: [role] }))).toBeNull();
    }
  });

  it("keeps a hybrid doctor+receptionist on /admin (they legitimately work the front desk too)", () => {
    expect(adminWorkspaceRedirect(ctx({ roles: ["doctor", "receptionist"] }))).toBeNull();
  });
});
