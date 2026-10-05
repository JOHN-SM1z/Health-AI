import type { NextRequest } from "next/server";
import { handleApiError, ok } from "@/lib/api/errors";
import { parseBody } from "@/lib/api/validate";
import { requireLabCapability } from "@/lib/labs/guards";
import { getLabSettings, labSettingsSchema, saveLabSettings } from "@/lib/labs/settings";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const staff = await requireLabCapability("settings.configure");
    return ok({ settings: await getLabSettings(staff.clinicId) });
  } catch (e) {
    return handleApiError(e);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const staff = await requireLabCapability("settings.configure");
    const body = await parseBody(request, labSettingsSchema);
    return ok({ settings: await saveLabSettings(staff, body) });
  } catch (e) {
    return handleApiError(e);
  }
}
