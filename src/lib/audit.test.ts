import { describe, it, expect, vi, beforeEach } from "vitest";

const insert = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: () => ({ insert }) }) }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { recordAudit, recordAudits } from "@/lib/audit";

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
    expect(insert).toHaveBeenCalledWith([expect.objectContaining({ action: "referral_viewed", entity_id: "r-1" })]);
  });

  it("names the patient and referral in their own columns, and never takes a timestamp from the caller", async () => {
    insert.mockResolvedValue({ error: null });
    await recordAudit({ ...event, patientId: "p-1", referralId: "r-1", actor: { actorId: "u-1", actorType: "staff" } });
    const [row] = insert.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(row).toMatchObject({ clinic_id: "clinic-a", actor_id: "u-1", actor_type: "staff", patient_id: "p-1", referral_id: "r-1" });
    expect(row).not.toHaveProperty("created_at");
  });
});

describe("recordAudits", () => {
  it("writes every event in one insert — all or none — and fails closed in strict mode", async () => {
    insert.mockResolvedValue({ error: null });
    await recordAudits([event, { ...event, entityId: "r-2", referralId: "r-2" }], { strict: true });
    expect(insert).toHaveBeenCalledTimes(1);
    expect((insert.mock.calls[0][0] as unknown[]).length).toBe(2);

    insert.mockResolvedValue({ error: { message: "db down" } });
    await expect(recordAudits([event], { strict: true })).rejects.toMatchObject({ status: 503 });
  });

  it("writes nothing for an empty list", async () => {
    await recordAudits([], { strict: true });
    expect(insert).not.toHaveBeenCalled();
  });
});
