import type { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { requireLabCapability } from "@/lib/labs/guards";
import {
  analyseImportBatch,
  cancelImport,
  confirmImport,
  confirmPatientMatch,
  continueImport,
  dryRunImport,
  finishImport,
  getImportBatch,
} from "@/lib/labs/imports";
import { IMPORT_FIELDS } from "@/lib/labs/import/mapping";
import { sharedRateLimit } from "@/lib/rate-limit-shared";

export const dynamic = "force-dynamic";
// Importing runs for up to ~20 s per request (then the screen continues).
export const maxDuration = 60;

type RouteContext = { params: Promise<{ id: string }> };

async function batchIdOf(ctx: RouteContext): Promise<string> {
  const { id } = await ctx.params;
  if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Import topilmadi", "import_not_found");
  return id;
}

/** The import: state, counts, mapping and what the signed-in staff member may do. Lab staff. */
export async function GET(_request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireLabCapability("import.manage");
    return ok(await getImportBatch(staff, await batchIdOf(ctx)));
  } catch (e) {
    return handleApiError(e);
  }
}

const mappingSchema = z.partialRecord(z.enum(IMPORT_FIELDS), z.number().int().min(0).max(49));

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("analyse"), mapping: mappingSchema }),
  z.object({ action: z.literal("confirm_match"), patientKey: z.string().min(1).max(400), patientId: uuidSchema }),
  z.object({ action: z.literal("dry_run") }),
  z.object({ action: z.literal("confirm") }),
  z.object({ action: z.literal("continue") }),
  z.object({ action: z.literal("retry_failed") }),
  z.object({ action: z.literal("finish") }),
  z.object({ action: z.literal("cancel") }),
]);

/**
 * analyse        the preparer's mapping → validation, matching, duplicates (nothing imported)
 * confirm_match  the preparer confirms a suggested patient for one person in the file
 * dry_run        every ready result tried and rolled back
 * confirm        a second lab staff member confirms; the import runs
 * continue       continues a confirmed import
 * retry_failed   retries the results whose import failed
 * finish         closes a confirmed import (the rest is skipped)
 * cancel         stops an import (what was imported stays)
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireLabCapability("import.manage");
    const limit = await sharedRateLimit({ key: `lab-import-action:${staff.profileId}`, limit: 60, windowMs: 60_000 });
    if (!limit.ok) throw new ApiError(429, "Juda ko‘p so‘rov, birozdan keyin urinib ko‘ring", "rate_limited");
    const id = await batchIdOf(ctx);
    const body = await parseBody(request, schema);
    switch (body.action) {
      case "analyse":
        return ok(await analyseImportBatch(staff, id, body.mapping));
      case "confirm_match":
        return ok(await confirmPatientMatch(staff, id, body.patientKey, body.patientId));
      case "dry_run":
        return ok(await dryRunImport(staff, id));
      case "confirm":
        return ok(await confirmImport(staff, id));
      case "continue":
        return ok(await continueImport(staff, id, false));
      case "retry_failed":
        return ok(await continueImport(staff, id, true));
      case "finish":
        return ok(await finishImport(staff, id));
      case "cancel":
        return ok(await cancelImport(staff, id));
    }
  } catch (e) {
    return handleApiError(e);
  }
}
