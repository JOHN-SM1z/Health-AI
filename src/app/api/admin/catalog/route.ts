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

const faqSchema = z.object({
  question: z.string().min(2).max(500),
  answer: z.string().min(2).max(3000),
  category: z.string().max(100).optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

const settingSchema = z.object({
  key: z.string().min(1).max(100),
  value: z.record(z.string(), z.unknown()),
});

async function createForTable(
  request: NextRequest,
  table: "specialties" | "faq_entries",
  body: unknown,
) {
  const staff = await requireStaff("admin");
  const supabase = createAdminClient();

  if (table === "specialties") {
    const s = body as z.infer<typeof specialtySchema>;
    const { data, error } = await supabase
      .from("specialties")
      .insert({
        clinic_id: staff.clinicId,
        name: s.name,
        description: s.description ?? null,
        active: s.active ?? true,
        sort_order: s.sortOrder ?? 0,
      })
      .select("*")
      .single();
    if (error) {
      if (error.code === "23505") throw new ApiError(409, "Bunday yo‘nalish allaqachon mavjud", "duplicate");
      throw new ApiError(500, "Yaratib bo‘lmadi");
    }
    return ok({ row: data }, { status: 201 });
  }

  const f = body as z.infer<typeof faqSchema>;
  const { data, error } = await supabase
    .from("faq_entries")
    .insert({
      clinic_id: staff.clinicId,
      question: f.question,
      answer: f.answer,
      category: f.category ?? null,
      active: f.active ?? true,
      sort_order: f.sortOrder ?? 0,
    })
    .select("*")
    .single();
  if (error) throw new ApiError(500, "Yaratib bo‘lmadi");
  return ok({ row: data }, { status: 201 });
}

// POST /api/admin/specialties | /api/admin/faqs — create
export async function POST(request: NextRequest) {
  try {
    const path = request.nextUrl.pathname;
    if (path.includes("/specialties")) {
      return await createForTable(request, "specialties", await parseBody(request, specialtySchema));
    }
    return await createForTable(request, "faq_entries", await parseBody(request, faqSchema));
  } catch (e) {
    return handleApiError(e);
  }
}

// PATCH /api/admin/specialties?id=.. | /api/admin/faqs?id=.. — update
export async function PATCH(request: NextRequest) {
  try {
    const staff = await requireStaff("admin");
    const id = request.nextUrl.searchParams.get("id");
    if (!id) throw new ApiError(400, "id parametri kerak", "missing_id");
    const supabase = createAdminClient();
    const path = request.nextUrl.pathname;

    if (path.includes("/specialties")) {
      const body = await parseBody(request, specialtySchema.partial());
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
    }

    const body = await parseBody(request, faqSchema.partial());
    const { data, error } = await supabase
      .from("faq_entries")
      .update({
        question: body.question,
        answer: body.answer,
        category: body.category ?? null,
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

// DELETE /api/admin/faqs?id=.. — delete (specialties are deactivated, not deleted)
export async function DELETE(request: NextRequest) {
  try {
    const staff = await requireStaff("admin");
    const id = request.nextUrl.searchParams.get("id");
    if (!id) throw new ApiError(400, "id parametri kerak", "missing_id");
    const supabase = createAdminClient();

    if (request.nextUrl.pathname.includes("/faqs")) {
      const { error } = await supabase.from("faq_entries").delete().eq("id", id).eq("clinic_id", staff.clinicId);
      if (error) throw new ApiError(500, "O‘chirib bo‘lmadi");
      return ok({ deleted: true });
    }

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

// POST /api/admin/settings — owner-only clinic settings
export async function PUT(request: NextRequest) {
  try {
    const staff = await requireStaff("owner");
    const body = await parseBody(request, settingSchema);
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("app_settings")
      .upsert(
        { clinic_id: staff.clinicId, key: body.key, value: body.value as never, updated_by: staff.profileId },
        { onConflict: "clinic_id,key" },
      )
      .select("*")
      .single();
    if (error) throw new ApiError(500, "Sozlamani saqlab bo‘lmadi");
    return ok({ setting: data });
  } catch (e) {
    return handleApiError(e);
  }
}