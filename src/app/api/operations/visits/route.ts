// Compatibility URL: the same contracts and authorization as the canonical
// arrival endpoint. Doctor queues use /api/doctor/visits, with no money fields.
import { requireRoles } from "@/lib/auth/guards";
import { ApiError, handleApiError } from "@/lib/api/errors";
export { GET, POST } from "../arrivals/route";
export async function PATCH() {
  try {
    await requireRoles("owner", "admin", "manager", "receptionist", "doctor");
    throw new ApiError(410, "Navbat amallari yangi tashrif manziliga ko‘chirildi", "endpoint_replaced", {
      reception: "/api/operations/arrivals/[id]", doctor: "/api/doctor/visits/[id]",
    });
  } catch (e) { return handleApiError(e); }
}
