import { requireLinkedDoctor } from "@/lib/auth/guards";
import { ApiError, handleApiError } from "@/lib/api/errors";
export { GET } from "../lab/dashboard/route";
export async function POST() {
  try {
    await requireLinkedDoctor();
    throw new ApiError(410, "Laboratoriya amallari yangi buyurtma manziliga ko‘chirildi", "endpoint_replaced", {
      replacement: "/api/doctor/patients/[id]/lab-orders",
    });
  } catch (e) { return handleApiError(e); }
}
