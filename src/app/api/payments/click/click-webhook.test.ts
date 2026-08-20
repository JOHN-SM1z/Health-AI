import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { clickWebhookSignature } from "@/lib/payments/click";

const SECRET = "test-secret";
const SERVICE_ID = "123";
const CLINIC_ID = "11111111-1111-4111-8111-111111111111";
const APPOINTMENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PAYMENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const supabaseMock = { from: vi.fn() };
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => supabaseMock,
}));

const claimMock = vi.fn();
const finishMock = vi.fn();
const releaseMock = vi.fn();
vi.mock("@/lib/telegram/idempotency", () => ({
  claimWebhookProcessing: (...args: unknown[]) => claimMock(...args),
  finishWebhookProcessing: (...args: unknown[]) => finishMock(...args),
  releaseWebhookProcessing: (...args: unknown[]) => releaseMock(...args),
}));

const transitionMock = vi.fn();
vi.mock("@/lib/payments/status", () => ({
  transitionPaymentStatus: (...args: unknown[]) => transitionMock(...args),
}));

import type { handleClickWebhook } from "@/lib/payments/click-webhook";

let handler: typeof handleClickWebhook;

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("CLICK_SECRET_KEY", SECRET);
  vi.stubEnv("CLICK_SERVICE_ID", SERVICE_ID);
  vi.stubEnv("CRON_SECRET", "0123456789abcdef0123456789abcdef");
  vi.stubEnv("PAYMENT_PROVIDER", "manual");
  vi.clearAllMocks();
  claimMock.mockResolvedValue(true);
  finishMock.mockResolvedValue(undefined);
  releaseMock.mockResolvedValue(undefined);
  transitionMock.mockResolvedValue({ ok: true });
  supabaseMock.from.mockReset();
  supabaseMock.from.mockImplementation(() => ({
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        maybeSingle: vi.fn(async () => ({
          data: {
            id: PAYMENT_ID,
            appointment_id: APPOINTMENT_ID,
            clinic_id: CLINIC_ID,
            amount: 100,
            currency: "UZS",
            status: "unpaid",
            provider_reference: "inv-1",
          },
          error: null,
        })),
      })),
    })),
  }));
  handler = (await import("@/lib/payments/click-webhook")).handleClickWebhook;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function signedBody(opts: { amount?: string; clickTransId?: string; error?: string } = {}) {
  const clickTransId = opts.clickTransId ?? "123456";
  const amount = opts.amount ?? "100.00";
  const error = opts.error ?? "0";
  const params = {
    click_trans_id: clickTransId,
    service_id: SERVICE_ID,
    click_paydoc_id: "987654",
    merchant_trans_id: APPOINTMENT_ID,
    amount,
    error,
    sign_time: "1700000001",
  };
  const signString = clickWebhookSignature({
    clickTransId,
    serviceId: SERVICE_ID,
    secretKey: SECRET,
    merchantTransId: APPOINTMENT_ID,
    amount,
    error,
    clickPaydocId: "987654",
    signTime: "1700000001",
  });
  const form = new URLSearchParams({ ...params, sign_string: signString }).toString();
  return { form, clickTransId, amount };
}

describe("click webhook: signature gate", () => {
  it("rejects an invalid signature before any state change", async () => {
    const form = new URLSearchParams({
      click_trans_id: "123456",
      service_id: SERVICE_ID,
      click_paydoc_id: "987654",
      merchant_trans_id: APPOINTMENT_ID,
      amount: "100.00",
      error: "0",
      sign_time: "1700000001",
      sign_string: "deadbeefdeadbeefdeadbeefdeadbeef",
    }).toString();
    const res = await handler(form, false);
    expect(res.status).toBe(200);
    expect((await res.json()).error_code).toBe("-1");
    expect(claimMock).not.toHaveBeenCalled();
    expect(transitionMock).not.toHaveBeenCalled();
  });

  it("rejects a wrong service id", async () => {
    const signString = clickWebhookSignature({
      clickTransId: "123456",
      serviceId: "999",
      secretKey: SECRET,
      merchantTransId: APPOINTMENT_ID,
      amount: "100.00",
      error: "0",
      clickPaydocId: "987654",
      signTime: "1700000001",
    });
    const form = new URLSearchParams({
      click_trans_id: "123456",
      service_id: "999",
      click_paydoc_id: "987654",
      merchant_trans_id: APPOINTMENT_ID,
      amount: "100.00",
      error: "0",
      sign_time: "1700000001",
      sign_string: signString,
    }).toString();
    const res = await handler(form, false);
    expect((await res.json()).error_code).toBe("-2");
    expect(claimMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed body", async () => {
    const res = await handler("not=form&encoded", false);
    expect((await res.json()).error_code).toBe("-6");
  });
});

describe("click webhook: prepare", () => {
  it("transitions unpaid -> pending and acks", async () => {
    const { form, clickTransId } = signedBody();
    const res = await handler(form, false);
    const body = (await res.json()) as Record<string, string>;
    expect(body.error_code).toBe("0");
    expect(body.merchant_trans_id).toBe(APPOINTMENT_ID);
    expect(body.click_trans_id).toBe(clickTransId);
    expect(transitionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: PAYMENT_ID,
        clinicId: CLINIC_ID,
        to: "pending",
        actorType: "system",
      }),
    );
    expect(finishMock).toHaveBeenCalledWith("click", clickTransId);
  });

  it("does not transition an already-pending payment twice", async () => {
    supabaseMock.from.mockImplementation(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(async () => ({
            data: {
              id: PAYMENT_ID,
              appointment_id: APPOINTMENT_ID,
              clinic_id: CLINIC_ID,
              amount: 100,
              currency: "UZS",
              status: "pending",
              provider_reference: "inv-1",
            },
            error: null,
          })),
        })),
      })),
    }));
    const { form, clickTransId } = signedBody();
    const res = await handler(form, false);
    expect((await res.json()).error_code).toBe("0");
    expect(transitionMock).not.toHaveBeenCalled();
    expect(finishMock).toHaveBeenCalledWith("click", clickTransId);
  });

  it("rejects an amount mismatch", async () => {
    const { form } = signedBody({ amount: "99.00" });
    const res = await handler(form, false);
    expect((await res.json()).error_code).toBe("-4");
    expect(transitionMock).not.toHaveBeenCalled();
    expect(finishMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown appointment", async () => {
    supabaseMock.from.mockImplementation(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(async () => ({ data: null, error: null })),
        })),
      })),
    }));
    const { form } = signedBody();
    const res = await handler(form, false);
    expect((await res.json()).error_code).toBe("-5");
  });
});

describe("click webhook: idempotency", () => {
  it("acks duplicates without side effects", async () => {
    claimMock.mockResolvedValue(false);
    const { form } = signedBody();
    const res = await handler(form, false);
    const body = (await res.json()) as Record<string, string>;
    expect(body.error_code).toBe("0");
    expect(transitionMock).not.toHaveBeenCalled();
    expect(finishMock).not.toHaveBeenCalled();
  });

  it("releases the claim when the handler fails", async () => {
    transitionMock.mockRejectedValue(new Error("db down"));
    const { form, clickTransId } = signedBody();
    const res = await handler(form, false);
    expect((await res.json()).error_code).toBe("-9");
    expect(releaseMock).toHaveBeenCalledWith("click", clickTransId);
  });
});

describe("click webhook: complete", () => {
  it("transitions pending -> paid", async () => {
    supabaseMock.from.mockImplementation(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(async () => ({
            data: {
              id: PAYMENT_ID,
              appointment_id: APPOINTMENT_ID,
              clinic_id: CLINIC_ID,
              amount: 100,
              currency: "UZS",
              status: "pending",
              provider_reference: "inv-1",
            },
            error: null,
          })),
        })),
      })),
    }));
    const { form, clickTransId } = signedBody();
    const res = await handler(form, true);
    const body = (await res.json()) as Record<string, string>;
    expect(body.error_code).toBe("0");
    expect(body.merchant_confirm_id).toBe(clickTransId);
    expect(transitionMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: "paid", actorType: "system", clinicId: CLINIC_ID }),
    );
  });

  it("transitions unpaid -> paid (complete without prepare)", async () => {
    const { form } = signedBody();
    const res = await handler(form, true);
    expect((await res.json()).error_code).toBe("0");
    expect(transitionMock).toHaveBeenCalledWith(expect.objectContaining({ to: "paid" }));
  });

  it("acks an already-paid completion without a second transition", async () => {
    supabaseMock.from.mockImplementation(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(async () => ({
            data: {
              id: PAYMENT_ID,
              appointment_id: APPOINTMENT_ID,
              clinic_id: CLINIC_ID,
              amount: 100,
              currency: "UZS",
              status: "paid",
              provider_reference: "inv-1",
            },
            error: null,
          })),
        })),
      })),
    }));
    const { form } = signedBody();
    const res = await handler(form, true);
    expect((await res.json()).error_code).toBe("0");
    expect(transitionMock).not.toHaveBeenCalled();
  });
});