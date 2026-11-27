import type { NextRequest } from "next/server";
import { requireLinkedDoctor } from "@/lib/auth/guards";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { sharedRateLimit } from "@/lib/rate-limit-shared";
import { catalogueStatus } from "@/lib/prescribing/catalog";
import { listPatientPrescriptions, savePrescriptionDraft } from "@/lib/prescribing/prescriptions";
import { savePrescriptionSchema } from "@/lib/prescribing/schemas";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const READS_PER_MINUTE = 60;

/**
 * The patient's prescriptions as the calling doctor may see them — signed
 * ones where the consultation's records are visible, plus the doctor's own
 * drafts — and where the drug catalogue comes from (shown in the footer).
 */
export async function GET(_request: NextRequest, ctx: RouteContext) {
  try {
    const doctor = await requireLinkedDoctor();
    const limit = await sharedRateLimit({ key: `doctor-patient-prescriptions:${doctor.profileId}`, limit: READS_PER_MINUTE, windowMs: 60_000 });
    if (!limit.ok) throw new ApiError(429, "Juda ko‘p so‘rov, birozdan keyin urinib ko‘ring", "rate_limited");
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Bemor topilmadi", "patient_not_found");
    const prescriptions = await listPatientPrescriptions(doctor, id);
    return ok({ prescriptions, catalogue: await catalogueStatus(doctor.clinicId) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    return handleApiError(e);
  }
}

/**
 * Saves the calling doctor's draft in their own consultation with this
 * patient. Only ids and the doctor's own dose, schedule and instruction are
 * read from the body; the medicine's catalogue values are taken server-side.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const doctor = await requireLinkedDoctor();
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Bemor topilmadi", "patient_not_found");
    const body = await parseBody(request, savePrescriptionSchema, { maxBytes: 64 * 1024 });
    return ok({ prescription: await savePrescriptionDraft(doctor, id, body) });
  } catch (e) {
    return handleApiError(e);
  }
}
