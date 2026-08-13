
import type { NextRequest } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStaff } from "@/lib/auth/guards";
import { parseBody } from "@/lib/api/validate";
import { handleApiError, ApiError, ok } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Doctor self-service time blocks (own breaks)
// ---------------------------------------------------------------------------

const breakSchema = z.object({
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  reason: z.enum(["break", "absence"]),
});

export async function POST(request: NextRequest) {
  try {
    const staff = await requireStaff("doctor");
    const body = await parseBody(request, breakSchema);
    const supabase = createAdminClient();

    const { data: doctor } = await supabase
      .from("doctors")
      .select("id")
      .eq("profile_id", staff.profileId)
      .eq("clinic_id", staff.clinicId)
      .eq("active", true)
      .maybeSingle();
    if (!doctor) throw new ApiError(403, "Sizning shifokor hisobingiz topilmadi", "doctor_not_linked");

    if (new Date(body.endsAt) <= new Date(body.startsAt)) {
      throw new ApiError(400, "Vaqt oralig‘i noto‘g‘ri", "bad_range");
    }

    const { data, error } = await supabase
      .from("doctor_time_blocks")
      .insert({
        clinic_id: staff.clinicId,
        doctor_id: doctor.id,
        starts_at: body.startsAt,
        ends_at: body.endsAt,
        reason: body.reason,
        note: "Shifokor tomonidan qo‘shildi",
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