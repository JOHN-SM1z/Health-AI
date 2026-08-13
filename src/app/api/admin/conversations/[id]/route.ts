import type { NextRequest } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStaff } from "@/lib/auth/guards";
import { parseBody } from "@/lib/api/validate";
import { handleApiError, ApiError, ok } from "@/lib/api/errors";
import { recordAudit } from "@/lib/audit";
import { sendTelegramMessage } from "@/lib/telegram/bot";
import { appendMessage } from "@/lib/telegram/store";
import { trackAnalytics } from "@/lib/analytics";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const takeoverSchema = z.object({ action: z.enum(["takeover", "release"]) });
const messageSchema = z.object({ text: z.string().min(1).max(3000) });

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Admin takes over / releases a bot conversation. While held, the bot's
 * automated replies are paused (conversation.status = 'assigned').
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireStaff("admin");
    const { id } = await ctx.params;
    const body = await parseBody(request, takeoverSchema);
    const supabase = createAdminClient();

    const { data: conversation, error: fetchError } = await supabase
      .from("conversations")
      .select("*")
      .eq("id", id)
      .eq("clinic_id", staff.clinicId)
      .maybeSingle();
    if (fetchError || !conversation) throw new ApiError(404, "Suhbat topilmadi", "conversation_not_found");

    const isTakeover = body.action === "takeover";
    const { error } = await supabase
      .from("conversations")
      .update({
        status: isTakeover ? "assigned" : "open",
        ai_enabled: !isTakeover,
        taken_over_by: isTakeover ? staff.profileId : null,
        taken_over_at: isTakeover ? new Date().toISOString() : null,
        released_at: isTakeover ? null : new Date().toISOString(),
      })
      .eq("id", id);
    if (error) throw new ApiError(500, "Suhbat holatini yangilab bo‘lmadi");

    await recordAudit({
      clinicId: staff.clinicId,
      action: isTakeover ? "conversation_takeover" : "conversation_release",
      entityType: "conversations",
      entityId: id,
      actor: { actorId: staff.profileId, actorType: "staff" },
    });

    // Acknowledge to the patient in Telegram.
    if (isTakeover && conversation.patient_id) {
      const { data: patient } = await supabase
        .from("patients")
        .select("telegram_user_id")
        .eq("id", conversation.patient_id)
        .single();
      if (patient?.telegram_user_id) {
        await sendTelegramMessage({
          chatId: patient.telegram_user_id,
          text: "Operatorlarimiz suhbatga ulandi. Endi operator javob beradi. 👨‍💼",
        });
        await appendMessage({
          conversationId: id,
          clinicId: staff.clinicId,
          role: "admin",
          type: "system",
          content: "Operator suhbatni qabul qildi",
        });
        await trackAnalytics({ clinicId: staff.clinicId, patientId: conversation.patient_id, eventType: "human_takeover" });
      }
    }

    return ok({ updated: true, status: isTakeover ? "assigned" : "open" });
  } catch (e) {
    return handleApiError(e);
  }
}

/** Admin reply inside a conversation — sent via Telegram when possible. */
export async function PUT(request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireStaff("admin");
    const { id } = await ctx.params;
    const body = await parseBody(request, messageSchema);
    const supabase = createAdminClient();

    const { data: conversation, error: fetchError } = await supabase
      .from("conversations")
      .select("clinic_id, patient_id, status")
      .eq("id", id)
      .eq("clinic_id", staff.clinicId)
      .maybeSingle();
    if (fetchError || !conversation) throw new ApiError(404, "Suhbat topilmadi", "conversation_not_found");

    await appendMessage({
      conversationId: id,
      clinicId: staff.clinicId,
      role: "admin",
      type: "text",
      content: body.text,
    });

    const { data: patient } = await supabase
      .from("patients")
      .select("telegram_user_id")
      .eq("id", conversation.patient_id)
      .single();

    let telegramMessageId: number | null = null;
    if (patient?.telegram_user_id) {
      telegramMessageId = await sendTelegramMessage({ chatId: patient.telegram_user_id, text: body.text });
    }

    logger.info("admin message stored", { conversationId: id, delivered: telegramMessageId !== null });
    return ok({ sent: true, telegramMessageId });
  } catch (e) {
    return handleApiError(e);
  }
}