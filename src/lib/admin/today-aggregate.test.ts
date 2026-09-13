import { describe, it, expect } from "vitest";
import { doctorLoadToday, doctorWorkloadToday, countDelayedToday } from "@/lib/admin/today-aggregate";
import type { TodayAppointmentRow } from "@/lib/admin/dashboard-types";

function row(overrides: Partial<TodayAppointmentRow>): TodayAppointmentRow {
  return {
    id: "a1",
    start_at: "2026-09-13T09:00:00Z",
    status: "completed",
    source: "walk_in",
    patients: null,
    doctors: { name: "Dr. Aziza" },
    services: { name: "Konsultatsiya", price: 100000 },
    payments: { status: "paid" },
    ...overrides,
  };
}

describe("doctorLoadToday", () => {
  it("groups counts and completed counts per doctor", () => {
    const rows = [
      row({ id: "1", doctors: { name: "Dr. A" }, status: "completed" }),
      row({ id: "2", doctors: { name: "Dr. A" }, status: "pending" }),
      row({ id: "3", doctors: { name: "Dr. B" }, status: "completed" }),
    ];
    const result = doctorLoadToday(rows, false);
    expect(result).toEqual([
      { name: "Dr. A", count: 2, completed: 1, revenue: 0 },
      { name: "Dr. B", count: 1, completed: 1, revenue: 0 },
    ]);
  });

  it("sorts busiest doctor first", () => {
    const rows = [
      row({ id: "1", doctors: { name: "Dr. Quiet" } }),
      row({ id: "2", doctors: { name: "Dr. Busy" } }),
      row({ id: "3", doctors: { name: "Dr. Busy" } }),
    ];
    const result = doctorLoadToday(rows, false);
    expect(result[0].name).toBe("Dr. Busy");
  });

  it("recognizes revenue only for completed + paid, matching the server rule", () => {
    const rows = [
      row({ id: "1", status: "completed", payments: { status: "paid" }, services: { name: "S", price: 50000 } }),
      row({ id: "2", status: "completed", payments: { status: "unpaid" }, services: { name: "S", price: 50000 } }),
      row({ id: "3", status: "pending", payments: { status: "paid" }, services: { name: "S", price: 50000 } }),
    ];
    const result = doctorLoadToday(rows, true);
    expect(result[0].revenue).toBe(50000);
  });

  it("omits revenue entirely when includeRevenue is false, even for completed+paid rows", () => {
    const rows = [row({ status: "completed", payments: { status: "paid" } })];
    const result = doctorLoadToday(rows, false);
    expect(result[0].revenue).toBe(0);
  });

  it("falls back to a placeholder name when the doctor relation is missing", () => {
    const rows = [row({ doctors: null })];
    const result = doctorLoadToday(rows, false);
    expect(result[0].name).toBe("Noma’lum shifokor");
  });

  it("returns an empty list for no rows", () => {
    expect(doctorLoadToday([], true)).toEqual([]);
  });
});

const NOW = new Date("2026-09-13T10:00:00Z");

describe("doctorWorkloadToday", () => {
  it("marks a doctor busy only when they have an in_progress row right now", () => {
    const rows = [
      row({ id: "1", doctors: { name: "Dr. A" }, status: "in_progress" }),
      row({ id: "2", doctors: { name: "Dr. B" }, status: "confirmed", start_at: "2026-09-13T11:00:00Z" }),
    ];
    const result = doctorWorkloadToday(rows, NOW);
    expect(result.find((d) => d.name === "Dr. A")?.busy).toBe(true);
    expect(result.find((d) => d.name === "Dr. B")?.busy).toBe(false);
  });

  it("picks the soonest still-upcoming appointment as nextPatient, ignoring past and terminal rows", () => {
    const rows = [
      row({ id: "1", doctors: { name: "Dr. A" }, status: "confirmed", start_at: "2026-09-13T09:00:00Z" }), // already past NOW
      row({ id: "2", doctors: { name: "Dr. A" }, status: "confirmed", start_at: "2026-09-13T14:00:00Z", patients: { full_name: "Later", phone: null } }),
      row({ id: "3", doctors: { name: "Dr. A" }, status: "pending", start_at: "2026-09-13T12:00:00Z", patients: { full_name: "Soonest", phone: null } }),
      row({ id: "4", doctors: { name: "Dr. A" }, status: "cancelled", start_at: "2026-09-13T11:00:00Z", patients: { full_name: "Cancelled", phone: null } }),
    ];
    const result = doctorWorkloadToday(rows, NOW);
    expect(result[0].nextPatient).toEqual({ name: "Soonest", time: "2026-09-13T12:00:00Z" });
  });

  it("is null when nothing is still upcoming", () => {
    const rows = [row({ doctors: { name: "Dr. A" }, status: "completed", start_at: "2026-09-13T08:00:00Z" })];
    expect(doctorWorkloadToday(rows, NOW)[0].nextPatient).toBeNull();
  });

  it("counts today's load and completions per doctor", () => {
    const rows = [
      row({ id: "1", doctors: { name: "Dr. A" }, status: "completed" }),
      row({ id: "2", doctors: { name: "Dr. A" }, status: "pending", start_at: "2026-09-13T12:00:00Z" }),
    ];
    const result = doctorWorkloadToday(rows, NOW);
    expect(result[0]).toMatchObject({ name: "Dr. A", count: 2, completed: 1 });
  });
});

describe("countDelayedToday", () => {
  it("counts appointments whose scheduled time has passed without starting", () => {
    const rows = [
      row({ id: "1", status: "confirmed", start_at: "2026-09-13T09:00:00Z" }), // past, not started -> delayed
      row({ id: "2", status: "checked_in", start_at: "2026-09-13T09:30:00Z" }), // past, not started -> delayed
      row({ id: "3", status: "pending", start_at: "2026-09-13T11:00:00Z" }), // future -> not delayed
      row({ id: "4", status: "in_progress", start_at: "2026-09-13T09:00:00Z" }), // already started -> not delayed
      row({ id: "5", status: "completed", start_at: "2026-09-13T08:00:00Z" }), // done -> not delayed
    ];
    expect(countDelayedToday(rows, NOW)).toBe(2);
  });

  it("is 0 for no rows", () => {
    expect(countDelayedToday([], NOW)).toBe(0);
  });
});
