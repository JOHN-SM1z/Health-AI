import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireRoles } from "@/lib/auth/guards";
import { parseBody } from "@/lib/api/validate";
import { handleApiError, ok } from "@/lib/api/errors";
import { billingOverview, changePlan, requestInvoice } from "@/lib/billing/invoices";

export const dynamic = "force-dynamic";

const schema = z.union([
  z.object({ months: z.number().int().min(1).max(12) }).strict(),
  z.object({ planCode: z.string().regex(/^[a-z0-9_-]{2,32}$/) }).strict(),
]);

/**
 * The owner's subscription: plan, status, invoices and the bank details to pay to. Payment itself is confirmed only by
 * a platform admin once the transfer arrives — never from this route.
 */
export async function GET() {
  try {
    const owner = await requireRoles("owner");
    return ok(await billingOverview(owner.clinicId));
  } catch (e) {
    return handleApiError(e);
  }
}

/** Asks for an invoice covering N months, or switches plans. */
export async function POST(request: NextRequest) {
  try {
    const owner = await requireRoles("owner");
    const body = await parseBody(request, schema);
    if ("months" in body) {
      const invoiceId = await requestInvoice(owner.clinicId, owner.profileId, body.months);
      return ok({ invoiceId });
    }
    await changePlan(owner.clinicId, owner.profileId, body.planCode);
    return ok({ changed: true });
  } catch (e) {
    return handleApiError(e);
  }
}
