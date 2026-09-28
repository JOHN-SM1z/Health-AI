import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireLinkedDoctor } from "@/lib/auth/guards";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { sharedRateLimit } from "@/lib/rate-limit-shared";
import { correctClinicalRecord } from "@/lib/clinical-records/service";

export const dynamic = "force-dynamic";

// Per doctor, across every server instance, shared by new records and
// corrections: ample for documenting a consultation, but a loop can't flood
// the record history or the audit rows every refusal writes.
const WRITES_PER_MINUTE = 60;

type RouteContext = { params: Promise<{ id: string; recordId: string }> };

// Only the corrected text and the version it replaces. The consultation,
// type, author and provenance come from the record being corrected and the
// session; no reason is asked for — the history and audit trail keep what
// changed, who changed it and when.
const correctionSchema = z.object({
  idempotencyKey: uuidSchema,
  summary: z.string().trim().min(1, "Qisqacha mazmunni yozing").max(300),
  details: z.string().trim().max(4000).optional(),
  code: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9.\-]{1,16}$/, "Kod noto‘g‘ri")
    .optional()
    .or(z.literal("")),
  expectedVersion: z.number().int().min(1).optional(),
});

/**
 * The author corrects their own record: saved as its next version, the
 * earlier one kept in its history. 403 CLINICAL_RECORD_NOT_OWNED for another
 * doctor's record, 404 for one the doctor may not see, 409 VERSION_CONFLICT
 * when the record changed since the doctor opened it.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const doctor = await requireLinkedDoctor();
    const limit = await sharedRateLimit({ key: `doctor-clinical-write:${doctor.profileId}`, limit: WRITES_PER_MINUTE, windowMs: 60_000 });
    if (!limit.ok) throw new ApiError(429, "Juda ko‘p so‘rov, birozdan keyin urinib ko‘ring", "rate_limited");
    const { id, recordId } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Bemor topilmadi", "patient_not_found");
    if (!uuidSchema.safeParse(recordId).success) throw new ApiError(404, "Yozuv topilmadi", "record_not_found");
    const body = await parseBody(request, correctionSchema);
    const record = await correctClinicalRecord(doctor, id, recordId, { ...body, code: body.code || null });
    return ok({ record }, { status: record.replayed ? 200 : 201 });
  } catch (e) {
    return handleApiError(e);
  }
}
