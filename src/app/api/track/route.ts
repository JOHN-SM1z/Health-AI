import type { NextRequest } from "next/server";
import { z } from "zod";
import { getClinicFromRequest } from "@/lib/clinics/context";
import { resolvePatientFromInitData, devIdentityAllowed } from "@/lib/patients/identity";
import { handleApiError, ApiError, fail, ok } from "@/lib/api/errors";
import { rateLimit, keyFromIp } from "@/lib/rate-limit";
import { trackAnalytics } from "@/lib/analytics";

export const dynamic = "force-dynamic";

const schema = z.object({
  initData: z.string().min(1),
  eventType: z.string().min(2).max(100),
  payload: z.record(z.string(), z.unknown()).optional(),
});

const ALLOWED_EVENT_TYPES = [
  "booking_started",
  "booking_success",
  "booking_slot_taken",
  "booking_abandoned",
  "navigation_started",
];

/**
 * Client-side event tracking. The identity is still verified server-side
 * from initData, and only allow-listed event names are accepted, so the
 * browser cannot write arbitrary analytics rows.
 */
export async function POST(request: NextRequest) {
  try {
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const limit = rateLimit({ key: keyFromIp(ip, "track"), limit: 60, windowMs: 60_000 });
    if (!limit.ok) return fail("Juda ko‘p so‘rov", 429, "rate_limited");

    const body = schema.parse(await request.json());
    if (!ALLOWED_EVENT_TYPES.includes(body.eventType)) {
      throw new ApiError(400, "Ruxsat etilmagan hodisa turi", "event_type_not_allowed");
    }
    if (body.initData === "dev" && !devIdentityAllowed()) {
      throw new ApiError(403, "Development identity is not allowed", "dev_identity_forbidden");
    }

    const clinic = await getClinicFromRequest(request);
    const resolved = await resolvePatientFromInitData(body.initData, clinic.id);
    if (!resolved) throw new ApiError(401, "Telegram identifikatori tasdiqlanmadi", "invalid_init_data");

    await trackAnalytics({
      clinicId: clinic.id,
      patientId: resolved.patient.id,
      eventType: body.eventType,
      payload: body.payload,
    });

    return ok({ tracked: true });
  } catch (e) {
    return handleApiError(e);
  }
}