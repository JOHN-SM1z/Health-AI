import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Server-side lab authorization: requireLabCapability() and
 * resolveLabResultAccess(). The session, the database and the doctor
 * relationship check are stubbed; the real role logic runs. Every case is an
 * attack or a boundary from the Phase 3 brief: unauthenticated callers,
 * platform admins, wrong roles, another clinic's patient, a doctor without a
 * relationship, and a failing access check (fail closed).
 */

const state = vi.hoisted(() => ({
  ctx: null as unknown,
  patient: null as unknown,
  doctor: null as unknown,
  patientError: null as unknown,
  relationship: "none" as "own" | "referred" | "none",
  filters: [] as Array<[string, string, unknown]>,
}));

vi.mock("@/lib/auth/staff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/staff")>();
  return { ...actual, getStaffContext: async () => state.ctx };
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          state.filters.push([table, column, value]);
          return chain;
        },
        maybeSingle: async () =>
          table === "patients"
            ? { data: state.patient, error: state.patientError }
            : { data: state.doctor, error: null },
      };
      return chain;
    },
  }),
}));

vi.mock("@/lib/clinical-access/access", () => ({
  canDoctorAccessPatientClinicalData: async () => ({ relationship: state.relationship }),
}));

import { requireLabCapability, resolveLabResultAccess, type ClinicStaff } from "@/lib/labs/guards";
import type { StaffContext } from "@/lib/auth/staff";

function staff(roles: StaffContext["roles"], overrides: Partial<StaffContext> = {}): ClinicStaff {
  return {
    profileId: "profile-1",
    clinicId: "clinic-a",
    clinicName: "Clinic A",
    clinicTimezone: "Asia/Tashkent",
    roles,
    platformAdmin: false,
    ...overrides,
  } as ClinicStaff;
}

beforeEach(() => {
  state.ctx = null;
  state.patient = { id: "patient-1" };
  state.doctor = null;
  state.patientError = null;
  state.relationship = "none";
  state.filters = [];
});

describe("requireLabCapability", () => {
  it("rejects anonymous callers and platform admins with 401", async () => {
    await expect(requireLabCapability("order.create")).rejects.toMatchObject({ status: 401 });
    state.ctx = staff([], { platformAdmin: true, clinicId: null });
    await expect(requireLabCapability("order.create")).rejects.toMatchObject({ status: 401 });
  });

  it("lets every clinic role order", async () => {
    for (const role of ["owner", "manager", "admin", "receptionist", "doctor", "lab"] as const) {
      state.ctx = staff([role]);
      await expect(requireLabCapability("order.create")).resolves.toMatchObject({ clinicId: "clinic-a" });
    }
  });

  it("refuses result values to reception and management, configuration to lab and doctors, finance to lab", async () => {
    state.ctx = staff(["receptionist"]);
    await expect(requireLabCapability("result.read")).rejects.toMatchObject({ status: 403 });
    await expect(requireLabCapability("result.verify")).rejects.toMatchObject({ status: 403 });
    state.ctx = staff(["owner"]);
    await expect(requireLabCapability("result.enter")).rejects.toMatchObject({ status: 403 });
    state.ctx = staff(["lab"]);
    await expect(requireLabCapability("catalog.configure")).rejects.toMatchObject({ status: 403 });
    await expect(requireLabCapability("finance.view")).rejects.toMatchObject({ status: 403 });
    state.ctx = staff(["doctor"]);
    await expect(requireLabCapability("catalog.configure")).rejects.toMatchObject({ status: 403 });
    await expect(requireLabCapability("sample.process")).rejects.toMatchObject({ status: 403 });
  });

  it("admits lab staff to lab work", async () => {
    state.ctx = staff(["lab"]);
    for (const capability of ["sample.collect", "sample.process", "result.enter", "result.verify", "result.read"] as const) {
      await expect(requireLabCapability(capability)).resolves.toBeTruthy();
    }
  });
});

describe("resolveLabResultAccess", () => {
  it("scopes the patient lookup to the session's clinic and denies another clinic's patient", async () => {
    state.patient = null; // not found in the session's clinic
    expect(await resolveLabResultAccess(staff(["lab"]), "patient-of-clinic-b")).toEqual({ kind: "none" });
    expect(state.filters).toContainEqual(["patients", "clinic_id", "clinic-a"]);
    expect(state.filters).toContainEqual(["patients", "id", "patient-of-clinic-b"]);
  });

  it("gives lab staff the lab view", async () => {
    expect(await resolveLabResultAccess(staff(["lab"]), "patient-1")).toEqual({ kind: "lab" });
  });

  it("gives a doctor results only for their own or referred patient (O3)", async () => {
    state.doctor = { id: "doctor-a" };
    state.relationship = "own";
    expect(await resolveLabResultAccess(staff(["doctor"]), "patient-1")).toEqual({ kind: "doctor", doctorId: "doctor-a" });
    state.relationship = "referred";
    expect(await resolveLabResultAccess(staff(["doctor"]), "patient-1")).toEqual({ kind: "doctor", doctorId: "doctor-a" });
    state.relationship = "none";
    expect(await resolveLabResultAccess(staff(["doctor"]), "patient-1")).toEqual({ kind: "none" });
  });

  it("denies a doctor account that is not linked to an active doctor of the clinic", async () => {
    state.doctor = null;
    state.relationship = "own";
    expect(await resolveLabResultAccess(staff(["doctor"]), "patient-1")).toEqual({ kind: "none" });
    expect(state.filters).toContainEqual(["doctors", "clinic_id", "clinic-a"]);
    expect(state.filters).toContainEqual(["doctors", "active", true]);
  });

  it("never gives owner, manager, admin or receptionist result values (O5)", async () => {
    for (const role of ["owner", "manager", "admin", "receptionist"] as const) {
      expect(await resolveLabResultAccess(staff([role]), "patient-1")).toEqual({ kind: "none" });
    }
  });

  it("fails closed when the check cannot run", async () => {
    state.patientError = { code: "57014" };
    await expect(resolveLabResultAccess(staff(["lab"]), "patient-1")).rejects.toMatchObject({ status: 503 });
  });
});
