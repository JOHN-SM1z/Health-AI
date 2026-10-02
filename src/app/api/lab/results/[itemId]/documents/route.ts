import type { NextRequest } from "next/server";
import { requireRoles } from "@/lib/auth/guards";
import { LAB_WORK_ROLES } from "@/lib/auth/staff";
import { uuidSchema } from "@/lib/api/validate";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { sharedRateLimit } from "@/lib/rate-limit-shared";
import { DOCUMENT_KINDS, MAX_DOCUMENT_BYTES, uploadLabDocument, type DocumentKind } from "@/lib/labs/documents";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ itemId: string }> };

/**
 * Adds a document (PDF, PNG or JPEG, up to 10 MB) to an ordered test's result: multipart with `file` and `kind`
 * (report | scan | image | imported). Laboratory staff only. The size is checked before the body is read, the type from the file's own
 * bytes; the uploader is the session's login, the storage path is built from database ids, and the file name is never kept.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireRoles(...LAB_WORK_ROLES);
    const limit = await sharedRateLimit({ key: `lab-doc-upload:${staff.profileId}`, limit: 30, windowMs: 60_000 });
    if (!limit.ok) throw new ApiError(429, "Juda ko‘p so‘rov, birozdan keyin urinib ko‘ring", "rate_limited");
    const { itemId } = await ctx.params;
    if (!uuidSchema.safeParse(itemId).success) throw new ApiError(404, "Topilmadi", "lab_not_found");

    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_DOCUMENT_BYTES + 64 * 1024) throw new ApiError(413, "Fayl hajmi 10 MB dan oshmasligi kerak", "file_too_large");
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new ApiError(400, "So‘rov noto‘g‘ri", "validation");
    }
    const file = form.get("file");
    const kind = form.get("kind");
    const extra = [...form.keys()].filter((k) => k !== "file" && k !== "kind");
    if (extra.length > 0) throw new ApiError(400, "So‘rovda ortiqcha maydon bor", "validation");
    if (!(file instanceof File)) throw new ApiError(400, "Fayl tanlanmagan", "validation");
    if (typeof kind !== "string" || !(DOCUMENT_KINDS as readonly string[]).includes(kind)) throw new ApiError(400, "Hujjat turi noto‘g‘ri", "validation");
    if (file.size > MAX_DOCUMENT_BYTES) throw new ApiError(413, "Fayl hajmi 10 MB dan oshmasligi kerak", "file_too_large");

    const bytes = new Uint8Array(await file.arrayBuffer());
    return ok({ document: await uploadLabDocument(staff, itemId, { kind: kind as DocumentKind, bytes }) }, { status: 201 });
  } catch (e) {
    return handleApiError(e);
  }
}
