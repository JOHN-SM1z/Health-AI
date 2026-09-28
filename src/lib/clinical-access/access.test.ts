import { describe, expect, it } from "vitest";
import { NO_CLINICAL_ACCESS, canSeeAppointment, toClinicalAccess } from "./access";

type Row = NonNullable<Parameters<typeof toClinicalAccess>[0]>;

const row = (overrides: Partial<Row> = {}): Row => ({
  clinic_id: "clinic",
  own_patient: false,
  active_referral_ids: [],
  history_doctor_ids: [],
  referral_appointment_ids: [],
  ...overrides,
});

describe("toClinicalAccess", () => {
  it("denies when the database returns no decision (unknown ids, another clinic, inactive doctor)", () => {
    expect(toClinicalAccess(undefined)).toBe(NO_CLINICAL_ACCESS);
    expect(toClinicalAccess(null)).toEqual({
      relationship: "none",
      allowed: false,
      scope: { patientRecord: false, ownAppointments: false, sharedHistoryDoctorIds: [], referralAppointmentIds: [] },
      activeReferralIds: [],
    });
  });

  it("denies a same-clinic doctor with no relationship", () => {
    expect(toClinicalAccess(row())).toMatchObject({ relationship: "none", allowed: false });
  });

  it("A: maps own relationship without inventing any additional scope", () => {
    expect(toClinicalAccess(row({ own_patient: true }))).toEqual({
      relationship: "own",
      allowed: true,
      scope: { patientRecord: true, ownAppointments: true, sharedHistoryDoctorIds: [], referralAppointmentIds: [] },
      activeReferralIds: [],
    });
  });

  it("B: maps a referral decision; the database supplies longitudinal authors immediately", () => {
    expect(toClinicalAccess(row({ active_referral_ids: ["r1"], referral_appointment_ids: ["consult"] }))).toEqual({
      relationship: "referred",
      allowed: true,
      scope: { patientRecord: true, ownAppointments: false, sharedHistoryDoctorIds: [], referralAppointmentIds: ["consult"] },
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

describe("canSeeAppointment (mirrors the appointments RLS policy)", () => {
  const me = "dr-b";

  it("sees nothing without access", () => {
    expect(canSeeAppointment(NO_CLINICAL_ACCESS, me, { id: "x", doctorId: me })).toBe(false);
  });

  it("sees own appointments only when the patient is the doctor's own", () => {
    const own = toClinicalAccess(row({ own_patient: true }));
    expect(canSeeAppointment(own, me, { id: "mine", doctorId: me })).toBe(true);
    expect(canSeeAppointment(own, me, { id: "theirs", doctorId: "dr-e" })).toBe(false);
  });

  it("sees the referring doctor's visits and referral-linked appointments, nothing else", () => {
    const referred = toClinicalAccess(
      row({ active_referral_ids: ["r1"], history_doctor_ids: ["dr-a"], referral_appointment_ids: ["consult"] }),
    );
    expect(canSeeAppointment(referred, me, { id: "any-with-a", doctorId: "dr-a" })).toBe(true);
    expect(canSeeAppointment(referred, me, { id: "consult", doctorId: "dr-z" })).toBe(true);
    expect(canSeeAppointment(referred, me, { id: "with-e", doctorId: "dr-e" })).toBe(false);
  });
});
