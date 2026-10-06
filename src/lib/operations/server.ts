import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { parseOperationsSettings } from "./settings";
export async function getOperationsSettings(clinicId: string) {
  const { data, error } = await createAdminClient().from("app_settings").select("value")
    .eq("clinic_id", clinicId).eq("key", "clinic_operations").maybeSingle();
  if (error) throw new ApiError(503, "Klinika sozlamalari yuklanmadi");
  return parseOperationsSettings(data?.value);
}
export async function requireScheduledBookings(clinicId: string) {
  if ((await getOperationsSettings(clinicId)).mode === "walk_in") {
    throw new ApiError(409, "Bu klinikada jonli navbat. Registratsiyaga murojaat qiling.", "walk_in_only");
  }
}
