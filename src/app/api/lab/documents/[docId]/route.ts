import type { NextRequest } from "next/server";
import { requireRoles } from "@/lib/auth/guards";
import { LAB_WORK_ROLES } from "@/lib/auth/staff";
import { uuidSchema } from "@/lib/api/validate";
import { ApiError, handleApiError } from "@/lib/api/errors";
import { sharedRateLimit } from "@/lib/rate-limit-shared";
import { auditDocumentRead, documentResponse, readLabDocument } from "@/lib/labs/documents";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ docId: string }> };

/** A document of a result in the caller's clinic, for laboratory staff (work in progress included). No URL grants access by itself. */
export async function GET(_request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireRoles(...LAB_WORK_ROLES);
    const limit = await sharedRateLimit({ key: `lab-doc:${staff.profileId}`, limit: 120, windowMs: 60_000 });
    if (!limit.ok) throw new ApiError(429, "Juda ko‘p so‘rov, birozdan keyin urinib ko‘ring", "rate_limited");
    const { docId } = await ctx.params;
    if (!uuidSchema.safeParse(docId).success) throw new ApiError(404, "Hujjat topilmadi", "document_not_found");
    const doc = await readLabDocument(staff.clinicId, docId, { finalisedOnly: false });
    await auditDocumentRead(staff.clinicId, staff, doc, "laboratory");
    return documentResponse(doc);
  } catch (e) {
    return handleApiError(e);
  }
}
