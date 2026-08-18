import type { NextRequest } from "next/server";
import { z } from "zod";
import { requirePlatformAdmin } from "@/lib/auth/guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseBody } from "@/lib/api/validate";
import { handleApiError, ok } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

/**
 * Platform-level clinic administration (Health AI staff only).
 * Lists every clinic with its Telegram integration state, scoped to
 * platform admins server-side. Clinic data itself is never exposed here —
 * clinic operators manage their own clinic through the dashboard.
 */
export async function GET() {
  try {
    await requirePlatformAdmin();
    const supabase = createAdminClient();

    const { data: clinics, error } = await supabase
      .from("clinics")
      .select(
        `id, name, slug, timezone, is_active, created_at,
         clinic_telegram_integrations(status, enabled, telegram_username, webhook_status, validated_at)`,
      )
      .order("created_at", { ascending: true });

    if (error) throw new Error(`clinics_list_failed: ${error.message}`);

    return ok({ clinics: clinics ?? [] });
  } catch (e) {
    return handleApiError(e);
  }
}

const toggleSchema = z.object({ isActive: z.boolean() });

/** Deactivate/reactivate a clinic (tenant shutdown switch). */
export async function PATCH(request: NextRequest) {
  try {
    await requirePlatformAdmin();
    const body = await parseBody(request, toggleSchema);
    const supabase = createAdminClient();

    const { error } = await supabase
      .from("clinics")
      .update({ is_active: body.isActive })
      .eq("id", request.nextUrl.searchParams.get("id") ?? "");

    if (error) throw new Error(`clinic_update_failed: ${error.message}`);

    return ok({ updated: true });
  } catch (e) {
    return handleApiError(e);
  }
}
