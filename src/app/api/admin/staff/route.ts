import type { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStaff } from "@/lib/auth/guards";
import { handleApiError, ok } from "@/lib/api/errors";
import type { StaffRole } from "@/lib/auth/staff";

export const dynamic = "force-dynamic";

const SELECTABLE_ROLES: StaffRole[] = ["doctor"];

/**
 * Minimal staff directory for privileged clinic configuration screens.
 * It intentionally exposes only the selected role and name — never emails,
 * auth metadata, or staff from another clinic.
 */
export async function GET(request: NextRequest) {
  try {
    const staff = await requireStaff("admin");
    const requestedRole = request.nextUrl.searchParams.get("role") as StaffRole | null;
    const role = requestedRole && SELECTABLE_ROLES.includes(requestedRole) ? requestedRole : "doctor";
    const supabase = createAdminClient();

    const { data, error } = await supabase
      .from("staff_roles")
      .select("profile_id, role, profiles!inner(full_name)")
      .eq("clinic_id", staff.clinicId)
      .eq("role", role)
      .order("created_at", { ascending: true });
    if (error) throw error;

    return ok({
      staff: (data ?? []).map((member) => ({
        profileId: member.profile_id,
        fullName: member.profiles?.full_name?.trim() || "Nomsiz xodim",
        role: member.role,
      })),
    });
  } catch (e) {
    return handleApiError(e);
  }
}
