import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const mockUpdate = vi.fn();

const supabaseMock = {
  from: vi.fn((table: string) => {
    if (table === "notification_jobs") {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(async () => ({ data: null })),
          })),
        })),
        insert: vi.fn((data: unknown) => ({
          select: vi.fn(() => ({
            single: vi.fn(async () => ({ data: { id: "job-123", ...(data as object) } })),
          })),
        })),
        update: vi.fn((data: unknown) => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              in: vi.fn(() => ({
                in: vi.fn(async () => {
                  mockUpdate(data);
                  return { error: null };
                }),
              })),
            })),
          })),
        })),
      };
    }
    return {};
  }),
};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => supabaseMock,
}));

import {
  enqueueCancellationNotification,
  enqueueRescheduleNotification,
  cancelPendingAppointmentReminders,
} from "@/lib/notifications/jobs";

describe("Notification Lifecycle & Reminders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("cancelPendingAppointmentReminders cancels pending/in_progress reminder jobs", async () => {
    await cancelPendingAppointmentReminders({
      clinicId: "clinic-1",
      appointmentId: "appt-1",
    });

    expect(supabaseMock.from).toHaveBeenCalledWith("notification_jobs");
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "cancelled",
        error: "appointment cancelled or rescheduled",
      }),
    );
  });

  it("enqueueCancellationNotification cancels old reminders before enqueueing cancellation", async () => {
    await enqueueCancellationNotification({
      clinicId: "clinic-1",
      appointmentId: "appt-1",
      patientTelegramUserId: 12345,
    });

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "cancelled",
      }),
    );
  });

  it("enqueueRescheduleNotification cancels old reminders and enqueues new reminders for future slot", async () => {
    const futureDate = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48h in future

    await enqueueRescheduleNotification({
      clinicId: "clinic-1",
      appointmentId: "appt-1",
      patientTelegramUserId: 12345,
      newStartAt: futureDate,
    });

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "cancelled",
      }),
    );
    expect(supabaseMock.from).toHaveBeenCalledWith("notification_jobs");
  });
});
