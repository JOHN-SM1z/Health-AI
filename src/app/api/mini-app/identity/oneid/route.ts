import type { NextRequest } from "next/server";
import { z } from "zod";
import { handleApiError, ok } from "@/lib/api/errors";
import { requireMiniAppPatientWith } from "@/lib/patients/mini-app-patient";
import { oneIdAttempt, startOneId } from "@/lib/identity/oneid";
import { onlineProfile } from "@/lib/patients/online-identity";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const schema = z.object({ initData: z.string().nullable().optional(), action: z.enum(["start", "poll"]) });

/**
 * OneID from the Mini App. "start" returns the OneID sign-in URL (opened outside Telegram's webview); "poll" says how
 * the latest attempt ended and, once verified, returns the patient's OWN details as the state confirmed them.
 */
export async function POST(request: NextRequest) {
  try {
    const { clinic, patient, body } = await requireMiniAppPatientWith(request, "mini-app-identity", schema);
    if (body.action === "start") return ok(await startOneId(clinic.id, patient));
    const attempt = patient.telegram_user_id ? await oneIdAttempt(clinic.id, patient.telegram_user_id) : null;
    const done = attempt?.outcome === "verified" || attempt?.outcome === "linked";
    // A linked card is now this Telegram user's: read it fresh (the session's patient may have been the empty record).
    const profile = done ? await profileForTelegram(clinic.id, patient.telegram_user_id!, patient.id) : null;
    return ok({ pending: attempt?.pending ?? false, outcome: attempt?.outcome ?? null, profile });
  } catch (e) {
    return handleApiError(e);
  }
}

async function profileForTelegram(clinicId: string, telegramUserId: number, fallbackId: string) {
  const { data } = await createAdminClient().from("patients").select("id").eq("clinic_id", clinicId).eq("telegram_user_id", telegramUserId).maybeSingle();
  return onlineProfile(clinicId, data?.id ?? fallbackId);
}
