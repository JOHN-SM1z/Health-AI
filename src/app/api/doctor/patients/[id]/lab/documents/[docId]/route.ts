import type { NextRequest } from "next/server";
import { requireLinkedDoctor } from "@/lib/auth/guards";
import { uuidSchema } from "@/lib/api/validate";
import { ApiError, handleApiError } from "@/lib/api/errors";
import { sharedRateLimit } from "@/lib/rate-limit-shared";
import { assertPatientAccess } from "@/lib/labs/ordering";
import { auditDocumentRead, documentResponse, readLabDocument } from "@/lib/labs/documents";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string; docId: string }> };

/**
 * A finalised result's document, for a doctor with the legitimate relationship to THIS patient. There is no signed or public URL: this
 * route re-checks, on every request, the clinical access decision for the patient in the path, that the document belongs to that
 * patient's result in the doctor's clinic, and that the result is finalised (and the document part of it). A wrong patient, a wrong or
 * foreign document id and a forged link all answer 404; the read is audited before a byte is returned.
 */
export async function GET(_request: NextRequest, ctx: RouteContext) {
  try {
    const doctor = await requireLinkedDoctor();
    const limit = await sharedRateLimit({ key: `doctor-lab-doc:${doctor.profileId}`, limit: 60, windowMs: 60_000 });
    if (!limit.ok) throw new ApiError(429, "Juda ko‘p so‘rov, birozdan keyin urinib ko‘ring", "rate_limited");
    const { id, docId } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Bemor topilmadi", "patient_not_found");
    if (!uuidSchema.safeParse(docId).success) throw new ApiError(404, "Hujjat topilmadi", "document_not_found");
    await assertPatientAccess(doctor, id);
    const doc = await readLabDocument(doctor.clinicId, docId, { patientId: id, finalisedOnly: true });
    await auditDocumentRead(doctor.clinicId, doctor, doc, "doctor");
    return documentResponse(doc);
  } catch (e) {
    return handleApiError(e);
  }
}
