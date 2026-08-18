import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import type { NextRequest } from "next/server";
import { requireStaff, requireRoles } from "@/lib/auth/guards";
import { handleApiError, ApiError, ok } from "@/lib/api/errors";
import { uuidSchema, parseBody } from "@/lib/api/validate";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Doctors
// ---------------------------------------------------------------------------

const doctorSchema = z.object({
  name: z.string().min(2).max(120),
  title: z.string().max(200).optional(),
  specialtyId: uuidSchema.optional(),
  bio: z.string().max(1000).optional(),
  active: z.boolean().optional(),
  profileId: uuidSchema.optional(),
});

const doctorUpdateSchema = doctorSchema.partial();

/** Doctors of the staff clinic, for quick booking and management screens. */
export async function GET() {
  try {
    const staff = await requireRoles("owner", "admin", "manager", "receptionist");
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("doctors")
      .select("id, name, title, specialty_id, active, created_at")
      .eq("clinic_id", staff.clinicId)
      .eq("active", true)
      .order("created_at", { ascending: true });
    if (error) throw error;
    return ok({ doctors: data ?? [] });
  } catch (e) {
    return handleApiError(e);
  }
}

export async function POST(request: NextRequest) {
  try {
    const staff = await requireStaff("admin");
    const body = await parseBody(request, doctorSchema);
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("doctors")
      .insert({
        clinic_id: staff.clinicId,
        name: body.name,
        title: body.title ?? null,
        specialty_id: body.specialtyId ?? null,
        bio: body.bio ?? null,
        active: body.active ?? true,
        profile_id: body.profileId ?? null,
      })
      .select("*")
      .single();
    if (error) throw new ApiError(500, "Shifokorni yaratib bo‘lmadi");
    return ok({ doctor: data }, { status: 201 });
  } catch (e) {
    return handleApiError(e);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const staff = await requireStaff("admin");
    const body = await parseBody(request, doctorUpdateSchema);
    const id = request.nextUrl.searchParams.get("id");
    if (!id) throw new ApiError(400, "id parametri kerak", "missing_id");
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("doctors")
      .update({
        ...(body.name ? { name: body.name } : {}),
        ...(body.title !== undefined ? { title: body.title ?? null } : {}),
        ...(body.specialtyId !== undefined ? { specialty_id: body.specialtyId ?? null } : {}),
        ...(body.bio !== undefined ? { bio: body.bio ?? null } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
        ...(body.profileId !== undefined ? { profile_id: body.profileId ?? null } : {}),
      })
      .eq("id", id)
      .eq("clinic_id", staff.clinicId)
      .select("*")
      .single();
    if (error || !data) throw new ApiError(404, "Shifokor topilmadi");
    return ok({ doctor: data });
  } catch (e) {
    return handleApiError(e);
  }
}