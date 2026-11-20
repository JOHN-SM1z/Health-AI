import type { NextRequest } from "next/server";
import { handleApiError, ok } from "@/lib/api/errors";
import { requireLabCapability } from "@/lib/labs/guards";
import { listLabPayments } from "@/lib/labs/payments";

export const dynamic = "force-dynamic";

/** Lab orders and their payments for the Kassa (finance roles only; test names and statuses, never results). */
export async function GET(request: NextRequest) {
  try {
    const staff = await requireLabCapability("finance.view");
    const filter = request.nextUrl.searchParams.get("filter") === "all" ? "all" : "open";
    return ok({ payments: await listLabPayments(staff, filter) });
  } catch (e) {
    return handleApiError(e);
  }
}
