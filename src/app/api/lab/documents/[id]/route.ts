import type { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { requireLabCapability } from "@/lib/labs/guards";
import { getDocumentLinkForLab, withdrawLabDocument } from "@/lib/labs/documents";
import { sharedRateLimit } from "@/lib/rate-limit-shared";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

async function documentIdOf(ctx: RouteContext): Promise<string> {
  const { id } = await ctx.params;
  if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Hujjat topilmadi", "document_not_found");
  return id;
}

/** A 60-second signed link to the document (audited). Lab staff. */
export async function GET(_request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireLabCapability("document.upload");
    const limit = await sharedRateLimit({ key: `lab-document-link:${staff.profileId}`, limit: 60, windowMs: 60_000 });
    if (!limit.ok) throw new ApiError(429, "Juda ko‘p so‘rov, birozdan keyin urinib ko‘ring", "rate_limited");
    return ok(await getDocumentLinkForLab(staff, await documentIdOf(ctx)));
  } catch (e) {
    return handleApiError(e);
  }
}

const schema = z.object({ action: z.literal("withdraw"), reason: z.string().trim().min(1).max(300) });

/** Withdraws the document with a reason (retained, never deleted). Lab staff. */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireLabCapability("document.upload");
    const id = await documentIdOf(ctx);
    const body = await parseBody(request, schema);
    return ok(await withdrawLabDocument(staff, id, body.reason));
  } catch (e) {
    return handleApiError(e);
  }
}
