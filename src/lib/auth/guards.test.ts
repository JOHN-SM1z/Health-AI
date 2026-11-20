import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Role-gating regression for the dashboard remediation phase (audit
 * scenarios A/B/C/D/F). Pure unit test — getStaffContext() (the only piece
 * that needs a real session/DB) is stubbed; the real hasRole/hasAnyRole
 * weight logic from staff.ts runs unmodified, so this proves the actual
 * authorization decision, not a re-implementation of it.
 */

const staffContextMock = vi.hoisted(() => ({ value: null as unknown }));
const doctorLookup = vi.hoisted(() => ({ row: null as unknown, filters: [] as unknown[][] }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    const chain = {
      select: () => chain,
      eq: (...args: unknown[]) => {
        doctorLookup.filters.push(args);
        return chain;
      },
      maybeSingle: async () => ({ data: doctorLookup.row, error: null }),
    };
    return { from: () => chain };
  },
}));

vi.mock("@/lib/auth/staff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/staff")>();
  return {
    ...actual,
    getStaffContext: async () => staffContextMock.value,
  };
});

import { requireStaff, requireRoles, requirePlatformAdmin, requireLinkedDoctor } from "@/lib/auth/guards";
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
  doctorLookup.row = null;
  doctorLookup.filters = [];
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

describe("requireLinkedDoctor — a doctor acting through their own active doctor record", () => {
  it("rejects management roles even though they outrank doctors by weight (audit gap G3)", async () => {
    for (const role of ["owner", "admin", "manager", "receptionist"] as const) {
      staffContextMock.value = ctx({ roles: [role] });
      doctorLookup.row = { id: "doctor-1", name: "Dr Linked" };
      await expect(requireLinkedDoctor()).rejects.toMatchObject({ status: 403, code: "forbidden" });
    }
  });

  it("rejects a doctor without an active doctor record in the session's clinic", async () => {
    staffContextMock.value = ctx({ roles: ["doctor"] });
    await expect(requireLinkedDoctor()).rejects.toMatchObject({ status: 403, code: "doctor_not_linked" });
    expect(doctorLookup.filters).toEqual(
      expect.arrayContaining([
        ["profile_id", "profile-1"],
        ["clinic_id", "clinic-a"],
        ["active", true],
      ]),
    );
  });

  it("returns the session plus the linked doctor record", async () => {
    staffContextMock.value = ctx({ roles: ["doctor"] });
    doctorLookup.row = { id: "doctor-1", name: "Dr Linked" };
    await expect(requireLinkedDoctor()).resolves.toMatchObject({
      clinicId: "clinic-a",
      doctorId: "doctor-1",
      doctorName: "Dr Linked",
    });
  });
});

describe("lab staff on existing routes (Phase 3)", () => {
  it("are refused by every management, operational and doctor guard", async () => {
    staffContextMock.value = ctx({ roles: ["lab"] });
    for (const min of ["owner", "admin", "manager", "doctor", "receptionist"] as const) {
      await expect(requireStaff(min)).rejects.toMatchObject({ status: 403 });
    }
    // The operational desk routes (patients, appointments, conversations, dashboard).
    await expect(requireRoles("owner", "admin", "manager", "receptionist")).rejects.toMatchObject({ status: 403 });
    await expect(requireLinkedDoctor()).rejects.toMatchObject({ status: 403 });
  });

  it("pass a guard that names the lab role", async () => {
    staffContextMock.value = ctx({ roles: ["lab"] });
    await expect(requireRoles("lab")).resolves.toMatchObject({ clinicId: "clinic-a" });
  });
});
