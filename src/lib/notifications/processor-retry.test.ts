import { describe, it, expect, vi, beforeEach } from "vitest";

/** Chainable supabase mock: rpc() for the claim, from() per table. */
const supabaseMock = {
  rpc: vi.fn(),
  from: vi.fn(),
  appointmentLookupThrows: false,
  notificationJobUpdateThrows: false,
};

const APPOINTMENT_CTX = {
  start_at: "2026-08-20T05:00:00Z",
  status: "confirmed",
  doctors: { name: "Karimov Alisher" },
  services: { name: "Terapevt qabuli" },
  payments: { amount: 150000, currency: "UZS" },
};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => supabaseMock,
}));

vi.mock("@/lib/telegram/bot", () => ({
  sendTelegramMessage: vi.fn(async () => 1),
  telegramConfigured: vi.fn(() => true),
}));

import { processDueNotificationJobs } from "@/lib/notifications/processor";

/** Collects every notification_jobs update payload across all from() calls. */
function notificationJobUpdates(): unknown[] {
  const updates: unknown[] = [];
  for (const result of supabaseMock.from.mock.results) {
    const value = result.value as { update?: ReturnType<typeof vi.fn> };
    if (value?.update) updates.push(...value.update.mock.calls.map((c) => c[0]));
  }
  return updates;
}

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    clinic_id: "clinic-1",
    appointment_id: "appt-1",
    conversation_id: null,
    patient_telegram_user_id: 777000,
    type: "booking_confirmation",
    attempts: 0,
    max_attempts: 3,
    scheduled_for: new Date(Date.now() - 1000).toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  supabaseMock.appointmentLookupThrows = false;
  supabaseMock.notificationJobUpdateThrows = false;

  supabaseMock.rpc.mockImplementation(async () => ({ data: [], error: null }));

  supabaseMock.from.mockImplementation((table: string) => {
    if (table === "appointments") {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(async () => {
              if (supabaseMock.appointmentLookupThrows) throw new Error("db connection reset");
              return { data: APPOINTMENT_CTX, error: null };
            }),
          })),
        })),
      };
    }
    if (table === "clinics") {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(async () => ({ data: { timezone: "Asia/Tashkent" }, error: null })),
          })),
        })),
      };
    }
    if (table === "notification_jobs") {
      return {
        update: vi.fn((data: unknown) => ({
          eq: vi.fn(async () => {
            if (supabaseMock.notificationJobUpdateThrows) throw new Error("db write failed");
            return { error: null, data };
          }),
        })),
      };
    }
    return {};
  });
});

describe("notification processor — release claimed jobs on processing failure", () => {
  it("resets an errored job to pending so the next run retries it", async () => {
    supabaseMock.appointmentLookupThrows = true;
    supabaseMock.rpc.mockImplementation(async () => ({ data: [makeJob()], error: null }));

    const result = await processDueNotificationJobs(50);

    // The job was claimed but its processing threw — it must be released.
    expect(result.processed).toBe(1);
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(0);

    expect(notificationJobUpdates()).toContainEqual(
      expect.objectContaining({
        status: "pending",
        attempts: 1,
        error: "processing error, retrying",
      }),
    );
  });

  it("fails the job once max attempts are exhausted", async () => {
    supabaseMock.appointmentLookupThrows = true;
    supabaseMock.rpc.mockImplementation(async () => ({
      data: [makeJob({ attempts: 2, max_attempts: 3 })],
      error: null,
    }));

    const result = await processDueNotificationJobs(50);

    expect(result.processed).toBe(1);
    expect(result.failed).toBe(1);

    expect(notificationJobUpdates()).toContainEqual(
      expect.objectContaining({
        status: "failed",
        attempts: 3,
        error: "processing error after retries",
      }),
    );
  });

  it("never releases a job whose message was already sent (no duplicate send)", async () => {
    supabaseMock.notificationJobUpdateThrows = true;
    supabaseMock.rpc.mockImplementation(async () => ({ data: [makeJob()], error: null }));

    const result = await processDueNotificationJobs(50);

    // The send succeeded (messageId returned) but recording it failed: the
    // job must NOT go back to pending, or the next run would send the same
    // reminder twice. It is marked failed instead.
    expect(result.processed).toBe(1);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);

    expect(notificationJobUpdates()).toContainEqual(
      expect.objectContaining({ status: "failed", error: "sent but not recorded" }),
    );
    expect(notificationJobUpdates().some((u) => (u as { status?: string }).status === "pending")).toBe(false);
  });

  it("still processes the remaining jobs after one job fails", async () => {
    supabaseMock.appointmentLookupThrows = true;
    supabaseMock.rpc.mockImplementation(async () => ({
      data: [makeJob({ id: "job-bad", max_attempts: 1 }), makeJob({ id: "job-ok" })],
      error: null,
    }));

    const result = await processDueNotificationJobs(50);

    // job-bad exhausted its attempts -> failed; job-ok was released back to
    // pending. The loop must not abort after the first failure.
    expect(result.processed).toBe(2);
    expect(result.failed).toBe(1);

    const updates = notificationJobUpdates();
    expect(updates).toContainEqual(expect.objectContaining({ status: "failed" }));
    expect(updates).toContainEqual(expect.objectContaining({ status: "pending" }));
  });
});
