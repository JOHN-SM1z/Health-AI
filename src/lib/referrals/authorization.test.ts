import { beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => db }));
import { canDoctorAccessPatientClinicalData, requirePatientClinicalAccess } from "./access";
const ctx = { profileId: "actor", clinicId: "clinic", clinicName: "Test", clinicTimezone: "UTC", roles: ["doctor" as const], platformAdmin: false };
const allowed = { own_patient: true, active_referral_ids: [], history_doctor_ids: [], referral_appointment_ids: [], clinic_id: "clinic" };
beforeEach(() => {
  vi.clearAllMocks();
  db.from.mockReturnValue({ select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({ data: { id: "doctor" }, error: null }) });
});
describe("authoritative clinical access compatibility", () => {
  it("resolves an active same-clinic doctor then uses the canonical DB predicate", async () => {
    db.rpc.mockResolvedValue({ data: [allowed], error: null });
    expect((await canDoctorAccessPatientClinicalData("actor", "patient", "clinic", ["doctor"])).level).toBe("own_patient");
    expect(db.rpc).toHaveBeenCalledWith("doctor_patient_access", { p_doctor_id: "doctor", p_patient_id: "patient" });
  });
  it.each([[], null])("denies when the DB does not affirm access", async (value) => {
    db.rpc.mockResolvedValue({ data: value, error: null });
    expect((await canDoctorAccessPatientClinicalData("actor", "patient", "clinic", ["doctor"])).level).toBe("none");
  });
  it("preserves the dependency failure instead of granting or silently inventing access", async () => {
    db.rpc.mockResolvedValue({ data: null, error: { code: "unavailable" } });
    await expect(requirePatientClinicalAccess(ctx, "patient")).rejects.toMatchObject({ status: 503, code: "access_check_failed" });
  });
  it.each(["owner", "admin", "manager", "receptionist"] as const)("does not give %s a clinical bypass", async (role) => {
    expect((await canDoctorAccessPatientClinicalData("actor", "patient", "clinic", [role])).level).toBe("none"); expect(db.rpc).not.toHaveBeenCalled();
  });
  it("denies before the access RPC when the doctor linkage is gone", async () => {
    db.from.mockReturnValue({ select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) });
    await expect(requirePatientClinicalAccess(ctx, "patient")).rejects.toMatchObject({ status: 403 }); expect(db.rpc).not.toHaveBeenCalled();
  });
  it("preserves a referral-only relationship from the database", async () => {
    db.rpc.mockResolvedValue({ data: [{ ...allowed, own_patient: false, active_referral_ids: ["referral"] }], error: null });
    expect(await canDoctorAccessPatientClinicalData("actor", "patient", "clinic", ["doctor"])).toMatchObject({ level: "referral", referralId: "referral" });
  });
});
