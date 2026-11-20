import type { NextRequest } from "next/server";
import { requireRoles } from "@/lib/auth/guards";
import { uuidSchema } from "@/lib/api/validate";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { invoiceForPrint } from "@/lib/billing/invoices";

export const dynamic = "force-dynamic";

/** One of the owner's own subscription invoices, for printing. */
export async function GET(request: NextRequest) {
  try {
    const owner = await requireRoles("owner");
    const id = uuidSchema.safeParse(request.nextUrl.searchParams.get("id"));
    if (!id.success) throw new ApiError(400, "Hisob-faktura ko‘rsatilmagan", "validation");
    const invoice = await invoiceForPrint(owner.clinicId, id.data);
    if (!invoice) throw new ApiError(404, "Hisob-faktura topilmadi", "invoice_not_found");
    return ok(invoice);
  } catch (e) {
    return handleApiError(e);
  }
}
