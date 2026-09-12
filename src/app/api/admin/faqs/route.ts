import type { NextRequest } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStaff } from "@/lib/auth/guards";
import { parseBody } from "@/lib/api/validate";
import { handleApiError, ApiError, ok } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

const faqSchema = z.object({
  question: z.string().min(2).max(500),
  answer: z.string().min(2).max(3000),
  category: z.string().max(100).optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

// POST /api/admin/faqs — create
export async function POST(request: NextRequest) {
  try {
    const staff = await requireStaff("admin");
    const body = await parseBody(request, faqSchema);
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("faq_entries")
      .insert({
        clinic_id: staff.clinicId,
        question: body.question,
        answer: body.answer,
        category: body.category ?? null,
        active: body.active ?? true,
        sort_order: body.sortOrder ?? 0,
      })
      .select("*")
      .single();
    if (error) throw new ApiError(500, "Yaratib bo‘lmadi");
    return ok({ row: data }, { status: 201 });
  } catch (e) {
    return handleApiError(e);
  }
}

// PATCH /api/admin/faqs?id=.. — update
export async function PATCH(request: NextRequest) {
  try {
    const staff = await requireStaff("admin");
    const id = request.nextUrl.searchParams.get("id");
    if (!id) throw new ApiError(400, "id parametri kerak", "missing_id");
    const body = await parseBody(request, faqSchema.partial());
    const supabase = createAdminClient();
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

// DELETE /api/admin/faqs?id=.. — delete
export async function DELETE(request: NextRequest) {
  try {
    const staff = await requireStaff("admin");
    const id = request.nextUrl.searchParams.get("id");
    if (!id) throw new ApiError(400, "id parametri kerak", "missing_id");
    const supabase = createAdminClient();
    const { error } = await supabase.from("faq_entries").delete().eq("id", id).eq("clinic_id", staff.clinicId);
    if (error) throw new ApiError(500, "O‘chirib bo‘lmadi");
    return ok({ deleted: true });
  } catch (e) {
    return handleApiError(e);
  }
}
