import type { NextRequest } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRoles } from "@/lib/auth/guards";
import { parseBody } from "@/lib/api/validate";
import { handleApiError, ApiError, ok } from "@/lib/api/errors";
import { recordAudit } from "@/lib/audit";
import { sendTelegramMessage } from "@/lib/telegram/bot";
import { appendMessage } from "@/lib/telegram/store";
import { trackAnalytics } from "@/lib/analytics";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const takeoverSchema = z.object({ action: z.enum(["takeover", "release", "mark_seen"]) });
const messageSchema = z.object({ text: z.string().trim().min(1).max(3000) });

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Admin takes over / releases a bot conversation. While held, the bot's
 * automated replies are paused (conversation.status = 'assigned').
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireRoles("owner", "admin", "manager", "receptionist");
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

    // Read tracking: viewing a conversation marks every patient message up to
    // now as read. No state change, so no CAS needed.
    if (body.action === "mark_seen") {
      const { error: seenError } = await supabase
        .from("conversations")
        .update({ admin_seen_at: new Date().toISOString() })
        .eq("id", id);
      if (seenError) throw new ApiError(500, "Ko‘rilgan belgisini yangilab bo‘lmadi");
      return ok({ updated: true });
    }

    const isTakeover = body.action === "takeover";
    // Compare-and-swap: a takeover only wins on an open (unheld) conversation,
    // so two operators can never both claim it.
    const { data: claimed, error } = await supabase
      .from("conversations")
      .update({
        status: isTakeover ? "assigned" : "open",
        ai_enabled: !isTakeover,
        taken_over_by: isTakeover ? staff.profileId : null,
        taken_over_at: isTakeover ? new Date().toISOString() : null,
        released_at: isTakeover ? null : new Date().toISOString(),
      })
      .eq("id", id)
      .eq("status", isTakeover ? "open" : "assigned")
      .select("id")
      .maybeSingle();
    if (error) throw new ApiError(500, "Suhbat holatini yangilab bo‘lmadi");
    if (!claimed) {
      throw new ApiError(409, "Suhbat boshqa operator tomonidan qabul qilingan", "conversation_already_held");
    }

    await recordAudit({
      clinicId: staff.clinicId,
      action: isTakeover ? "conversation_takeover" : "conversation_release",
      entityType: "conversations",
      entityId: id,
      actor: { actorId: staff.profileId, actorType: "staff" },
    });

    // Acknowledge to the patient in Telegram — via the conversation's own
    // clinic bot, never a shared global bot.
    if (isTakeover && conversation.patient_id) {
      const { data: patient } = await supabase
        .from("patients")
        .select("telegram_user_id")
        .eq("id", conversation.patient_id)
        .single();
      if (patient?.telegram_user_id) {
        await sendTelegramMessage(
          {
            chatId: patient.telegram_user_id,
            text: "Operatorlarimiz suhbatga ulandi. Endi operator javob beradi. 👨‍💼",
          },
          conversation.clinic_id,
        );
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
    const staff = await requireRoles("owner", "admin", "manager", "receptionist");
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

    // One authoritative mode: an operator reply is only valid while this
    // operator still holds the conversation. A stale browser session (or a
    // second operator) must not send after takeover ended.
    if (conversation.status !== "assigned") {
      throw new ApiError(409, "Suhbat endi operator qo‘lida emas", "conversation_not_held");
    }

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
      telegramMessageId = await sendTelegramMessage(
        { chatId: patient.telegram_user_id, text: body.text },
        conversation.clinic_id,
      );
    }

    logger.info("admin message stored", { conversationId: id, delivered: telegramMessageId !== null });
    return ok({ sent: true, telegramMessageId });
  } catch (e) {
    return handleApiError(e);
  }
}