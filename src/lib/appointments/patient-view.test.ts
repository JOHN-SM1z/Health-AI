import { describe, expect, it } from "vitest";
import { formatClinicDateTime, isUpcoming, patientStatus } from "./patient-view";

describe("patient view of an appointment", () => {
  const now = new Date("2026-10-07T12:00:00Z");

  it("formats in the clinic's time zone, not the phone's", () => {
    // 10:15 UTC is 15:15 in Tashkent (UTC+5).
    expect(formatClinicDateTime("2026-10-20T10:15:00Z", "Asia/Tashkent")).toBe("20-oktabr, 15:15");
    expect(formatClinicDateTime("2026-12-31T20:00:00Z", "Asia/Tashkent")).toBe("1-yanvar, 01:00");
  });

  it("an active visit not yet over is upcoming; one at the clinic always is; finished or long-past ones are not", () => {
    expect(isUpcoming({ status: "confirmed", end_at: "2026-10-08T09:00:00Z" }, now)).toBe(true);
    expect(isUpcoming({ status: "pending", end_at: "2026-10-07T11:00:00Z" }, now)).toBe(true); // ended an hour ago
    expect(isUpcoming({ status: "pending", end_at: "2026-10-05T09:00:00Z" }, now)).toBe(false); // stale
    expect(isUpcoming({ status: "in_progress", end_at: "2026-10-07T08:00:00Z" }, now)).toBe(true); // running late
    expect(isUpcoming({ status: "completed", end_at: "2026-10-08T09:00:00Z" }, now)).toBe(false);
    expect(isUpcoming({ status: "cancelled", end_at: "2026-10-08T09:00:00Z" }, now)).toBe(false);
  });

  it("every status has a patient-facing label, and an unknown one degrades safely", () => {
    for (const s of ["pending", "confirmed", "checked_in", "in_progress", "completed", "cancelled", "no_show"]) {
      expect(patientStatus(s).label.length).toBeGreaterThan(0);
    }
    expect(patientStatus("in_progress")).toMatchObject({ label: "Qabulda", hint: "Shifokor sizni qabul qilmoqda." });
    expect(patientStatus("something_new")).toMatchObject({ label: "something_new", tone: "gray" });
  });
});
