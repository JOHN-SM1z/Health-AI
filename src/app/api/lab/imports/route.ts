import type { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { assertSameOrigin } from "@/lib/api/same-origin";
import { requireLabCapability } from "@/lib/labs/guards";
import { createImportBatch, listImportBatches } from "@/lib/labs/imports";
import { IMPORT_MAX_BYTES } from "@/lib/labs/import/csv";
import { sharedRateLimit } from "@/lib/rate-limit-shared";

export const dynamic = "force-dynamic";

/** The clinic's historical imports, newest first (no contents). Lab staff. */
export async function GET() {
  try {
    const staff = await requireLabCapability("import.manage");
    return ok({ batches: await listImportBatches(staff) });
  } catch (e) {
    return handleApiError(e);
  }
}

const fieldsSchema = z.object({
  sourceSystem: z.string().trim().min(1, "Manba tizimini yozing").max(80),
  fileName: z.string().trim().min(1).max(200),
});

/** Uploads a CSV file (multipart: file, sourceSystem). Nothing is imported yet. Lab staff. */
export async function POST(request: NextRequest) {
  try {
    const staff = await requireLabCapability("import.manage");
    const limit = await sharedRateLimit({ key: `lab-import-upload:${staff.profileId}`, limit: 30, windowMs: 60_000 });
    if (!limit.ok) throw new ApiError(429, "Juda ko‘p so‘rov, birozdan keyin urinib ko‘ring", "rate_limited");
    assertSameOrigin(request);

    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > IMPORT_MAX_BYTES + 64 * 1024) throw new ApiError(413, "Fayl 2 MB dan katta — uni bir necha qismga bo‘ling", "file_too_large");
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new ApiError(400, "Fayl yuborilmadi", "invalid_form");
    }
    const file = form.get("file");
    if (!(file instanceof Blob)) throw new ApiError(400, "Fayl yuborilmadi", "invalid_form");
    if (file.size > IMPORT_MAX_BYTES) throw new ApiError(413, "Fayl 2 MB dan katta — uni bir necha qismga bo‘ling", "file_too_large");
    const rawName = file instanceof File && file.name ? file.name : "import.csv";
    const fields = fieldsSchema.safeParse({ sourceSystem: form.get("sourceSystem") ?? "", fileName: rawName.replace(/[\u0000-\u001f]/g, "").slice(0, 200) || "import.csv" });
    if (!fields.success) throw new ApiError(400, fields.error.issues[0]?.message ?? "Noto‘g‘ri ma’lumot", "invalid_form");

    const batch = await createImportBatch(staff, { ...fields.data, bytes: new Uint8Array(await file.arrayBuffer()) });
    return ok(batch, { status: 201 });
  } catch (e) {
    return handleApiError(e);
  }
}
