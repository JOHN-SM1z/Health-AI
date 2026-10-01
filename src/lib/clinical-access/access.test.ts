import { describe, expect, it } from "vitest";
import { NO_CLINICAL_ACCESS, toClinicalAccess } from "./access";

type Row = NonNullable<Parameters<typeof toClinicalAccess>[0]>;

/**
 * A decision row as public.doctor_patient_access() returns it: full_history
 * is own_patient OR an open referral, unless a test overrides it.
 */
const row = (overrides: Partial<Row> = {}): Row => {
  const decision = { clinic_id: "clinic", own_patient: false, active_referral_ids: [] as string[], ...overrides };
  return { full_history: decision.own_patient || decision.active_referral_ids.length > 0, ...decision };
};

describe("toClinicalAccess", () => {
  it("denies when the database returns no decision (unknown ids, another clinic, inactive doctor)", () => {
    expect(toClinicalAccess(undefined)).toBe(NO_CLINICAL_ACCESS);
    expect(toClinicalAccess(null)).toBe(NO_CLINICAL_ACCESS);
    expect(NO_CLINICAL_ACCESS).toEqual({ relationship: "none", allowed: false, fullHistory: false, activeReferralIds: [] });
  });

  it("denies a same-clinic doctor with no relationship", () => {
    expect(toClinicalAccess(row())).toBe(NO_CLINICAL_ACCESS);
  });

  it("A: own patient — the patient's whole clinical history", () => {
    expect(toClinicalAccess(row({ own_patient: true }))).toEqual({
      relationship: "own",
      allowed: true,
      fullHistory: true,
      activeReferralIds: [],
    });
  });

  it("B: an open referral alone — the same whole history at once, whatever its status (no acceptance gate)", () => {
    expect(toClinicalAccess(row({ active_referral_ids: ["r1"] }))).toEqual({
      relationship: "referred",
      allowed: true,
      fullHistory: true,
      activeReferralIds: ["r1"],
    });
    // Several open referrals (e.g. one to the doctor, one to their department), in the database's order.
    expect(toClinicalAccess(row({ active_referral_ids: ["r1", "r2"] })).activeReferralIds).toEqual(["r1", "r2"]);
  });

  it("own wins when both apply, keeping the open referrals", () => {
    expect(toClinicalAccess(row({ own_patient: true, active_referral_ids: ["r1"] }))).toEqual({
      relationship: "own",
      allowed: true,
      fullHistory: true,
      activeReferralIds: ["r1"],
    });
  });

  it("fails closed on the database's verdict: without full_history, nothing — whatever else the row says", () => {
    expect(toClinicalAccess(row({ own_patient: true, full_history: false }))).toBe(NO_CLINICAL_ACCESS);
    expect(toClinicalAccess(row({ active_referral_ids: ["r1"], full_history: false }))).toBe(NO_CLINICAL_ACCESS);
  });

  it("never lets callers mutate the shared denial, nor the database row through an access it returned", () => {
    expect(Object.isFrozen(NO_CLINICAL_ACCESS)).toBe(true);
    expect(() => {
      (NO_CLINICAL_ACCESS as { allowed: boolean }).allowed = true;
    }).toThrow(TypeError);
    expect(() => {
      (NO_CLINICAL_ACCESS as { fullHistory: boolean }).fullHistory = true;
    }).toThrow(TypeError);
    expect(NO_CLINICAL_ACCESS).toMatchObject({ relationship: "none", allowed: false, fullHistory: false });

    const decision = row({ active_referral_ids: ["r1"] });
    toClinicalAccess(decision).activeReferralIds.push("forged");
    expect(decision.active_referral_ids).toEqual(["r1"]);
  });
});

// The per-appointment scope (and canSeeAppointment, its mirror of the old
// appointments policy) is gone: a doctor with a legitimate relationship sees
// every doctor's visits and records, one without it nothing — as in the
// database, where doctor_can_read_appointment() equals doctor_can_read_patient().
describe("fullHistory — all or nothing, replacing the per-appointment scope", () => {
  it("carries no per-appointment or per-doctor scope: an access is its relationship, the verdict and the open referrals", () => {
    for (const access of [NO_CLINICAL_ACCESS, toClinicalAccess(row({ own_patient: true })), toClinicalAccess(row({ active_referral_ids: ["r1"] }))]) {
      expect(Object.keys(access).sort()).toEqual(["activeReferralIds", "allowed", "fullHistory", "relationship"]);
    }
  });

  it("a referral opens exactly what a treating relationship opens: the whole history", () => {
    const own = toClinicalAccess(row({ own_patient: true }));
    const referred = toClinicalAccess(row({ active_referral_ids: ["r1"] }));
    expect({ allowed: referred.allowed, fullHistory: referred.fullHistory }).toEqual({ allowed: own.allowed, fullHistory: own.fullHistory });
    expect(referred.fullHistory).toBe(true);
  });

  it("mirrors full_history: allowed and fullHistory are the database's verdict for every combination", () => {
    for (const own_patient of [false, true]) {
      for (const active_referral_ids of [[], ["r1"]]) {
        const decision = row({ own_patient, active_referral_ids });
        const access = toClinicalAccess(decision);
        expect(access.fullHistory, JSON.stringify(decision)).toBe(decision.full_history);
        expect(access.allowed, JSON.stringify(decision)).toBe(decision.full_history);
        expect(access.relationship, JSON.stringify(decision)).toBe(own_patient ? "own" : active_referral_ids.length > 0 ? "referred" : "none");
      }
    }
  });
});
