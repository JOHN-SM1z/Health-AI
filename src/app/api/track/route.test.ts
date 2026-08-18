import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const supabaseMock = { from: vi.fn() };
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => supabaseMock,
}));

vi.mock("@/lib/clinics/context", () => ({
  getClinicFromRequest: vi.fn(async () => ({
    id: "11111111-1111-4111-8111-111111111111",
    name: "Clinic A",
    timezone: "Asia/Tashkent",
    currency: "UZS",
  })),
}));

const resolveMock = vi.fn();
vi.mock("@/lib/patients/identity", () => ({
  resolvePatientFromInitData: (...args: unknown[]) => resolveMock(...args),
  devIdentityAllowed: () => false,
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: () => ({ ok: true }),
  keyFromIp: () => "test-ip",
}));

vi.mock("@/lib/analytics", () => ({ trackAnalytics: vi.fn(async () => {}) }));

import { POST } from "./route";

function post(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new NextRequest("http://localhost/api/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/track (red-team: identity handling)", () => {
  it("returns 401 (not 500) when initData is null", async () => {
    resolveMock.mockResolvedValue(null);
    const res = await post({ initData: null, eventType: "booking_started" });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("invalid_init_data");
  });

  it("returns 401 (not 500) when initData is absent", async () => {
    resolveMock.mockResolvedValue(null);
    const res = await post({ eventType: "booking_started" });
    expect(res.status).toBe(401);
  });

  it("rejects a development identity in production", async () => {
    resolveMock.mockResolvedValue(null);
    const res = await post({ initData: "dev", eventType: "booking_started" });
    expect(res.status).toBe(403);
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it("rejects disallowed event types with 400", async () => {
    resolveMock.mockResolvedValue({ patient: { id: "p-1" } });
    const res = await post({ initData: "signed-data", eventType: "delete_everything" });
    expect(res.status).toBe(400);
    expect(resolveMock).not.toHaveBeenCalled();
  });
});