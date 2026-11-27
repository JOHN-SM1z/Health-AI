import type { NextRequest } from "next/server";
import { requireLinkedDoctor } from "@/lib/auth/guards";
import { uuidSchema } from "@/lib/api/validate";
import { assertSameOrigin } from "@/lib/api/same-origin";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { sharedRateLimit } from "@/lib/rate-limit-shared";
import { deletePrescriptionDraft, getPrescriptionDocument } from "@/lib/prescribing/prescriptions";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const READS_PER_MINUTE = 60;

/** The calling doctor's own signed prescription, laid out for printing, with its verification link. */
export async function GET(_request: NextRequest, ctx: RouteContext) {
  try {
    const doctor = await requireLinkedDoctor();
    const limit = await sharedRateLimit({ key: `doctor-prescription-document:${doctor.profileId}`, limit: READS_PER_MINUTE, windowMs: 60_000 });
    if (!limit.ok) throw new ApiError(429, "Juda ko‘p so‘rov, birozdan keyin urinib ko‘ring", "rate_limited");
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Retsept topilmadi", "prescription_not_found");
    return ok({ document: await getPrescriptionDocument(doctor, id) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    return handleApiError(e);
  }
}

/** Discards the calling doctor's own draft. A signed prescription is cancelled, never deleted. */
export async function DELETE(request: NextRequest, ctx: RouteContext) {
  try {
    assertSameOrigin(request);
    const doctor = await requireLinkedDoctor();
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Retsept topilmadi", "prescription_not_found");
    await deletePrescriptionDraft(doctor, id);
    return ok({ deleted: true });
  } catch (e) {
    return handleApiError(e);
  }
}
