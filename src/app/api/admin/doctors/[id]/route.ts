import type { NextRequest } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStaff } from "@/lib/auth/guards";
import { parseBody } from "@/lib/api/validate";
import { handleApiError, ApiError, ok } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

const workingHoursSchema = z.object({
  // Full weekly schedule replacement: [{ weekday: 1..7, start: "09:00", end: "18:00" }]
  schedule: z.array(
    z.object({
      weekday: z.number().int().min(1).max(7),
      start: z.string().regex(/^\d{2}:\d{2}$/),
      end: z.string().regex(/^\d{2}:\d{2}$/),
    }),
  ),
});

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Replaces a doctor's weekly working hours. Admin/owner only.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireStaff("admin");
    const { id } = await ctx.params;
    const body = await parseBody(request, workingHoursSchema);
    const supabase = createAdminClient();

    const { data: doctor } = await supabase
      .from("doctors")
      .select("id")
      .eq("id", id)
      .eq("clinic_id", staff.clinicId)
      .maybeSingle();
    if (!doctor) throw new ApiError(404, "Shifokor topilmadi");

    // Validate ranges server-side.
    for (const w of body.schedule) {
      if (w.start >= w.end) {
        throw new ApiError(400, "Ish vaqti tugashi boshlanishidan keyin bo‘lishi kerak", "bad_range");
      }
    }

    const { error: deleteError } = await supabase
      .from("doctor_working_hours")
      .delete()
      .eq("doctor_id", id);
    if (deleteError) throw new ApiError(500, "Jadvalni yangilab bo‘lmadi");

    if (body.schedule.length > 0) {
      const rows = body.schedule.map((w) => ({
        clinic_id: staff.clinicId,
        doctor_id: id,
        weekday: w.weekday,
        start_time: w.start,
        end_time: w.end,
      }));
      const { error: insertError } = await supabase.from("doctor_working_hours").insert(rows);
      if (insertError) throw new ApiError(500, "Jadvalni saqlab bo‘lmadi");
    }

    return ok({ updated: true, count: body.schedule.length });
  } catch (e) {
    return handleApiError(e);
  }
}

// ---------------------------------------------------------------------------
// Time blocks
// ---------------------------------------------------------------------------

const timeBlockSchema = z.object({
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  reason: z.enum(["break", "absence", "reservation", "admin_hold"]),
  note: z.string().max(300).optional(),
});

/** Creates a time block (break/absence/admin hold) for a doctor. */
export async function PUT(request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireStaff("admin");
    const { id } = await ctx.params;
    const body = await parseBody(request, timeBlockSchema);
    const supabase = createAdminClient();

    if (new Date(body.endsAt) <= new Date(body.startsAt)) {
      throw new ApiError(400, "Vaqt oralig‘i noto‘g‘ri", "bad_range");
    }

    const { data: doctor } = await supabase
      .from("doctors")
      .select("id")
      .eq("id", id)
      .eq("clinic_id", staff.clinicId)
      .maybeSingle();
    if (!doctor) throw new ApiError(404, "Shifokor topilmadi");

    const { data, error } = await supabase
      .from("doctor_time_blocks")
      .insert({
        clinic_id: staff.clinicId,
        doctor_id: id,
        starts_at: body.startsAt,
        ends_at: body.endsAt,
        reason: body.reason,
        note: body.note ?? null,
        created_by: staff.profileId,
      })
      .select("*")
      .single();
    if (error) throw new ApiError(500, "Vaqt blokini yaratib bo‘lmadi");
    return ok({ block: data }, { status: 201 });
  } catch (e) {
    return handleApiError(e);
  }
}

/** Removes a time block for a doctor. */
export async function DELETE(request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireStaff("admin");
    const { id } = await ctx.params;
    const blockId = request.nextUrl.searchParams.get("blockId") || id;
    const supabase = createAdminClient();
    const { error } = await supabase
      .from("doctor_time_blocks")
      .delete()
      .eq("id", blockId)
      .eq("clinic_id", staff.clinicId);
    if (error) throw new ApiError(500, "Blokni o‘chirib bo‘lmadi");
    return ok({ deleted: true });
  } catch (e) {
    return handleApiError(e);
  }
}