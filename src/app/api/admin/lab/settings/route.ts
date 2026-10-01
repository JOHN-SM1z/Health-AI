import type { NextRequest } from "next/server";
import { handleApiError, ok } from "@/lib/api/errors";
import { parseBody } from "@/lib/api/validate";
import { recordAudit } from "@/lib/audit";
import { requireLabCatalogRead, requireLabConfig } from "@/lib/labs/access";
import { getLabSettings, putLabSettings } from "@/lib/labs/catalog";
import { labSettingsSchema } from "@/lib/labs/schemas";

export const dynamic = "force-dynamic";

/** The clinic's laboratory workflow policy: verification on/off, separate verifier, payment before collection. */
export async function GET() {
  try {
    const staff = await requireLabCatalogRead();
    return ok({ settings: await getLabSettings(staff.clinicId) });
  } catch (e) {
    return handleApiError(e);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const staff = await requireLabConfig();
    const body = await parseBody(request, labSettingsSchema);
    const before = await getLabSettings(staff.clinicId);
    const settings = await putLabSettings(staff.clinicId, staff.profileId, body);
    // Policy flags only (booleans): who changed the workflow rules, and what they were before.
    await recordAudit({
      clinicId: staff.clinicId,
      action: "lab_settings_changed",
      entityType: "app_settings",
      entityId: "lab",
      actor: { actorId: staff.profileId, actorType: "staff" },
      oldValues: before,
      newValues: settings,
    });
    return ok({ settings });
  } catch (e) {
    return handleApiError(e);
  }
}
