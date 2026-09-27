import { describe, expect, it } from "vitest";
import { NO_CLINICAL_ACCESS, toClinicalAccess } from "./access";

const row = (overrides: Partial<Parameters<typeof toClinicalAccess>[0] & object> = {}) => ({
  clinic_id: "clinic",
  own_patient: false,
  active_referral_ids: [] as string[],
  history_doctor_ids: [] as string[],
  ...overrides,
});

describe("toClinicalAccess", () => {
  it("denies when the database returns no decision (unknown ids, another clinic)", () => {
    expect(toClinicalAccess(undefined)).toBe(NO_CLINICAL_ACCESS);
    expect(toClinicalAccess(null)).toEqual({
      relationship: "none",
      allowed: false,
      scope: { patientRecord: false, ownAppointments: false, sharedHistoryDoctorIds: [] },
      activeReferralIds: [],
    });
  });

  it("denies a same-clinic doctor with no relationship", () => {
    expect(toClinicalAccess(row())).toMatchObject({ relationship: "none", allowed: false });
  });

  it("A: own patient — record and own appointments", () => {
    expect(toClinicalAccess(row({ own_patient: true }))).toEqual({
      relationship: "own",
      allowed: true,
      scope: { patientRecord: true, ownAppointments: true, sharedHistoryDoctorIds: [] },
      activeReferralIds: [],
    });
  });

  it("B: pending referral — record only; accepted — plus the referring doctor's visits", () => {
    expect(toClinicalAccess(row({ active_referral_ids: ["r1"] }))).toEqual({
      relationship: "referred",
      allowed: true,
      scope: { patientRecord: true, ownAppointments: false, sharedHistoryDoctorIds: [] },
      activeReferralIds: ["r1"],
    });
    expect(toClinicalAccess(row({ active_referral_ids: ["r1"], history_doctor_ids: ["dr-a"] })).scope.sharedHistoryDoctorIds).toEqual([
      "dr-a",
    ]);
  });

  it("own wins when both apply, keeping the referral's shared history", () => {
    expect(toClinicalAccess(row({ own_patient: true, active_referral_ids: ["r1"], history_doctor_ids: ["dr-a"] }))).toMatchObject({
      relationship: "own",
      scope: { ownAppointments: true, sharedHistoryDoctorIds: ["dr-a"] },
    });
  });

  it("never lets callers mutate the shared denial", () => {
    expect(Object.isFrozen(NO_CLINICAL_ACCESS)).toBe(true);
    expect(Object.isFrozen(NO_CLINICAL_ACCESS.scope)).toBe(true);
  });
});
