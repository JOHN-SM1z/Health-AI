import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireLinkedDoctor } from "@/lib/auth/guards";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { createClinicalRecord } from "@/lib/clinical-records/service";
import { CLINICAL_RECORD_TYPES } from "@/lib/clinical-records/categories";
import { isAcceptableDiagnosisCode } from "@/lib/prescribing/catalog";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

// Only the doctor's own words and ids: the author, clinic and provenance are
// set server-side, and the consultation is re-checked against the patient in
// the URL.
const recordSchema = z.object({
  idempotencyKey: uuidSchema,
  appointmentId: uuidSchema,
  recordType: z.enum(CLINICAL_RECORD_TYPES),
  summary: z.string().trim().min(1, "Qisqacha mazmunni yozing").max(300),
  details: z.string().trim().max(4000).optional(),
  code: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9.\-]{1,16}$/, "Kod noto‘g‘ri")
    .optional()
    .or(z.literal("")),
  correctsRecordId: uuidSchema.optional(),
});

/** The calling doctor adds a clinical record to their own consultation with this patient. */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const doctor = await requireLinkedDoctor();
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Bemor topilmadi", "patient_not_found");
    const body = await parseBody(request, recordSchema);
    // DW-02: once an ICD-10 catalogue is loaded, a diagnosis code is one the doctor picked from it.
    const code = body.recordType === "diagnosis" && body.code ? body.code.toUpperCase() : body.code || null;
    if (body.recordType === "diagnosis" && code && !(await isAcceptableDiagnosisCode(code))) {
      throw new ApiError(400, "Bu kod XKT-10 ro‘yxatida topilmadi — kodni ro‘yxatdan tanlang", "icd10_code_unknown");
    }
    const record = await createClinicalRecord(doctor, id, { ...body, code });
    return ok({ record }, { status: record.replayed ? 200 : 201 });
  } catch (e) {
    return handleApiError(e);
  }
}
