import type { NextRequest } from "next/server";
import { z } from "zod";
import { requirePlatformAdmin } from "@/lib/auth/guards";
import { parseBody } from "@/lib/api/validate";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const field = (max: number) => z.string().trim().max(max);
const schema = z
  .object({
    legalName: field(160),
    tin: z.string().trim().regex(/^(\d{9})?$/, "STIR 9 ta raqam"),
    bankName: field(160),
    bankAccount: z.string().trim().regex(/^(\d{20})?$/, "Hisob raqam 20 ta raqam"),
    mfo: z.string().trim().regex(/^(\d{5})?$/, "MFO 5 ta raqam"),
    contactPhone: field(40),
  })
  .strict();

/** The payee details printed on every invoice (Health AI's legal entity and bank account). */
export async function PUT(request: NextRequest) {
  try {
    await requirePlatformAdmin();
    const b = await parseBody(request, schema);
    const { error } = await createAdminClient()
      .from("platform_billing")
      .update({
        legal_name: b.legalName,
        tin: b.tin,
        bank_name: b.bankName,
        bank_account: b.bankAccount,
        mfo: b.mfo,
        contact_phone: b.contactPhone,
        updated_at: new Date().toISOString(),
      })
      .eq("id", true);
    if (error) throw new ApiError(500, "Rekvizitlarni saqlab bo‘lmadi");
    return ok({ saved: true });
  } catch (e) {
    return handleApiError(e);
  }
}
