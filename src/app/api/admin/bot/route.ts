import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireStaff } from "@/lib/auth/guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseBody } from "@/lib/api/validate";
import { handleApiError, ok } from "@/lib/api/errors";
import { activateClinicBot, deactivateClinicBot } from "@/lib/telegram/bot-admin";

export const dynamic = "force-dynamic";

const activateSchema = z.object({
  action: z.enum(["activate", "deactivate"]),
  telegramBotToken: z.string().max(300).optional(),
});

/**
 * Per-clinic Telegram bot management (management role only).
 *
 * The token is accepted ONCE from the operator and stored server-side in
 * clinic_telegram_integrations (zero RLS policies — SQL clients can never
 * read it). It is never returned by any endpoint.
 */
export async function POST(request: NextRequest) {
  try {
    const staff = await requireStaff("admin");
    const body = await parseBody(request, activateSchema);

    if (body.action === "deactivate") {
      await deactivateClinicBot(staff.clinicId);
      return ok({ ok: true, status: "disabled" });
    }

    if (!body.telegramBotToken) {
      throw new Error("telegramBotToken required for activation");
    }
    const result = await activateClinicBot(staff.clinicId, body.telegramBotToken);
    if (!result.ok) throw new Error(result.error ?? "activation failed");
    return ok({
      ok: true,
      username: result.username,
      name: result.name,
      webhookOk: result.webhookOk,
      webhookError: result.webhookError,
    });
  } catch (e) {
    return handleApiError(e);
  }
}

/** Current integration state — deliberately WITHOUT the bot token. */
export async function GET() {
  try {
    const staff = await requireStaff("admin");
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("clinic_telegram_integrations")
      .select(
        "telegram_bot_id, telegram_username, telegram_bot_name, status, enabled, webhook_status, webhook_error, last_error, validated_at",
      )
      .eq("clinic_id", staff.clinicId)
      .maybeSingle();
    if (error) throw new Error("integration read failed");
    return ok({ integration: data ?? null });
  } catch (e) {
    return handleApiError(e);
  }
}