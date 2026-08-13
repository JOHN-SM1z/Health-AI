import type { NextRequest } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStaff } from "@/lib/auth/guards";
import { handleApiError, ApiError, ok } from "@/lib/api/errors";
import { uuidSchema, parseBody } from "@/lib/api/validate";

export const dynamic = "force-dynamic";

const serviceSchema = z.object({
  name: z.string().min(2).max(120),
  specialtyId: uuidSchema.optional(),
  description: z.string().max(500).optional(),
  durationMinutes: z.number().int().min(5).max(480),
  price: z.number().min(0),
  preparationText: z.string().max(1000).optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  doctorIds: z.array(uuidSchema).optional(),
});

const serviceUpdateSchema = serviceSchema.partial();

export async function POST(request: NextRequest) {
  try {
    const staff = await requireStaff("admin");
    const body = await parseBody(request, serviceSchema);
    const supabase = createAdminClient();

    const { data, error } = await supabase
      .from("services")
      .insert({
        clinic_id: staff.clinicId,
        name: body.name,
        specialty_id: body.specialtyId ?? null,
        description: body.description ?? null,
        duration_minutes: body.durationMinutes,
        price: body.price,
        preparation_text: body.preparationText ?? null,
        active: body.active ?? true,
        sort_order: body.sortOrder ?? 0,
      })
      .select("*")
      .single();
    if (error) {
      if (error.code === "23505") throw new ApiError(409, "Bunday xizmat allaqachon mavjud", "duplicate");
      throw new ApiError(500, "Xizmatni yaratib bo‘lmadi");
    }

    if (body.doctorIds && body.doctorIds.length > 0) {
      await supabase.from("doctor_services").insert(
        body.doctorIds.map((doctorId) => ({ doctor_id: doctorId, service_id: data.id })),
      );
    }

    return ok({ service: data }, { status: 201 });
  } catch (e) {
    return handleApiError(e);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const staff = await requireStaff("admin");
    const body = await parseBody(request, serviceUpdateSchema);
    const id = request.nextUrl.searchParams.get("id");
    if (!id) throw new ApiError(400, "id parametri kerak", "missing_id");
    const supabase = createAdminClient();

    const { data, error } = await supabase
      .from("services")
      .update({
        name: body.name,
        specialty_id: body.specialtyId ?? null,
        description: body.description ?? null,
        duration_minutes: body.durationMinutes,
        price: body.price,
        preparation_text: body.preparationText ?? null,
        active: body.active,
        sort_order: body.sortOrder,
      })
      .eq("id", id)
      .eq("clinic_id", staff.clinicId)
      .select("*")
      .single();
    if (error || !data) throw new ApiError(404, "Xizmat topilmadi");

    if (body.doctorIds) {
      await supabase.from("doctor_services").delete().eq("service_id", id);
      if (body.doctorIds.length > 0) {
        await supabase
          .from("doctor_services")
          .insert(body.doctorIds.map((doctorId) => ({ doctor_id: doctorId, service_id: id })));
      }
    }

    return ok({ service: data });
  } catch (e) {
    return handleApiError(e);
  }
}