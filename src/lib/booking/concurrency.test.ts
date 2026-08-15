import { describe, it, expect } from "vitest";
import { isRangeBookable, rangesOverlap, type ExistingAppointment, type WorkingHoursRow } from "@/lib/booking/slots";

const TZ = "Asia/Tashkent";
const WEEKDAY_MON_FRI: WorkingHoursRow[] = [
  { weekday: 1, start_time: "09:00", end_time: "18:00" },
  { weekday: 2, start_time: "09:00", end_time: "18:00" },
  { weekday: 3, start_time: "09:00", end_time: "18:00" },
  { weekday: 4, start_time: "09:00", end_time: "18:00" },
  { weekday: 5, start_time: "09:00", end_time: "18:00" },
];

describe("Booking Concurrency & Double-Booking Protection Simulation", () => {
  it("handles 20 concurrent booking requests for the same slot where only 1 succeeds", async () => {
    const slotStart = new Date("2026-08-17T05:00:00Z"); // 10:00 local
    const slotEnd = new Date("2026-08-17T05:30:00Z"); // 10:30 local

    const existingAppointments: ExistingAppointment[] = [];

    // Simulated atomic booking function that enforces serial booking logic
    // matching the RPC `book_appointment` behavior:
    // Re-check `isRangeBookable` under atomic state lock.
    async function attemptBook(): Promise<{ success: boolean; reason?: string }> {
      // Simulate async db network delay
      await new Promise((r) => setTimeout(r, Math.random() * 10));

      const free = isRangeBookable({
        timezone: TZ,
        workingHours: WEEKDAY_MON_FRI,
        timeBlocks: [],
        existingAppointments,
        start: slotStart,
        end: slotEnd,
      });

      if (!free) {
        return { success: false, reason: "slot_taken" };
      }

      // Record appointment in atomic state
      existingAppointments.push({
        start_at: slotStart.toISOString(),
        end_at: slotEnd.toISOString(),
        status: "pending",
      });

      return { success: true };
    }

    // Launch 20 concurrent attempts using Promise.all
    const attempts = Array.from({ length: 20 }, () => attemptBook());
    const results = await Promise.all(attempts);

    const successCount = results.filter((r) => r.success).length;
    const failureCount = results.filter((r) => !r.success && r.reason === "slot_taken").length;

    expect(successCount).toBe(1);
    expect(failureCount).toBe(19);
    expect(existingAppointments).toHaveLength(1);
  });

  it("prevents overlapping interval bookings even with slight time variations", () => {
    const appt1Start = new Date("2026-08-17T05:00:00Z");
    const appt1End = new Date("2026-08-17T05:30:00Z");

    const appt2Start = new Date("2026-08-17T05:15:00Z"); // 15 mins into appt1
    const appt2End = new Date("2026-08-17T05:45:00Z");

    expect(rangesOverlap(appt1Start, appt1End, appt2Start, appt2End)).toBe(true);
  });
});
