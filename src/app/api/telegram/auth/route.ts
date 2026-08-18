import type { NextRequest } from "next/server";
import { z } from "zod";
import { getClinicFromRequest } from "@/lib/clinics/context";
import { resolvePatientFromInitData, devIdentityAllowed } from "@/lib/patients/identity";
import { handleApiError, ApiError, ok, fail } from "@/lib/api/errors";
import { rateLimit, keyFromIp } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const schema = z.object({
  initData: z.string().nullable().optional(),
});

/**
 * Server-side verification of the Telegram Mini App identity.
 * The browser never tells us who the patient is — the initData signature is
 * verified against the bot token here, and the patient row is resolved from
 * the verified Telegram user id.
 */
export async function POST(request: NextRequest) {
  try {
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const limit = rateLimit({ key: keyFromIp(ip, "tg-auth"), limit: 30, windowMs: 10_000 });
    if (!limit.ok) {
      return fail("Juda ko‘p so‘rov", 429, "rate_limited");
    }

    const body = schema.parse(await request.json());
    if (body.initData === "dev" && !devIdentityAllowed()) {
      throw new ApiError(403, "Development identity is not allowed", "dev_identity_forbidden");
    }

    const clinic = await getClinicFromRequest(request);
    const resolved = await resolvePatientFromInitData(body.initData, clinic.id);

    if (!resolved) {
      return fail("Telegram identifikatori tasdiqlanmadi", 401, "invalid_init_data");
    }

    return ok({
      patientId: resolved.patient.id,
      dev: resolved.dev,
      consentGiven: resolved.patient.consent_given,
      clinicId: clinic.id,
      clinicName: clinic.name,
    });
  } catch (e) {
    return handleApiError(e);
  }
}