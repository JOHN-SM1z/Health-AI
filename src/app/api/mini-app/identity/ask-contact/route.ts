import type { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { requireMiniAppPatientWith } from "@/lib/patients/mini-app-patient";
import { sendTelegramMessage } from "@/lib/telegram/bot";
import { sharedRateLimit } from "@/lib/rate-limit-shared";

export const dynamic = "force-dynamic";

const schema = z.object({ initData: z.string().nullable().optional() });

/**
 * Fallback when the Mini App cannot ask for the phone itself: the clinic's bot sends the patient a one-tap
 * "share my number" button in their chat. Telegram then sends the patient's own contact to the webhook.
 */
export async function POST(request: NextRequest) {
  try {
    const { clinic, patient } = await requireMiniAppPatientWith(request, "mini-app-identity", schema);
    if (!patient.telegram_user_id) throw new ApiError(401, "Telegram identifikatori tasdiqlanmadi", "invalid_init_data");
    const limit = await sharedRateLimit({ key: `online-identity:ask:${clinic.id}:${patient.telegram_user_id}`, limit: 5, windowMs: 3_600_000 });
    if (!limit.ok) throw new ApiError(429, "Juda ko‘p so‘rov", "rate_limited");
    const sent = await sendTelegramMessage(
      {
        chatId: patient.telegram_user_id,
        text: "Telefon raqamingizni tasdiqlash uchun pastdagi tugmani bosing.",
        replyMarkup: { keyboard: [[{ text: "📱 Raqamni ulashish", request_contact: true }]], resize_keyboard: true, one_time_keyboard: true },
      },
      clinic.id,
    );
    return ok({ sent: sent !== null });
  } catch (e) {
    return handleApiError(e);
  }
}
