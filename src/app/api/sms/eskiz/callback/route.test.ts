import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const mocked = vi.hoisted(() => ({
  from: vi.fn(),
  update: vi.fn(),
  eq: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: mocked.from }) }));
vi.mock("@/lib/logger", () => ({ logger: { error: mocked.error } }));

const key = "synthetic-callback-verification-value-01";

function callback(input: unknown, providedKey = key) {
  return new NextRequest(`http://localhost/api/sms/eskiz/callback?key=${encodeURIComponent(providedKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("ESKIZ_CALLBACK_SECRET", key);
  mocked.from.mockReturnValue({ update: mocked.update });
  mocked.update.mockReturnValue({ eq: mocked.eq });
  mocked.eq.mockReturnValueOnce({ eq: mocked.eq }).mockReturnValueOnce({ eq: mocked.eq }).mockResolvedValue({ error: null });
});

afterEach(() => vi.unstubAllEnvs());

describe("Eskiz delivery reports", () => {
  it("only finalizes an accepted message identified by the provider", async () => {
    const response = await POST(callback({ message_id: 42, status: "DELIVRD" }));
    expect(response.status).toBe(200);
    expect(mocked.update).toHaveBeenCalledWith({ status: "delivered", delivered_at: expect.any(String) });
    expect(mocked.eq.mock.calls).toEqual([["provider", "eskiz"], ["provider_message_id", "42"], ["status", "sent"]]);
  });

  it.each(["returned error", "thrown error"])("requests retry without exposing data on %s", async (failure) => {
    const detail = "synthetic-sensitive-error-content";
    if (failure === "returned error") mocked.eq.mockResolvedValue({ error: { message: detail } });
    else mocked.eq.mockRejectedValue(new Error(detail));

    const response = await POST(callback({ message_id: "test-message", status: "FAILED" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false });
    expect(mocked.error.mock.calls).toEqual([["Eskiz delivery report could not be recorded"]]);
  });

  it("rejects a mismatched key with the same character count and a different byte length", async () => {
    const response = await POST(callback({ message_id: 42, status: "DELIVRD" }, "ž".repeat(key.length)));
    expect(response.status).toBe(401);
    expect(mocked.from).not.toHaveBeenCalled();
  });

  it("rejects null JSON and does not match a truncated provider ID", async () => {
    expect((await POST(callback(null))).status).toBe(400);
    const response = await POST(callback({ message_id: "x".repeat(101), status: "DELIVRD" }));
    expect(await response.json()).toEqual({ ok: true, ignored: true });
    expect(mocked.from).not.toHaveBeenCalled();
  });
});
