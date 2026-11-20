import { handleApiError, ok } from "@/lib/api/errors";
import { requireRoles } from "@/lib/auth/guards";
import { RECEPTION_ROLES } from "@/lib/auth/staff";
import { listBookedVisits } from "@/lib/operations/outpatient";
import { clinicDateKey } from "@/lib/time/local";

export const dynamic = "force-dynamic";

/** Today's patients who paid online and have not arrived yet — reception marks them "Keldi". Name and phone only. */
export async function GET() {
  try {
    const staff = await requireRoles(...RECEPTION_ROLES);
    const today = clinicDateKey(staff.clinicTimezone, new Date());
    const visits = await listBookedVisits(staff.clinicId, today);
    return ok({
      day: today,
      visits: visits.map((v) => ({ id: v.id, queueNumber: v.queueNumber, slotAt: v.slotAt, patient: v.patient, doctor: v.doctor })),
    });
  } catch (e) {
    return handleApiError(e);
  }
}
