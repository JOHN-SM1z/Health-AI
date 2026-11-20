import type { NextRequest } from "next/server";
import { z } from "zod";
import { handleApiError, ok } from "@/lib/api/errors";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { requireRoles } from "@/lib/auth/guards";
import { grantRefundPermission, listCashiersWithGrants, revokeRefundPermission } from "@/lib/operations/outpatient";

export const dynamic = "force-dynamic";

/** Cashiers and who may refund (owner decision 2026-10-07: a cashier refunds only with a manager's grant). */
export async function GET() {
  try {
    const staff = await requireRoles("owner", "manager");
    return ok({ cashiers: await listCashiersWithGrants(staff.clinicId) });
  } catch (e) {
    return handleApiError(e);
  }
}

export async function POST(request: NextRequest) {
  try {
    const staff = await requireRoles("owner", "manager");
    const body = await parseBody(request, z.object({ cashierId: uuidSchema }).strict());
    const r = await grantRefundPermission(staff, body.cashierId);
    return ok({ granted: true, replayed: r.replayed });
  } catch (e) {
    return handleApiError(e);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const staff = await requireRoles("owner", "manager");
    const body = await parseBody(request, z.object({ cashierId: uuidSchema, reason: z.string().trim().min(3, "Sababini yozing").max(500) }).strict());
    await revokeRefundPermission(staff, body.cashierId, body.reason);
    return ok({ revoked: true });
  } catch (e) {
    return handleApiError(e);
  }
}
