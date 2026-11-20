import { handleApiError, ok } from "@/lib/api/errors";
import { requireLinkedDoctor } from "@/lib/auth/guards";
import { listOpenVisits } from "@/lib/operations/outpatient";

export const dynamic = "force-dynamic";

/**
 * The doctor's own live queue: their queued walk-ins (waiting, called, in
 * progress) in queue order. Visits still awaiting payment are not theirs to
 * call yet. Names and queue data only — no money.
 */
export async function GET() {
  try {
    const doctor = await requireLinkedDoctor();
    const visits = await listOpenVisits(doctor.clinicId, { doctorId: doctor.doctorId, statuses: ["waiting", "called", "in_progress"] });
    return ok({
      visits: visits.map((v) => ({
        id: v.id,
        status: v.status,
        queueNumber: v.queueNumber,
        queueDate: v.queueDate,
        queuedAt: v.queuedAt,
        calledAt: v.calledAt,
        patient: v.patient,
        services: v.charges.filter((c) => c.status === "active").map((c) => c.serviceName),
      })),
      at: new Date().toISOString(),
    });
  } catch (e) {
    return handleApiError(e);
  }
}
