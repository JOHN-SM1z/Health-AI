import "server-only";
import type { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";

/**
 * Patient-facing routes resolve their clinic from the ?clinic=<id> query
 * parameter embedded in each bot's Mini App / web_app URL. When absent
 * (plain web visits) the pilot default clinic is used. Admin/doctor flows
 * always use the clinic from the staff session instead.
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

/** Clinic from the Mini App URL (?clinic=<id>), falling back to the pilot
 * default when absent. Never trusts the browser blindly: the id is looked up
 * server-side and must reference an active clinic. */
export async function getClinicFromRequest(request: Request | NextRequest) {
  const clinicId = new URL(request.url).searchParams.get("clinic");
  if (!clinicId) return getDefaultClinic();
  return getClinicById(clinicId);
}