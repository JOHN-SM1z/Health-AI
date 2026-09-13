import { describe, it, expect } from "vitest";
import { doctorLoadToday } from "@/lib/admin/today-aggregate";
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
