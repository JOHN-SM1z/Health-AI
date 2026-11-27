import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rpc: vi.fn(), from: vi.fn(), send: vi.fn(),
  contextError: false, renew: true, finishError: false,
  conversation: "open", jobs: [] as Record<string, unknown>[],
  filters: [] as Array<[string, string, unknown]>,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state }));
vi.mock("@/lib/telegram/bot", () => ({ sendTelegramMessage: state.send }));
import { processDueNotificationJobs } from "./processor";

const job = (fields: Record<string, unknown> = {}) => ({
  id: "job-1", clinic_id: "clinic-1", claim_token: "token-1",
  appointment_id: "appointment-1", conversation_id: null,
  patient_telegram_user_id: 777000, type: "booking_confirmation", attempts: 0, max_attempts: 3,
  scheduled_for: new Date(Date.now() - 1000).toISOString(), ...fields,
});
const outcomes = () => state.rpc.mock.calls.filter(([name]) => name === "finish_notification_job_claim").map(([, args]) => args);

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(state, { contextError: false, renew: true, finishError: false, conversation: "open", jobs: [job()], filters: [] });
  state.send.mockResolvedValue(42);
  state.rpc.mockImplementation(async (name: string) => {
    if (name === "claim_due_notification_jobs") return { data: state.jobs, error: null };
    if (name === "renew_notification_job_claim") return { data: state.renew, error: null };
    if (name === "finish_notification_job_claim") return state.finishError
      ? { data: null, error: { code: "database_unavailable", message: "private provider detail" } }
      : { data: true, error: null };
    throw new Error("unexpected RPC");
  });
  state.from.mockImplementation((table: string) => {
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn((key: string, value: unknown) => { state.filters.push([table, key, value]); return query; }),
      maybeSingle: vi.fn(async () => {
        if (table === "appointments") {
          if (state.contextError) throw new Error("private preparation error");
          return { data: { start_at: new Date(Date.now() + 7 * 86400000).toISOString(), status: "confirmed",
            doctors: { name: "Test doctor" }, services: { name: "Test service" }, payments: { amount: 150000, currency: "UZS" } }, error: null };
        }
        if (table === "conversations") return { data: { status: state.conversation }, error: null };
        return { data: { timezone: "Asia/Tashkent" }, error: null };
      }),
    };
    return query;
  });
});

describe("notification worker claim ownership and uncertain delivery", () => {
  it("renews before sending and records acceptance under the same clinic and token", async () => {
    expect(await processDueNotificationJobs()).toMatchObject({ processed: 1, sent: 1, failed: 0 });
    expect(state.rpc).toHaveBeenCalledWith("renew_notification_job_claim", {
      p_clinic_id: "clinic-1", p_job_id: "job-1", p_claim_token: "token-1",
    });
    expect(outcomes()).toContainEqual(expect.objectContaining({ p_status: "sent", p_telegram_message_id: 42, p_claim_token: "token-1", p_clinic_id: "clinic-1" }));
    expect(state.filters).toContainEqual(["appointments", "clinic_id", "clinic-1"]);
    expect(state.rpc.mock.invocationCallOrder[1]).toBeLessThan(state.send.mock.invocationCallOrder[0]);
  });

  it("an expired, cancelled or replaced claim cannot reach the provider", async () => {
    state.renew = false;
    expect(await processDueNotificationJobs()).toMatchObject({ sent: 0, failed: 1 });
    expect(state.send).not.toHaveBeenCalled();
    expect(outcomes()).toEqual([]);
  });

  it("a legacy token-less claim cannot send", async () => {
    state.jobs = [job({ claim_token: null })];
    await processDueNotificationJobs();
    expect(state.send).not.toHaveBeenCalled();
    expect(outcomes()).toEqual([]);
  });

  it.each(["null", "throw"])("quarantines an uncertain %s send instead of replaying it", async (failure) => {
    if (failure === "null") state.send.mockResolvedValue(null);
    else state.send.mockRejectedValue(new Error("request timeout"));
    expect(await processDueNotificationJobs()).toMatchObject({ sent: 0, failed: 1 });
    expect(outcomes()).toHaveLength(1);
    expect(outcomes()[0]).toMatchObject({ p_status: "quarantined" });
    expect(state.send).toHaveBeenCalledTimes(1);
  });

  it("never requeues an accepted send when PostgREST returns an error object", async () => {
    state.finishError = true;
    expect(await processDueNotificationJobs()).toMatchObject({ sent: 0, failed: 1 });
    expect(state.send).toHaveBeenCalledTimes(1);
    expect(outcomes().map((o) => o.p_status)).toEqual(["sent"]);
    expect(state.from).not.toHaveBeenCalledWith("notification_jobs");
  });

  it("retries a preparation failure before any provider I/O", async () => {
    state.contextError = true;
    expect(await processDueNotificationJobs()).toMatchObject({ processed: 1, sent: 0 });
    expect(state.send).not.toHaveBeenCalled();
    expect(outcomes()[0]).toMatchObject({ p_status: "pending" });
  });

  it("bounds preparation retries and keeps processing the rest of the batch", async () => {
    state.contextError = true;
    state.jobs = [job({ id: "exhausted", attempts: 2 }), job({ id: "retry" })];
    expect(await processDueNotificationJobs()).toMatchObject({ processed: 2, failed: 1 });
    expect(outcomes().map((o) => [o.p_job_id, o.p_status])).toEqual([["exhausted", "failed"], ["retry", "pending"]]);
  });

  it("stops automated messages for a human-held conversation", async () => {
    state.conversation = "assigned";
    state.jobs = [job({ conversation_id: "conversation-1" })];
    await processDueNotificationJobs();
    expect(state.send).not.toHaveBeenCalled();
    expect(outcomes()[0]).toMatchObject({ p_status: "skipped" });
    expect(state.filters).toContainEqual(["conversations", "clinic_id", "clinic-1"]);
  });
});
