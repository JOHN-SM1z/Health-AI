import type { NextRequest } from "next/server";
import { z } from "zod";
import { requirePlatformAdmin } from "@/lib/auth/guards";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const schema = z
  .object({
    invoiceId: uuidSchema,
    // The bank's reference for the transfer, so every confirmation can be traced to a real payment.
    reference: z.string().trim().min(3, "To‘lov topshiriqnomasi raqamini kiriting").max(120),
  })
  .strict();

/**
 * A platform admin confirms that a clinic's bank transfer arrived: the invoice becomes paid and the subscription is
 * extended (confirm_subscription_invoice, one transaction, idempotent). This is the only way a subscription is paid.
 */
export async function POST(request: NextRequest) {
  try {
    const admin = await requirePlatformAdmin();
    const body = await parseBody(request, schema);
    const { data, error } = await createAdminClient().rpc("confirm_subscription_invoice", {
      p_invoice_id: body.invoiceId,
      p_admin_id: admin.profileId,
      p_reference: body.reference,
    });
    if (error?.details === "invoice_not_found") throw new ApiError(404, "Hisob-faktura topilmadi", "invoice_not_found");
    if (error?.details === "invoice_not_open") throw new ApiError(409, "Bu hisob-faktura allaqachon yopilgan", "invoice_not_open");
    if (error || !data?.[0]) throw new ApiError(500, "To‘lovni tasdiqlab bo‘lmadi");
    return ok({ clinicId: data[0].clinic_id, periodEnd: data[0].period_end });
  } catch (e) {
    return handleApiError(e);
  }
}
