import { describe, it, expect } from "vitest";
import {
  clickAmount,
  clickInvoiceSignature,
  clickWebhookSignature,
  clickWebhookSignatureValid,
  clickSignTime,
} from "@/lib/payments/click";

describe("click amount/sign-time formatting", () => {
  it("formats amounts with exactly two fraction digits", () => {
    expect(clickAmount(250000)).toBe("250000.00");
    expect(clickAmount(150000.5)).toBe("150000.50");
  });

  it("produces a seconds epoch sign time", () => {
    const t = clickSignTime(new Date("2024-01-01T00:00:00Z"));
    expect(t).toBe("1704067200");
  });
});

describe("click invoice signature", () => {
  it("matches the documented concatenation order", () => {
    const sig = clickInvoiceSignature({
      merchantId: "12345",
      serviceId: "123",
      secretKey: "secret-key",
      merchantTransId: "t-1",
      amount: "100.00",
      currency: "860",
      signTime: "1700000000",
    });
    expect(sig).toBe("4346e2e262fafda24492f7480f29f6c3");
  });
});

describe("click webhook signature verification", () => {
  const base = {
    clickTransId: "123456",
    serviceId: "123",
    secretKey: "secret-key",
    merchantTransId: "t-1",
    amount: "100.00",
    error: "0",
    clickPaydocId: "987654",
    signTime: "1700000001",
  };

  it("accepts a correctly signed payload", () => {
    const signString = clickWebhookSignature(base);
    expect(signString).toBe("3bc1e59a279b3b58bb38ab3b0a8dc794");
    expect(clickWebhookSignatureValid({ ...base, signString })).toBe(true);
  });

  it("rejects a tampered amount", () => {
    const signString = clickWebhookSignature(base);
    expect(clickWebhookSignatureValid({ ...base, amount: "99.00", signString })).toBe(false);
  });

  it("rejects a tampered transaction id", () => {
    const signString = clickWebhookSignature(base);
    expect(clickWebhookSignatureValid({ ...base, clickTransId: "999999", signString })).toBe(false);
  });

  it("rejects a wrong sign string", () => {
    expect(clickWebhookSignatureValid({ ...base, signString: "00000000000000000000000000000000" })).toBe(false);
  });

  it("rejects empty inputs", () => {
    expect(clickWebhookSignatureValid({ ...base, signString: "" })).toBe(false);
  });
});