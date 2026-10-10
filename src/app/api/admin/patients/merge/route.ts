import type { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { requireRoles } from "@/lib/auth/guards";
import { getMergePreview, mergePatients } from "@/lib/patients/merge";
import { sharedRateLimit } from "@/lib/rate-limit-shared";

export const dynamic = "force-dynamic";

/** The complete pre-merge preview of two patient records (owner / admin). */
export async function GET(request: NextRequest) {
  try {
    const staff = await requireRoles("owner", "admin");
    const params = request.nextUrl.searchParams;
    const canonical = uuidSchema.safeParse(params.get("canonical"));
    const duplicate = uuidSchema.safeParse(params.get("duplicate"));
    if (!canonical.success || !duplicate.success) throw new ApiError(400, "Ikki bemorni tanlang", "validation");
    return ok(await getMergePreview(staff, canonical.data, duplicate.data));
  } catch (e) {
    return handleApiError(e);
  }
}

const schema = z.object({
  canonicalId: uuidSchema,
  duplicateId: uuidSchema,
  reason: z.string().trim().min(3, "Sababini yozing").max(500),
  // The server-keyed token of the preview the person saw (see src/lib/patients/merge.ts).
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/, "Avval ko‘rib chiqing"),
  confirmSamePerson: z.literal(true, { message: "Bu bir odam ekanini tasdiqlang" }),
});

/** Merges the duplicate into the canonical record, exactly as previewed (owner / admin). */
export async function POST(request: NextRequest) {
  try {
    const staff = await requireRoles("owner", "admin");
    const limit = await sharedRateLimit({ key: `patient-merge:${staff.profileId}`, limit: 20, windowMs: 60_000 });
    if (!limit.ok) throw new ApiError(429, "Juda ko‘p so‘rov, birozdan keyin urinib ko‘ring", "rate_limited");
    const body = await parseBody(request, schema);
    return ok(await mergePatients(staff, body), { status: 201 });
  } catch (e) {
    return handleApiError(e);
  }
}
