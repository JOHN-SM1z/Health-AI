import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rpc: vi.fn(), from: vi.fn(), send: vi.fn(), renew: true, finish: true,
  receiptError: false, contextError: false, consent: true,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state }));
vi.mock("@/lib/sms/provider", () => ({ activeSmsProvider: () => ({ name: "test", send: state.send }) }));
import { processDueSmsJobs } from "./processor";
const outcomes = () => state.rpc.mock.calls.filter(([n]) => n === "finish_notification_job_claim").map(([, args]) => args);

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(state, { renew: true, finish: true, receiptError: false, contextError: false, consent: true });
  state.send.mockResolvedValue({ accepted: true, providerMessageId: "receipt-1" });
  state.rpc.mockImplementation(async (name: string) => {
    if (name === "claim_due_sms_jobs") return { data: [{ id: "sms-1", clinic_id: "clinic-1", claim_token: "token-1", visit_id: "visit-1",
      recipient_patient_id: "patient-1", type: "queue_ticket", attempts: 0, max_attempts: 3 }], error: null };
    return { data: name === "renew_notification_job_claim" ? state.renew : state.finish, error: null };
  });
  state.from.mockImplementation((table: string) => {
    const query = {
      select: vi.fn(() => query), eq: vi.fn(() => query),
      insert: vi.fn(async () => ({ error: state.receiptError ? { code: "unavailable" } : null })),
      maybeSingle: vi.fn(async () => ({
        data: table === "patients" ? { phone: "+998901234567", telegram_user_id: null, sms_consent_at: state.consent ? "2026-11-20" : null }
          : table === "visits" ? { status: "waiting", queue_number: 11 } : { name: "Test clinic", sms_enabled: true },
        error: state.contextError ? { code: "unavailable" } : null,
      })),
    };
    return query;
  });
});

describe("SMS worker ownership and delivery bookkeeping", () => {
  it("checks the lease before sending and records the accepted message", async () => {
    expect(await processDueSmsJobs()).toMatchObject({ sent: 1, failed: 0 });
    expect(state.send).toHaveBeenCalledTimes(1);
    expect(outcomes()[0]).toMatchObject({ p_status: "sent", p_clinic_id: "clinic-1", p_claim_token: "token-1" });
  });
  it("does not send under a lost claim", async () => {
    state.renew = false;
    expect(await processDueSmsJobs()).toMatchObject({ sent: 0, failed: 1 });
    expect(state.send).not.toHaveBeenCalled();
    expect(outcomes()).toEqual([]);
  });
  it("rechecks consent before sending", async () => {
    state.consent = false;
    expect(await processDueSmsJobs()).toMatchObject({ skipped: 1 });
    expect(state.send).not.toHaveBeenCalled();
    expect(outcomes()[0]).toMatchObject({ p_status: "skipped" });
  });
  it.each(["timeout", "throw"])("quarantines an ambiguous %s and never requeues", async (failure) => {
    if (failure === "timeout") state.send.mockResolvedValue({ accepted: false, error: "network", outcome: "unknown" });
    else state.send.mockRejectedValue(new Error("provider connection lost"));
    expect(await processDueSmsJobs()).toMatchObject({ sent: 0, failed: 1 });
    expect(outcomes().map((o) => o.p_status)).toEqual(["quarantined"]);
  });
  it("can retry a definitive rejection", async () => {
    state.send.mockResolvedValue({ accepted: false, error: "rate_limited", outcome: "rejected" });
    await processDueSmsJobs();
    expect(outcomes()[0]).toMatchObject({ p_status: "pending" });
  });
  it("does not report sent or requeue when the acceptance receipt cannot be saved", async () => {
    state.receiptError = true;
    expect(await processDueSmsJobs()).toMatchObject({ sent: 0, failed: 1 });
    expect(outcomes().map((o) => o.p_status)).toEqual(["quarantined"]);
  });
  it("does not report sent when claim finalization affects no row", async () => {
    state.finish = false;
    expect(await processDueSmsJobs()).toMatchObject({ sent: 0, failed: 1 });
    expect(outcomes().map((o) => o.p_status)).toEqual(["sent"]);
  });
  it("a failed context lookup is retried without calling the provider", async () => {
    state.contextError = true;
    await processDueSmsJobs();
    expect(state.send).not.toHaveBeenCalled();
    expect(outcomes()[0]).toMatchObject({ p_status: "pending" });
  });
});
