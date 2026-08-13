import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";

/**
 * Pilot version serves one clinic. Resolves the active clinic for
 * patient-facing endpoints; admin/doctor flows always use the clinic from
 * the staff session instead.
 */
export async function getDefaultClinic() {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("clinics")
    .select("*")
    .eq("is_active", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    throw new ApiError(503, "Klinika hali sozlanmagan", "clinic_not_configured");
  }
  return data;
}

export async function getClinicById(clinicId: string) {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("clinics")
    .select("*")
    .eq("id", clinicId)
    .maybeSingle();
  if (error || !data) throw new ApiError(404, "Klinika topilmadi", "clinic_not_found");
  return data;
}