import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ApiError } from "@/lib/api/errors";
const mocks = vi.hoisted(() => ({ guard: vi.fn(), workspace: vi.fn(), write: vi.fn() }));
vi.mock("@/lib/auth/guards", () => ({ requireLinkedDoctor: mocks.guard }));
vi.mock("@/lib/clinical-access/workspace", () => ({ getPatientWorkspace: mocks.workspace }));
vi.mock("@/lib/clinical-records/service", () => ({ createClinicalRecord: mocks.write }));
import { GET, POST } from "@/app/api/doctor/clinical-notes/route";
const id = "33333333-3333-4333-8333-333333333333";
const patient = "22222222-2222-4222-8222-222222222222";
const doctor = { profileId: "verified-profile", clinicId: "verified-clinic", doctorId: "verified-doctor" };
const body = { patientId: patient, appointmentId: id, idempotencyKey: id, recordType: "consultation_note", summary: "Doctor-authored note" };
const req = (value: unknown) => new NextRequest("http://localhost/api/doctor/clinical-notes", { method: "POST", body: JSON.stringify(value) });
beforeEach(() => { vi.clearAllMocks(); mocks.guard.mockResolvedValue(doctor); mocks.workspace.mockResolvedValue({ records: [{ id }], relationship: "referred" }); mocks.write.mockResolvedValue({ id, replayed: false }); });
describe("clinical handoff record compatibility route", () => {
  it("reads only the authoritative scoped workspace, with cache prevention", async () => {
    const response = await GET(new NextRequest(`http://localhost/api/doctor/clinical-notes?patientId=${patient}`));
    expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(mocks.workspace).toHaveBeenCalledWith(doctor, patient);
    expect((await response.json()).data.notes).toEqual([{ id }]);
  });
  it.each(["referral_completed", "referral_revoked", "referral_expired"])("denies history after DB access terminates: %s", async (code) => {
    mocks.workspace.mockRejectedValue(new ApiError(410, "Access ended", code));
    expect((await GET(new NextRequest(`http://localhost/api/doctor/clinical-notes?patientId=${patient}`))).status).toBe(410);
  });
  it("writes an attributed record through the consultation service", async () => {
    expect((await POST(req(body))).status).toBe(201);
    const input = { appointmentId: body.appointmentId, idempotencyKey: body.idempotencyKey, recordType: body.recordType, summary: body.summary };
    expect(mocks.write).toHaveBeenCalledWith(doctor, patient, input);
  });
  it("retries the same creation without creating a second record", async () => {
    mocks.write.mockResolvedValue({ id, replayed: true }); expect((await POST(req(body))).status).toBe(200);
  });
  it.each(["appointmentId", "idempotencyKey"])("requires provenance field %s", async (field) => {
    const input: Record<string, unknown> = { ...body }; delete input[field];
    expect((await POST(req(input))).status).toBe(400); expect(mocks.write).not.toHaveBeenCalled();
  });
  it.each(["clinicId", "authorDoctorId", "referralId", "isPrivate"])("rejects obsolete or forged %s", async (field) => {
    expect((await POST(req({ ...body, [field]: "forged" }))).status).toBe(400); expect(mocks.write).not.toHaveBeenCalled();
  });
  it("preserves consultation ownership refusal", async () => {
    mocks.write.mockRejectedValue(new ApiError(404, "Consultation unavailable", "consultation_not_found"));
    expect((await POST(req(body))).status).toBe(404);
  });
  it.each([401, 403])("requires a linked doctor before any clinical access (%s)", async (status) => {
    mocks.guard.mockRejectedValue(new ApiError(status, "Denied"));
    expect((await POST(req(body))).status).toBe(status); expect(mocks.write).not.toHaveBeenCalled();
  });
});
