import type { NextRequest } from "next/server";
import { z } from "zod";
import { getClinicFromRequest } from "@/lib/clinics/context";
import { getAvailability } from "@/lib/booking/availability";
import { handleApiError, fail, ok } from "@/lib/api/errors";
import { rateLimit, keyFromIp } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  serviceId: z.string().uuid().optional(),
  doctorId: z.string().uuid().optional(),
  days: z.coerce.number().int().min(1).max(30).default(14),
});

/**
 * Public, unauthenticated availability for the patient-facing booking flow
 * (Mini App / web). Clinic comes from the request's own ?clinic= URL (see
 * getClinicFromRequest) — this endpoint is intentionally reachable without a
 * session, so it must never be the model for a staff-facing caller; see
 * /api/admin/availability for that (clinic from the staff session instead).
 */
export async function GET(request: NextRequest) {
  try {
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const limit = rateLimit({ key: keyFromIp(ip, "availability"), limit: 60, windowMs: 10_000 });
    if (!limit.ok) return fail("Juda ko‘p so‘rov", 429, "rate_limited");

    const query = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
    if (!query.success) return fail("Noto‘g‘ri so‘rov parametrlari", 400, "validation");

    const clinic = await getClinicFromRequest(request);
    const { serviceDurationMinutes, slots } = await getAvailability({
      clinicId: clinic.id,
      timezone: clinic.timezone,
      ...query.data,
    });

    return ok({
      timezone: clinic.timezone,
      serviceDurationMinutes,
      slots,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    return handleApiError(e);
  }
}