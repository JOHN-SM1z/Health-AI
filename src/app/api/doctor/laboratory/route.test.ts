import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ApiError } from "@/lib/api/errors";
const mocks = vi.hoisted(() => ({ guard: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/auth/guards", () => ({ requireRoles: mocks.guard }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: mocks.rpc }) }));
import { GET, POST } from "./route";
const id = "00000000-0000-4000-8000-000000000001";
const actor = "00000000-0000-4000-8000-000000000002";
const request = (body: unknown) => new NextRequest("http://localhost/api/doctor/laboratory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
beforeEach(() => { vi.clearAllMocks(); mocks.guard.mockResolvedValue({ clinicId: id, profileId: actor }); mocks.rpc.mockResolvedValue({ data: { id }, error: null }); });
describe("laboratory API authorization boundary", () => {
  it("takes clinic and actor only from the authenticated context", async () => {
    const result = await POST(request({ action: "create", patientId: id, idempotencyKey: id, specimenType: "Synthetic", tests: ["Test"] }));
    expect(result.status).toBe(200);
    expect(mocks.guard).toHaveBeenCalledWith("doctor");
    expect(mocks.rpc).toHaveBeenCalledWith("lab_workbench", expect.objectContaining({ p_clinic: id, p_actor: actor, p_action: "create" }));
    expect(result.headers.get("Cache-Control")).toContain("no-store");
  });
  it("never reaches privileged database code for unauthenticated reads", async () => {
    mocks.guard.mockRejectedValue(new ApiError(401, "Authentication required"));
    expect((await GET(new NextRequest("http://localhost/api/doctor/laboratory"))).status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("rejects forged scope and unimplemented release commands", async () => {
    for (const body of [{ action: "release", orderId: id }, { action: "create", patientId: id, idempotencyKey: id, specimenType: "Sample", tests: ["Test"], clinicId: id }]) expect((await POST(request(body))).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("reports denied access and concurrent changes without claiming success", async () => {
    for (const [code, status] of [["42501", 403], ["40001", 409]] as const) {
      mocks.rpc.mockResolvedValue({ data: null, error: { code, message: "internal details" } });
      const result = await GET(new NextRequest(`http://localhost/api/doctor/laboratory?orderId=${id}`));
      expect(result.status).toBe(status);
      expect(JSON.stringify(await result.json())).not.toContain("internal details");
    }
  });
});
