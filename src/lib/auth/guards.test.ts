import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Role-gating regression for the dashboard remediation phase (audit
 * scenarios A/B/C/D/F). Pure unit test — getStaffContext() (the only piece
 * that needs a real session/DB) is stubbed; the real hasRole/hasAnyRole
 * weight logic from staff.ts runs unmodified, so this proves the actual
 * authorization decision, not a re-implementation of it.
 */

const staffContextMock = vi.hoisted(() => ({ value: null as unknown }));

vi.mock("@/lib/auth/staff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/staff")>();
  return {
    ...actual,
    getStaffContext: async () => staffContextMock.value,
  };
});

import { requireStaff, requireRoles, requirePlatformAdmin } from "@/lib/auth/guards";
import type { StaffContext } from "@/lib/auth/staff";

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

beforeEach(() => {
  staffContextMock.value = null;
});

describe("requireStaff / requireRoles — role gating", () => {
  it("rejects an unauthenticated caller with 401 (scenario A)", async () => {
    staffContextMock.value = null;
    await expect(requireStaff("admin")).rejects.toMatchObject({ status: 401 });
    await expect(requireRoles("owner", "admin", "manager")).rejects.toMatchObject({ status: 401 });
  });

  it("admits owner to a management-gated route (scenario B)", async () => {
    staffContextMock.value = ctx({ roles: ["owner"] });
    await expect(requireStaff("admin")).resolves.toMatchObject({ clinicId: "clinic-a" });
  });

  it("admits manager to a management-gated route — same weight as admin (scenario C)", async () => {
    staffContextMock.value = ctx({ roles: ["manager"] });
    await expect(requireStaff("admin")).resolves.toMatchObject({ clinicId: "clinic-a" });
  });

  it("denies receptionist a management-gated route, but admits them to an operational one (scenario D)", async () => {
    staffContextMock.value = ctx({ roles: ["receptionist"] });
    await expect(requireStaff("admin")).rejects.toMatchObject({ status: 403 });
    await expect(
      requireRoles("owner", "admin", "manager", "receptionist"),
    ).resolves.toMatchObject({ clinicId: "clinic-a" });
  });

  it("denies a doctor access to owner/manager analytics (scenario F)", async () => {
    staffContextMock.value = ctx({ roles: ["doctor"] });
    await expect(requireRoles("owner", "admin", "manager")).rejects.toMatchObject({ status: 403 });
  });

  it("rejects a platform-admin-only session from clinic-scoped routes (no clinicId)", async () => {
    staffContextMock.value = ctx({ clinicId: null as unknown as string, platformAdmin: true, roles: [] });
    await expect(requireStaff("admin")).rejects.toMatchObject({ status: 401 });
  });
});

describe("requirePlatformAdmin — separate mechanism from clinic roles", () => {
  it("rejects clinic staff, even an owner", async () => {
    staffContextMock.value = ctx({ roles: ["owner"] });
    await expect(requirePlatformAdmin()).rejects.toMatchObject({ status: 403 });
  });

  it("admits a platform admin", async () => {
    staffContextMock.value = ctx({ clinicId: null as unknown as string, platformAdmin: true, roles: [] });
    await expect(requirePlatformAdmin()).resolves.toMatchObject({ platformAdmin: true });
  });
});
