import type { NextRequest } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStaff } from "@/lib/auth/guards";
import { parseBody } from "@/lib/api/validate";
import { handleApiError, ApiError, ok } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

const settingSchema = z.object({
  key: z.string().min(1).max(100),
  value: z.record(z.string(), z.unknown()),
});

// PUT /api/admin/settings — upsert a clinic text setting (owner/admin/manager)
export async function PUT(request: NextRequest) {
  try {
    const staff = await requireStaff("admin");
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
