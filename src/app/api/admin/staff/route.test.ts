import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ApiError } from "@/lib/api/errors";
const mocks = vi.hoisted(() => ({ guard: vi.fn(), from: vi.fn(), eq: vi.fn() }));
vi.mock("@/lib/auth/guards", () => ({ requireStaff: mocks.guard }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: mocks.from }) }));
import { GET } from "./route";
beforeEach(() => {
  vi.clearAllMocks(); mocks.guard.mockResolvedValue({ clinicId: "verified-clinic" });
  const chain = { select: vi.fn().mockReturnThis(), eq: mocks.eq.mockReturnThis(), order: vi.fn().mockResolvedValue({ data: [{ profile_id: "doctor-profile", role: "doctor", profiles: { full_name: "Test doctor" } }], error: null }) };
  mocks.from.mockReturnValue(chain);
});
describe("minimal clinic staff directory", () => {
  it("uses verified clinic and returns no account credentials or emails", async () => {
    const response = await GET(new NextRequest("http://localhost/api/admin/staff"));
    expect(response.status).toBe(200); expect(mocks.eq).toHaveBeenCalledWith("clinic_id", "verified-clinic");
    expect((await response.json()).data.staff).toEqual([{ profileId: "doctor-profile", fullName: "Test doctor", role: "doctor" }]);
  });
  it("does not turn an arbitrary browser role into a broader directory", async () => {
    await GET(new NextRequest("http://localhost/api/admin/staff?role=owner"));
    expect(mocks.eq).toHaveBeenCalledWith("role", "doctor");
  });
  it.each([401, 403])("requires management authorization (%s)", async (status) => {
    mocks.guard.mockRejectedValue(new ApiError(status, "Denied"));
    expect((await GET(new NextRequest("http://localhost"))).status).toBe(status); expect(mocks.from).not.toHaveBeenCalled();
  });
});
