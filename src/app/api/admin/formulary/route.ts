import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireRoles } from "@/lib/auth/guards";
import { parseBody } from "@/lib/api/validate";
import { handleApiError, ok } from "@/lib/api/errors";
import { addToFormulary, catalogueStatus, createClinicDrug, listFormulary } from "@/lib/prescribing/catalog";
import { clinicDrugSchema, formularyEntrySchema } from "@/lib/prescribing/schemas";

export const dynamic = "force-dynamic";

// Either an entry of the shared catalogue put on the clinic's list, or a medicine the clinic records itself.
const bodySchema = z.union([formularyEntrySchema.strict(), clinicDrugSchema.strict()]);

/**
 * The clinic's formulary: its preferred medicines (shown first to doctors)
 * and the entries the clinic keeps itself until an official or licensed
 * catalogue is loaded. Owner and administrator only.
 */
export async function GET() {
  try {
    const staff = await requireRoles("owner", "admin");
    const [entries, catalogue] = await Promise.all([listFormulary(staff.clinicId), catalogueStatus(staff.clinicId)]);
    return ok({ entries, catalogue });
  } catch (e) {
    return handleApiError(e);
  }
}

export async function POST(request: NextRequest) {
  try {
    const staff = await requireRoles("owner", "admin");
    const body = await parseBody(request, bodySchema, { maxBytes: 16 * 1024 });
    if ("drugId" in body) {
      await addToFormulary(staff, body.drugId, body.sortOrder);
      return ok({ drugId: body.drugId }, { status: 201 });
    }
    return ok(await createClinicDrug(staff, body), { status: 201 });
  } catch (e) {
    return handleApiError(e);
  }
}
