import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireRoles } from "@/lib/auth/guards";
import { getAvailability } from "@/lib/booking/availability";
import { handleApiError, ok } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  serviceId: z.string().uuid().optional(),
  doctorId: z.string().uuid().optional(),
  days: z.coerce.number().int().min(1).max(30).default(14),
});

/**
 * Staff-side availability for the admin quick-booking flow — same real
 * schedule computation as the public /api/availability, but clinic comes
 * from the authenticated staff session (never a client-supplied id), so a
 * receptionist can never be shown another clinic's doctors or schedule.
 */
export async function GET(request: NextRequest) {
  try {
    const ctx = await requireRoles("owner", "admin", "manager", "receptionist");
    const query = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const { serviceDurationMinutes, slots } = await getAvailability({
      clinicId: ctx.clinicId,
      timezone: ctx.clinicTimezone,
      ...query,
    });

    return ok({ timezone: ctx.clinicTimezone, serviceDurationMinutes, slots });
  } catch (e) {
    return handleApiError(e);
  }
}
