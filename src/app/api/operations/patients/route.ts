import type { NextRequest } from "next/server";
import { requireRoles } from "@/lib/auth/guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { handleApiError, ok } from "@/lib/api/errors";
export async function GET(request: NextRequest) {
  try {
    const staff = await requireRoles("owner", "admin", "manager", "receptionist");
    // Only characters meaningful to the patient search; never interpolate filter syntax.
    const q = (request.nextUrl.searchParams.get("q") ?? "").replace(/[^\p{L}\p{N}\s+@'-]/gu, "").trim().slice(0, 80);
    if (q.length < 2 && !/^\d$/.test(q)) return ok({ patients: [] });
    let query = createAdminClient().from("patients").select("id, full_name, phone, patient_number").eq("clinic_id", staff.clinicId).limit(12);
    query = /^\d+$/.test(q) ? query.or(`patient_number.eq.${q},phone.ilike.%${q}%`) : query.or(`full_name.ilike.%${q}%,phone.ilike.%${q}%`);
    const { data, error } = await query;
    if (error) throw error;
    return ok({ patients: data ?? [] });
  } catch (e) { return handleApiError(e); }
}
