import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

type StaffRoles = string[];

const staffMock = vi.hoisted(() => ({
  impl: async () => ({
    profileId: "staff-1",
    clinicId: "clinic-1",
    clinicName: "Test Clinic",
    clinicTimezone: "Asia/Tashkent",
    roles: ["receptionist"] as StaffRoles,
    platformAdmin: false,
  }),
}));
vi.mock("@/lib/auth/guards", () => ({
  requireRoles: () => staffMock.impl(),
}));

const transitionMock = vi.hoisted(() => ({
  impl: async () => ({ ok: true, alreadyInState: false }),
  calls: [] as Record<string, unknown>[],
}));
vi.mock("@/lib/payments/status", () => ({
  transitionPaymentStatus: (opts: Record<string, unknown>) => {
    transitionMock.calls.push(opts);
    return transitionMock.impl();
  },
}));

vi.mock("@/lib/payments/provider", () => ({
  isManualPaymentMode: () => true,
}));

import { POST } from "./route";

function setRoles(roles: StaffRoles) {
  staffMock.impl = async () => ({
    profileId: "staff-1",
    clinicId: "clinic-1",
    clinicName: "Test Clinic",
    clinicTimezone: "Asia/Tashkent",
    roles,
    platformAdmin: false,
  });
}

beforeEach(() => {
  transitionMock.calls.length = 0;
  transitionMock.impl = async () => ({ ok: true, alreadyInState: false });
  setRoles(["receptionist"]);
});

function post(body: Record<string, unknown>) {
  return POST(
    new NextRequest("http://localhost/api/admin/appointments/appt-1/payment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "appt-1" }) },
  );
}

describe("admin appointment payment POST", () => {
  it("lets a receptionist record a paid cash payment", async () => {
    setRoles(["receptionist"]);
    const res = await post({ status: "paid", provider: "cash" });
    expect(res.status).toBe(200);
    expect(transitionMock.calls).toHaveLength(1);
    expect(transitionMock.calls[0]).toMatchObject({ appointmentId: "appt-1", to: "paid", provider: "cash" });
  });

  it("lets a manager record a paid card-terminal payment", async () => {
    setRoles(["manager"]);
    const res = await post({ status: "paid", provider: "card_terminal" });
    expect(res.status).toBe(200);
    expect(transitionMock.calls[0]).toMatchObject({ to: "paid", provider: "card_terminal" });
  });

  it("rejects a receptionist marking a payment refunded — not their call", async () => {
    setRoles(["receptionist"]);
    const res = await post({ status: "refunded" });
    expect(res.status).toBe(403);
    expect(transitionMock.calls).toHaveLength(0);
  });

  it("rejects a manager marking a payment manual_review — not their call either", async () => {
    setRoles(["manager"]);
    const res = await post({ status: "manual_review" });
    expect(res.status).toBe(403);
    expect(transitionMock.calls).toHaveLength(0);
  });

  it("rejects a receptionist marking a payment failed", async () => {
    setRoles(["receptionist"]);
    const res = await post({ status: "failed" });
    expect(res.status).toBe(403);
  });

  it("lets an owner reverse a payment (refunded)", async () => {
    setRoles(["owner"]);
    const res = await post({ status: "refunded" });
    expect(res.status).toBe(200);
    expect(transitionMock.calls[0]).toMatchObject({ to: "refunded" });
  });

  it("lets an admin flag a payment for manual review", async () => {
    setRoles(["admin"]);
    const res = await post({ status: "manual_review" });
    expect(res.status).toBe(200);
  });

  it("requires a provider when marking paid, even for an owner", async () => {
    setRoles(["owner"]);
    const res = await post({ status: "paid" });
    expect(res.status).toBe(400);
    expect(transitionMock.calls).toHaveLength(0);
  });

  it("rejects a provider value that isn't staff-collectible (e.g. click)", async () => {
    setRoles(["owner"]);
    const res = await post({ status: "paid", provider: "click" });
    expect(res.status).toBe(400);
  });

  it("never forwards a provider for a non-paid transition", async () => {
    setRoles(["owner"]);
    await post({ status: "refunded" });
    expect(transitionMock.calls[0]).toMatchObject({ to: "refunded", provider: undefined });
  });
});
