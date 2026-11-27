import type { NextRequest } from "next/server";
import { requireLinkedDoctor } from "@/lib/auth/guards";
import { parseBody } from "@/lib/api/validate";
import { handleApiError, ok } from "@/lib/api/errors";
import { listTemplates, saveTemplate } from "@/lib/prescribing/templates";
import { templateSchema } from "@/lib/prescribing/schemas";

export const dynamic = "force-dynamic";

/** The calling doctor's own prescription templates. */
export async function GET() {
  try {
    const doctor = await requireLinkedDoctor();
    return ok({ templates: await listTemplates(doctor) });
  } catch (e) {
    return handleApiError(e);
  }
}

/** Saves the doctor's current items as a template (a template of the same name is replaced). */
export async function POST(request: NextRequest) {
  try {
    const doctor = await requireLinkedDoctor();
    const body = await parseBody(request, templateSchema, { maxBytes: 32 * 1024 });
    return ok({ template: await saveTemplate(doctor, body.name, body.items) }, { status: 201 });
  } catch (e) {
    return handleApiError(e);
  }
}
