import type { NextRequest } from "next/server";
import { z } from "zod";
import { handleApiError, ok } from "@/lib/api/errors";
import { parseBody } from "@/lib/api/validate";
import { requireLabCapability } from "@/lib/labs/guards";
import { availableAdapters } from "@/lib/labs/providers/registry";
import { createProvider, listProviders } from "@/lib/labs/providers/service";
import { providerSchema } from "@/lib/labs/providers/schema";

export const dynamic = "force-dynamic";


/** External laboratories of the clinic and their code tables (catalog.configure). Secrets are never returned. */
export async function GET() {
  try {
    const staff = await requireLabCapability("catalog.configure");
    return ok({ providers: await listProviders(staff), adapters: availableAdapters() });
  } catch (e) {
    return handleApiError(e);
  }
}

export async function POST(request: NextRequest) {
  try {
    const staff = await requireLabCapability("catalog.configure");
    const body = await parseBody(request, providerSchema.extend({ code: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,39}$/) }));
    return ok(await createProvider(staff, body), { status: 201 });
  } catch (e) {
    return handleApiError(e);
  }
}
