import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { logger } from "@/lib/logger";
import { allowedActions, effectiveStatus, lapsedReferralError, referralError } from "@/lib/referrals/service";

describe("effectiveStatus", () => {
  const now = Date.parse("2026-09-27T12:00:00Z");

  it("reports an open referral past its expiry as expired", () => {
    expect(effectiveStatus("pending", "2026-09-27T11:59:59Z", now)).toBe("expired");
    expect(effectiveStatus("accepted", "2026-09-27T12:00:00Z", now)).toBe("expired");
    expect(effectiveStatus("pending", "2026-09-28T00:00:00Z", now)).toBe("pending");
    expect(effectiveStatus("in_progress", "2026-09-27T11:00:00Z", now)).toBe("expired");
    expect(effectiveStatus("in_progress", "2026-09-28T00:00:00Z", now)).toBe("in_progress");
  });

  it("never rewrites a closed referral", () => {
    for (const status of ["completed", "declined", "revoked", "expired"] as const) {
      expect(effectiveStatus(status, "2020-01-01T00:00:00Z", now)).toBe(status);
    }
  });
});

describe("allowedActions", () => {
  it("offers accept/decline, then — once their consultation started — complete, to the receiving doctor", () => {
    expect(allowedActions("receiver", "pending")).toEqual(["accept", "decline"]);
    // Accepted moves on by starting the consultation, not by an action.
    expect(allowedActions("receiver", "accepted")).toEqual([]);
    expect(allowedActions("receiver", "in_progress")).toEqual(["complete"]);
    expect(allowedActions("receiver", "completed")).toEqual([]);
  });

  it("offers revoke to the referring doctor only while the referral is open", () => {
    expect(allowedActions("referrer", "pending")).toEqual(["revoke"]);
    expect(allowedActions("referrer", "accepted")).toEqual(["revoke"]);
    expect(allowedActions("referrer", "in_progress")).toEqual(["revoke"]);
    for (const status of ["completed", "declined", "revoked", "expired"] as const) {
      expect(allowedActions("referrer", status)).toEqual([]);
    }
  });
});

describe("referralError", () => {
  it.each([
    [{ code: "23505", message: 'duplicate key value violates unique constraint "referrals_one_open_per_pair"' }, 409, "referral_already_open"],
    [{ code: "23503", message: 'violates foreign key constraint "referrals_referred_to_doctor_same_clinic_fkey"' }, 404, "doctor_not_found"],
    [{ code: "23503", message: 'violates foreign key constraint "referrals_originating_appointment_fkey"' }, 404, "consultation_not_found"],
    [{ code: "23503", message: 'violates foreign key constraint "referrals_follow_up_appointment_fkey"' }, 409, "follow_up_mismatch"],
    [{ code: "23514", message: 'violates check constraint "referrals_not_self_referral"' }, 400, "self_referral"],
    [{ code: "P0001", message: "referral: the originating consultation must be in progress or completed (it is pending)" }, 409, "consultation_not_attended"],
    [{ code: "P0001", message: "referral: the receiving doctor has no linked doctor account" }, 409, "receiving_doctor_unavailable"],
    [{ code: "P0001", message: "referral: invalid status transition pending -> completed" }, 409, "invalid_transition"],
    [{ code: "P0001", message: "referral: invalid status transition accepted -> completed" }, 409, "consultation_not_started"],
    [{ code: "P0001", message: "referral: a referral is in progress only once its follow-up consultation has started" }, 409, "consultation_not_started"],
    [{ code: "P0001", message: "referral: the referral expired at 2026-09-01 00:00:00+00" }, 409, "referral_expired"],
    [{ code: "P0001", message: "referral: only the receiving doctor can mark the referral accepted" }, 403, "forbidden"],
    [{ code: "P0001", message: "referral: a follow-up appointment is already booked" }, 409, "follow_up_exists"],
    [{ code: "23514", message: 'violates check constraint "referrals_reason_check"' }, 400, "validation"],
  ])("maps %j to %i %s", (error, status, code) => {
    expect(referralError(error)).toMatchObject({ status, code });
  });

  it("falls back to a 500 and logs only the error code, never the message", () => {
    const err = referralError({ code: "XX000", message: "row contained: sensitive clinical text" });
    expect(err).toMatchObject({ status: 500, code: "referral_write_failed" });
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith("referral write failed", { code: "XX000" });
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain("sensitive clinical text");
  });
});

describe("lapsedReferralError", () => {
  it("tells the receiving doctor why a referral no longer opens anything", () => {
    for (const [status, code] of [
      ["revoked", "referral_revoked"],
      ["expired", "referral_expired"],
      ["declined", "referral_declined"],
      ["completed", "referral_completed"],
    ] as const) {
      expect(lapsedReferralError(status)).toMatchObject({ status: 410, code });
    }
  });

  it("is a plain 404 for anything else", () => {
    for (const status of ["pending", "accepted"] as const) {
      expect(lapsedReferralError(status)).toMatchObject({ status: 404, code: "referral_not_found" });
    }
  });
});
