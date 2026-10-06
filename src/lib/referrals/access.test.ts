import { describe, it, expect, vi, beforeEach } from "vitest";

const adminClientMock = vi.hoisted(() => ({
  from: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => adminClientMock,
}));

import { assertReferralAccess, requireLinkedDoctor } from "./access";
import type { StaffContext } from "@/lib/auth/staff";

function makeStaffCtx(overrides: Partial<StaffContext & { clinicId: string }> = {}): StaffContext & { clinicId: string } {
  return {
    profileId: "profile-doc-1",
    clinicId: "clinic-test-1",
    clinicName: "Test Clinic",
    clinicTimezone: "Asia/Tashkent",
    roles: ["doctor"],
    platformAdmin: false,
    ...overrides,
  };
}

describe("assertReferralAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws 404 if referral is not found", async () => {
    adminClientMock.from.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    });

    const ctx = makeStaffCtx();
    await expect(assertReferralAccess("non-existent-id", ctx)).rejects.toMatchObject({
      status: 404,
      code: "referral_not_found",
    });
  });

  it("denies operational management access to clinical handoff", async () => {
    await expect(assertReferralAccess("ref-1", makeStaffCtx({ roles: ["admin"] }))).rejects.toMatchObject({ status: 403 });
    expect(adminClientMock.from).not.toHaveBeenCalled();
  });

  it("identifies referring doctor correctly", async () => {
    const mockReferral = {
      id: "ref-1",
      clinic_id: "clinic-test-1",
      patient_id: "patient-1",
      referring_doctor_id: "doc-1",
      referred_to_doctor_id: "doc-2",
      status: "pending",
    };

    adminClientMock.from.mockImplementation((table: string) => {
      if (table === "referrals") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: mockReferral, error: null }),
        };
      }
      if (table === "doctors") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: { id: "doc-1" }, error: null }),
        };
      }
      return {};
    });

    const ctx = makeStaffCtx({ profileId: "profile-doc-1" });
    const result = await assertReferralAccess("ref-1", ctx);

    expect(result.callerRole).toBe("referring_doctor");
    expect(result.callerDoctorId).toBe("doc-1");
  });

  it("identifies receiving doctor correctly", async () => {
    const mockReferral = {
      id: "ref-1",
      clinic_id: "clinic-test-1",
      patient_id: "patient-1",
      referring_doctor_id: "doc-1",
      referred_to_doctor_id: "doc-2",
      status: "pending",
    };

    adminClientMock.from.mockImplementation((table: string) => {
      if (table === "referrals") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: mockReferral, error: null }),
        };
      }
      if (table === "doctors") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: { id: "doc-2" }, error: null }),
        };
      }
      return {};
    });

    const ctx = makeStaffCtx({ profileId: "profile-doc-2" });
    const result = await assertReferralAccess("ref-1", ctx);

    expect(result.callerRole).toBe("receiving_doctor");
    expect(result.callerDoctorId).toBe("doc-2");
  });

  it("rejects an unrelated doctor who is neither referring nor receiving", async () => {
    const mockReferral = {
      id: "ref-1",
      clinic_id: "clinic-test-1",
      patient_id: "patient-1",
      referring_doctor_id: "doc-1",
      referred_to_doctor_id: "doc-2",
      status: "pending",
    };

    adminClientMock.from.mockImplementation((table: string) => {
      if (table === "referrals") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: mockReferral, error: null }),
        };
      }
      if (table === "doctors") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: { id: "doc-unrelated-3" }, error: null }),
        };
      }
      return {};
    });

    const ctx = makeStaffCtx({ profileId: "profile-doc-3" });
    await expect(assertReferralAccess("ref-1", ctx)).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
    });
  });

  it("rejects doctor whose profile is not linked to doctors table", async () => {
    const mockReferral = {
      id: "ref-1",
      clinic_id: "clinic-test-1",
      patient_id: "patient-1",
      referring_doctor_id: "doc-1",
      referred_to_doctor_id: "doc-2",
      status: "pending",
    };

    adminClientMock.from.mockImplementation((table: string) => {
      if (table === "referrals") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: mockReferral, error: null }),
        };
      }
      if (table === "doctors") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
      }
      return {};
    });

    const ctx = makeStaffCtx();
    await expect(assertReferralAccess("ref-1", ctx)).rejects.toMatchObject({
      status: 403,
      code: "doctor_not_linked",
    });
  });
});

describe("requireLinkedDoctor", () => {
  it("returns doctor record if found and active", async () => {
    adminClientMock.from.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { id: "doc-1", clinic_id: "clinic-test-1" },
        error: null,
      }),
    });

    const ctx = makeStaffCtx();
    const doc = await requireLinkedDoctor(ctx);
    expect(doc.id).toBe("doc-1");
  });

  it("throws 403 if doctor record not found", async () => {
    adminClientMock.from.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    });

    const ctx = makeStaffCtx();
    await expect(requireLinkedDoctor(ctx)).rejects.toMatchObject({
      status: 403,
      code: "doctor_not_linked",
    });
  });
});
