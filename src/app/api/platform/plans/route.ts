import type { NextRequest } from "next/server";
import { z } from "zod";
import { requirePlatformAdmin } from "@/lib/auth/guards";
import { parseBody } from "@/lib/api/validate";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const schema = z
  .object({
    code: z.string().regex(/^[a-z0-9_-]{2,32}$/),
    name: z.string().trim().min(2).max(60),
    tagline: z.string().trim().max(160),
    monthlyPriceUzs: z.number().int().min(0).max(1_000_000_000),
    maxStaff: z.number().int().positive().nullable(),
    maxDoctors: z.number().int().positive().nullable(),
    features: z.array(z.string().trim().min(2).max(120)).max(12),
    isPublic: z.boolean(),
  })
  .strict();

/**
 * The platform owner edits a plan. Saving confirms its price (price_is_draft off), so the landing page stops showing
 * it as “taxminiy”. Invoices already issued keep their amount.
 */
export async function PATCH(request: NextRequest) {
  try {
    await requirePlatformAdmin();
    const body = await parseBody(request, schema);
    const { data, error } = await createAdminClient()
      .from("subscription_plans")
      .update({
        name: body.name,
        tagline: body.tagline,
        monthly_price_uzs: body.monthlyPriceUzs,
        max_staff: body.maxStaff,
        max_doctors: body.maxDoctors,
        features: body.features,
        is_public: body.isPublic,
        price_is_draft: false,
        updated_at: new Date().toISOString(),
      })
      .eq("code", body.code)
      .select("id");
    if (error) throw new ApiError(500, "Tarifni saqlab bo‘lmadi");
    if (!data?.length) throw new ApiError(404, "Tarif topilmadi", "plan_not_found");
    return ok({ saved: true });
  } catch (e) {
    return handleApiError(e);
  }
}
