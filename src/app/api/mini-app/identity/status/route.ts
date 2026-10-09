import type { NextRequest } from "next/server";
import { z } from "zod";
import { handleApiError, ok } from "@/lib/api/errors";
import { requireMiniAppPatientWith } from "@/lib/patients/mini-app-patient";
import { onlineProfile } from "@/lib/patients/online-identity";
import { getHealthTranscriptionProvider } from "@/lib/transcription/provider";

export const dynamic = "force-dynamic";

const schema = z.object({ initData: z.string().nullable().optional() });

/** Whether this Telegram patient's online identity is complete, with their OWN details when it is. */
export async function POST(request: NextRequest) {
  try {
    const { clinic, patient } = await requireMiniAppPatientWith(request, "mini-app-identity", schema);
    const profile = await onlineProfile(clinic.id, patient.id);
    return ok({
      required: clinic.online_identity_required === true,
      profile: profile.complete ? profile : null,
      // Whether the concern step may offer a microphone (an allowed local speech service is configured).
      voiceAvailable: getHealthTranscriptionProvider() !== null,
    });
  } catch (e) {
    return handleApiError(e);
  }
}
