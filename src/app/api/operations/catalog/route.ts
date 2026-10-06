import { requireRoles } from "@/lib/auth/guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { handleApiError, ok } from "@/lib/api/errors";
export async function GET() {
  try {
    const staff = await requireRoles("owner", "admin", "manager", "receptionist", "doctor");
    const db = createAdminClient();
    const [doctors, services] = await Promise.all([
      db.from("doctors").select("id, name, doctor_services(service_id)").eq("clinic_id", staff.clinicId).eq("active", true).order("name"),
      db.from("services").select("id, name, price").eq("clinic_id", staff.clinicId).eq("active", true).order("name"),
    ]);
    if (doctors.error) throw doctors.error;
    if (services.error) throw services.error;
    return ok({ doctors: doctors.data, services: services.data });
  } catch (e) { return handleApiError(e); }
}
