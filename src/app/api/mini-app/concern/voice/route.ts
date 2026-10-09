import type { NextRequest } from "next/server";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { getClinicFromRequest } from "@/lib/clinics/context";
import { resolvePatientFromInitData, devIdentityAllowed } from "@/lib/patients/identity";
import { rateLimit, keyFromIp } from "@/lib/rate-limit";
import { sharedRateLimit } from "@/lib/rate-limit-shared";
import { getHealthTranscriptionProvider } from "@/lib/transcription/provider";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const MAX_BYTES = 1_000_000; // about a minute of compressed speech

/**
 * A spoken concern → text the patient reviews and can edit before it is routed (POST /api/mini-app/concern).
 * Explicit consent comes with the request; the audio goes only to an allowed local speech service
 * (getHealthTranscriptionProvider), is never stored, and is never logged. Without such a service: 503, and the
 * Mini App asks the patient to type.
 */
export async function POST(request: NextRequest) {
  try {
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    if (!rateLimit({ key: keyFromIp(ip, "mini-app-voice"), limit: 10, windowMs: 60_000 }).ok) {
      throw new ApiError(429, "Juda ko‘p so‘rov", "rate_limited");
    }
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new ApiError(400, "Noto‘g‘ri so‘rov formati", "bad_request");
    }
    const initData = form.get("initData");
    if (initData === "dev" && !devIdentityAllowed()) throw new ApiError(403, "Development identity is not allowed", "dev_identity_forbidden");
    const clinic = await getClinicFromRequest(request);
    const resolved = await resolvePatientFromInitData(typeof initData === "string" ? initData : null, clinic.id);
    if (!resolved) throw new ApiError(401, "Telegram identifikatori tasdiqlanmadi", "invalid_init_data");

    if (form.get("consent") !== "true") throw new ApiError(400, "Ovozli xabar uchun rozilik kerak", "consent_required");
    const provider = getHealthTranscriptionProvider();
    if (!provider) throw new ApiError(503, "Ovozli xabar hozircha ishlamaydi — iltimos, yozib yuboring", "voice_unavailable");

    const audio = form.get("audio");
    if (!(audio instanceof Blob) || audio.size === 0) throw new ApiError(400, "Ovoz yozuvi topilmadi", "audio_missing");
    if (audio.size > MAX_BYTES) throw new ApiError(413, "Yozuv juda uzun — 1 daqiqagacha gapiring", "audio_too_large");
    if (!/^audio\//.test(audio.type)) throw new ApiError(415, "Ovoz formati qo‘llab-quvvatlanmaydi", "audio_type");

    const shared = await sharedRateLimit({ key: `mini-app-voice:${clinic.id}:${resolved.patient.id}`, limit: 10, windowMs: 3_600_000 });
    if (!shared.ok) throw new ApiError(429, "Juda ko‘p so‘rov", "rate_limited");

    try {
      const extension = audio.type.includes("mp4") ? "m4a" : audio.type.includes("ogg") ? "ogg" : "webm";
      const result = await provider.transcribe({ file: Buffer.from(await audio.arrayBuffer()), mimeType: audio.type, fileName: `concern.${extension}` });
      return ok({ text: result.text.trim().slice(0, 300) });
    } catch (e) {
      logger.warn("concern transcription failed", { error: e instanceof Error ? e.message : "unknown" });
      throw new ApiError(502, "Ovozni matnga aylantirib bo‘lmadi — iltimos, yozib yuboring", "transcription_failed");
    }
  } catch (e) {
    return handleApiError(e);
  }
}
