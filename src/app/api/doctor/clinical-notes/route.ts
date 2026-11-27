import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireLinkedDoctor } from "@/lib/auth/guards";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { getPatientWorkspace } from "@/lib/clinical-access/workspace";
import { createClinicalRecord } from "@/lib/clinical-records/service";
import { CLINICAL_RECORD_TYPES } from "@/lib/clinical-records/categories";

export const dynamic = "force-dynamic";
const schema = z.object({
  patientId: uuidSchema, appointmentId: uuidSchema, idempotencyKey: uuidSchema,
  recordType: z.enum(CLINICAL_RECORD_TYPES), summary: z.string().trim().min(1).max(300),
  details: z.string().trim().max(4000).optional(), code: z.string().regex(/^[A-Za-z0-9.\-]{1,16}$/).optional(),
  correctsRecordId: uuidSchema.optional(),
}).strict();

/** Compatibility URL backed by the same audited, scoped clinical workspace. */
export async function GET(request: NextRequest) {
  try {
    const doctor = await requireLinkedDoctor();
    const patientId = request.nextUrl.searchParams.get("patientId");
    if (!uuidSchema.safeParse(patientId).success) throw new ApiError(400, "Bemor identifikatori noto‘g‘ri", "invalid_patient_id");
    const workspace = await getPatientWorkspace(doctor, patientId!);
    return ok({ notes: workspace.records, accessLevel: workspace.relationship }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) { return handleApiError(e); }
}

/** Requires the canonical record contract: real consultation and retry key. */
export async function POST(request: NextRequest) {
  try {
    const doctor = await requireLinkedDoctor();
    const { patientId, ...input } = await parseBody(request, schema);
    const record = await createClinicalRecord(doctor, patientId, input);
    return ok({ record }, { status: record.replayed ? 200 : 201 });
  } catch (e) { return handleApiError(e); }
}
