import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ApiError } from "@/lib/api/errors";
const mocks = vi.hoisted(() => ({ guard: vi.fn(), referral: vi.fn(), workspace: vi.fn() }));
vi.mock("@/lib/auth/guards", () => ({ requireLinkedDoctor: mocks.guard }));
vi.mock("@/lib/referrals/service", () => ({ getReferralForDoctor: mocks.referral }));
vi.mock("@/lib/clinical-access/workspace", () => ({ getPatientWorkspace: mocks.workspace }));
import { GET } from "./route";
const id = "33333333-3333-4333-8333-333333333333";
const doctor = { doctorId: "verified-doctor", clinicId: "verified-clinic" };
const read = (value = id) => GET(new NextRequest("http://localhost"), { params: Promise.resolve({ id: value }) });
beforeEach(() => { vi.clearAllMocks(); mocks.guard.mockResolvedValue(doctor); mocks.referral.mockResolvedValue({ id, patientId: "verified-patient" }); mocks.workspace.mockResolvedValue({ patient: { id: "verified-patient" }, records: [{ id: "permitted" }], appointments: [] }); });
describe("referral history compatibility boundary", () => {
  it("uses both audited referral membership and DB-backed patient scope", async () => {
    const response = await read(); expect(response.status).toBe(200);
    expect(mocks.referral).toHaveBeenCalledWith(doctor, id);
    expect(mocks.workspace).toHaveBeenCalledWith(doctor, "verified-patient");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });
  it.each(["referral_expired", "referral_revoked", "referral_completed", "referral_declined"])("never bypasses ended access (%s)", async (code) => {
    mocks.workspace.mockRejectedValue(new ApiError(410, "Access ended", code));
    const response = await read(); expect(response.status).toBe(410); expect((await response.text())).not.toContain("permitted");
  });
  it("does not read any patient records for a different doctor's referral", async () => {
    mocks.referral.mockRejectedValue(new ApiError(404, "Not found"));
    expect((await read()).status).toBe(404); expect(mocks.workspace).not.toHaveBeenCalled();
  });
  it.each([401, 403])("rejects unauthorized staff before lookup (%s)", async (status) => {
    mocks.guard.mockRejectedValue(new ApiError(status, "Denied"));
    expect((await read()).status).toBe(status); expect(mocks.referral).not.toHaveBeenCalled();
  });
  it("rejects malformed ids without a record lookup", async () => {
    expect((await read("bad-id")).status).toBe(404); expect(mocks.referral).not.toHaveBeenCalled();
  });
});
