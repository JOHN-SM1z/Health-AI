import type { NextRequest } from "next/server";
import { requireLinkedDoctor } from "@/lib/auth/guards";
import { uuidSchema } from "@/lib/api/validate";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { getLabDocumentLink } from "@/lib/labs/history";
import { sharedRateLimit } from "@/lib/rate-limit-shared";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string; documentId: string }> };

/** A 60-second link to one attachment of a verified result; audited. */
export async function GET(_request: NextRequest, ctx: RouteContext) {
  try {
    const doctor = await requireLinkedDoctor();
    const limit = await sharedRateLimit({ key: `doctor-lab-document:${doctor.profileId}`, limit: 30, windowMs: 60_000 });
    if (!limit.ok) throw new ApiError(429, "Juda ko‘p so‘rov, birozdan keyin urinib ko‘ring", "rate_limited");
    const { id, documentId } = await ctx.params;
    if (!uuidSchema.safeParse(id).success || !uuidSchema.safeParse(documentId).success) {
      throw new ApiError(404, "Hujjat topilmadi", "document_not_found");
    }
    return ok(await getLabDocumentLink(doctor, id, documentId));
  } catch (e) {
    return handleApiError(e);
  }
}
