import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ guard: vi.fn(), register: vi.fn() }));
vi.mock("@/lib/auth/guards", () => ({ requireRoles: mocks.guard }));
vi.mock("@/lib/operations/outpatient", () => ({ registerArrival: mocks.register, listOpenVisits: vi.fn() }));
import { POST, PATCH } from "./route";
import { ApiError } from "@/lib/api/errors";
const id = "11111111-1111-4111-8111-111111111111";
const request = (body: unknown) => new NextRequest("http://localhost/api/operations/visits", { method: "POST", body: JSON.stringify(body) });
const body = { patientId: id, doctorId: id, serviceIds: [id], key: id };
const staff = { clinicId: "verified-clinic", profileId: "verified-actor", roles: ["receptionist"] };
beforeEach(() => { vi.clearAllMocks(); mocks.guard.mockResolvedValue(staff); mocks.register.mockResolvedValue({ visitId: id, replayed: false }); });
describe("walk-in compatibility API boundary", () => {
  it("uses the current transactional arrival service and verified staff", async () => {
    expect((await POST(request(body))).status).toBe(201); expect(mocks.register).toHaveBeenCalledWith(staff, body);
  });
  it.each(["clinicId", "actorId", "amount", "paymentStatus"])("rejects browser-controlled %s", async (field) => {
    expect((await POST(request({ ...body, [field]: "forged" }))).status).toBe(400); expect(mocks.register).not.toHaveBeenCalled();
  });
  it("never reports success after an arrival failure", async () => {
    mocks.register.mockRejectedValue(new ApiError(409, "Conflict")); expect((await POST(request(body))).status).toBe(409);
  });
  it("authenticates before invoking the engine", async () => {
    mocks.guard.mockRejectedValue(new ApiError(403, "Denied")); expect((await POST(request(body))).status).toBe(403); expect(mocks.register).not.toHaveBeenCalled();
  });
  it("requires current queue commands instead of a direct status assignment", async () => {
    expect((await PATCH()).status).toBe(410); expect(mocks.register).not.toHaveBeenCalled();
  });
});
