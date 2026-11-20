import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ApiError } from "@/lib/api/errors";
const mocks = vi.hoisted(() => ({ guard: vi.fn(), get: vi.fn(), act: vi.fn() }));
vi.mock("@/lib/auth/guards", () => ({ requireLinkedDoctor: mocks.guard }));
vi.mock("@/lib/referrals/service", () => ({ getReferralForDoctor: mocks.get, actOnReferral: mocks.act }));
import { GET, PATCH } from "./route";
const id = "33333333-3333-4333-8333-333333333333";
const doctor = { profileId: "verified-profile", doctorId: "verified-doctor", clinicId: "verified-clinic" };
const ctx = (value = id) => ({ params: Promise.resolve({ id: value }) });
const req = (body: unknown) => new NextRequest(`http://localhost/api/doctor/referrals/${id}`, { method: "PATCH", body: JSON.stringify(body) });
beforeEach(() => { vi.clearAllMocks(); mocks.guard.mockResolvedValue(doctor); mocks.get.mockResolvedValue({ id }); mocks.act.mockResolvedValue({ id }); });
describe("referral route using canonical lifecycle service", () => {
  it("reads only through the audited doctor-scoped service", async () => {
    expect((await GET(new NextRequest("http://localhost"), ctx())).status).toBe(200);
    expect(mocks.get).toHaveBeenCalledWith(doctor, id);
  });
  it.each([401, 403])("denies %s before reading or writing a referral", async (status) => {
    mocks.guard.mockRejectedValue(new ApiError(status, "Denied"));
    expect((await GET(new NextRequest("http://localhost"), ctx())).status).toBe(status);
    expect((await PATCH(req({ action: "accept" }), ctx())).status).toBe(status);
    expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.act).not.toHaveBeenCalled();
  });
  it("does not probe invalid referral identifiers", async () => {
    expect((await PATCH(req({ action: "accept" }), ctx("not-a-uuid"))).status).toBe(404);
    expect(mocks.act).not.toHaveBeenCalled();
  });
  it.each(["accept", "decline", "complete", "revoke"])("passes %s with the verified doctor and explicit action", async (action) => {
    const reason = action === "revoke" || action === "decline" ? "Doctor entered reason" : undefined;
    expect((await PATCH(req({ action, ...(reason ? { reason } : {}) }), ctx())).status).toBe(200);
    expect(mocks.act).toHaveBeenCalledWith(doctor, id, action, reason);
  });
  it.each(["in_progress", "expired", "completed", "accepted"])("refuses direct status assignment %s", async (status) => {
    expect((await PATCH(req({ status }), ctx())).status).toBe(400);
    expect(mocks.act).not.toHaveBeenCalled();
  });
  it.each(["clinicId", "doctorId", "patientId", "createdBy", "handoffNote"])("rejects a browser-controlled %s", async (field) => {
    expect((await PATCH(req({ action: "accept", [field]: "forged" }), ctx())).status).toBe(400);
    expect(mocks.act).not.toHaveBeenCalled();
  });
  it("requires a reason before revocation", async () => {
    expect((await PATCH(req({ action: "revoke" }), ctx())).status).toBe(400);
    expect(mocks.act).not.toHaveBeenCalled();
  });
  it.each([[403, "forbidden"], [409, "consultation_not_started"], [410, "referral_expired"]] as const)("preserves a service denial %s %s", async (status, code) => {
    mocks.act.mockRejectedValue(new ApiError(status, "Denied", code));
    const response = await PATCH(req({ action: "complete" }), ctx());
    expect(response.status).toBe(status); expect((await response.json()).code).toBe(code);
  });
});
