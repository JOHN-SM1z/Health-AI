import { describe, it, expect, vi, beforeEach } from "vitest";

const insert = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: () => ({ insert }) }) }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { recordAudit } from "@/lib/audit";

const event = { clinicId: "clinic-a", action: "referral_viewed", entityType: "referrals", entityId: "r-1" };

beforeEach(() => {
  insert.mockReset();
});

describe("recordAudit", () => {
  it("is best-effort by default: a failed write never breaks the caller", async () => {
    insert.mockResolvedValue({ error: { message: "db down" } });
    await expect(recordAudit(event)).resolves.toBeUndefined();

    insert.mockRejectedValue(new Error("network"));
    await expect(recordAudit(event)).resolves.toBeUndefined();
  });

  it("fails closed in strict mode, so data is never released unlogged", async () => {
    insert.mockResolvedValue({ error: { message: "db down" } });
    await expect(recordAudit({ ...event, strict: true })).rejects.toMatchObject({ status: 503, code: "audit_unavailable" });

    insert.mockRejectedValue(new Error("network"));
    await expect(recordAudit({ ...event, strict: true })).rejects.toMatchObject({ status: 503 });
  });

  it("resolves in strict mode when the write succeeds", async () => {
    insert.mockResolvedValue({ error: null });
    await expect(recordAudit({ ...event, strict: true })).resolves.toBeUndefined();
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ action: "referral_viewed", entity_id: "r-1" }));
  });
});
