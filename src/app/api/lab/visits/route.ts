import { handleApiError, ok } from "@/lib/api/errors";
import { requireRoles } from "@/lib/auth/guards";
import { listOpenVisits } from "@/lib/operations/outpatient";

export const dynamic = "force-dynamic";

/**
 * The laboratory's walk-in queue: paid lab visits (waiting, called, sample
 * being taken) in queue order, with the tests to collect. Names and test
 * names only — no money, no clinical content.
 */
export async function GET() {
  try {
    const staff = await requireRoles("lab", "owner", "manager", "admin");
    const visits = (await listOpenVisits(staff.clinicId, { statuses: ["waiting", "called", "in_progress"] })).filter((v) => v.kind === "lab");
    return ok({
      visits: visits.map((v) => ({
        id: v.id,
        status: v.status,
        queueNumber: v.queueNumber,
        labOrderId: v.labOrderId,
        patient: v.patient,
        tests: v.charges.filter((c) => c.status === "active" && c.isLabTest).map((c) => c.serviceName),
      })),
      at: new Date().toISOString(),
    });
  } catch (e) {
    return handleApiError(e);
  }
}
