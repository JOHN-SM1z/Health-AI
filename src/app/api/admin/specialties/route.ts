import type { NextRequest } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStaff } from "@/lib/auth/guards";
import { parseBody } from "@/lib/api/validate";
import { handleApiError, ApiError, ok } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

const specialtySchema = z.object({
  name: z.string().min(2).max(120),
  description: z.string().max(500).optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

// POST /api/admin/specialties — create
export async function POST(request: NextRequest) {
  try {
    const staff = await requireStaff("admin");
    const body = await parseBody(request, specialtySchema);
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("specialties")
      .insert({
        clinic_id: staff.clinicId,
        name: body.name,
        description: body.description ?? null,
        active: body.active ?? true,
        sort_order: body.sortOrder ?? 0,
      })
      .select("*")
      .single();
    if (error) {
      if (error.code === "23505") throw new ApiError(409, "Bunday yo‘nalish allaqachon mavjud", "duplicate");
      throw new ApiError(500, "Yaratib bo‘lmadi");
    }
    return ok({ row: data }, { status: 201 });
  } catch (e) {
    return handleApiError(e);
  }
}

// PATCH /api/admin/specialties?id=.. — update
export async function PATCH(request: NextRequest) {
  try {
    const staff = await requireStaff("admin");
    const id = request.nextUrl.searchParams.get("id");
    if (!id) throw new ApiError(400, "id parametri kerak", "missing_id");
    const body = await parseBody(request, specialtySchema.partial());
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("specialties")
      .update({
        name: body.name,
        description: body.description ?? null,
        active: body.active,
        sort_order: body.sortOrder,
      })
      .eq("id", id)
      .eq("clinic_id", staff.clinicId)
      .select("*")
      .single();
    if (error || !data) throw new ApiError(404, "Topilmadi");
    return ok({ row: data });
  } catch (e) {
    return handleApiError(e);
  }
}

// DELETE /api/admin/specialties?id=.. — specialties are referenced by
// services/doctors, so deletion deactivates rather than removes the row.
export async function DELETE(request: NextRequest) {
  try {
    const staff = await requireStaff("admin");
    const id = request.nextUrl.searchParams.get("id");
    if (!id) throw new ApiError(400, "id parametri kerak", "missing_id");
    const supabase = createAdminClient();
    const { error } = await supabase
      .from("specialties")
      .update({ active: false })
      .eq("id", id)
      .eq("clinic_id", staff.clinicId);
    if (error) throw new ApiError(500, "O‘chirib bo‘lmadi");
    return ok({ deleted: true });
  } catch (e) {
    return handleApiError(e);
  }
}
