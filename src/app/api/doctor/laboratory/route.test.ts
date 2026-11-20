import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/errors";
const mocks = vi.hoisted(() => ({ guard: vi.fn(), dashboard: vi.fn() }));
vi.mock("@/lib/auth/guards", () => ({ requireLinkedDoctor: mocks.guard }));
vi.mock("@/lib/labs/doctor-dashboard", () => ({ getDoctorLabDashboard: mocks.dashboard }));
import { GET, POST } from "./route";
const doctor = { clinicId: "verified-clinic", doctorId: "verified-doctor" };
beforeEach(() => { vi.clearAllMocks(); mocks.guard.mockResolvedValue(doctor); mocks.dashboard.mockResolvedValue({ pending: [] }); });
describe("legacy laboratory URL with canonical permissions", () => {
  it("reads the doctor's authorized current laboratory dashboard", async () => {
    expect((await GET()).status).toBe(200); expect(mocks.dashboard).toHaveBeenCalledWith(doctor);
  });
  it.each([401, 403])("rejects unauthorized access (%s)", async (status) => {
    mocks.guard.mockRejectedValue(new ApiError(status, "Denied")); expect((await GET()).status).toBe(status); expect(mocks.dashboard).not.toHaveBeenCalled();
  });
  it("routes obsolete write commands to the patient-scoped ordering API without side effects", async () => {
    const response = await POST();
    expect(response.status).toBe(410); expect((await response.json()).code).toBe("endpoint_replaced"); expect(mocks.dashboard).not.toHaveBeenCalled();
  });
});
