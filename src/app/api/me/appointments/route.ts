import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDefaultClinic } from "@/lib/clinics/context";
import { resolvePatientFromInitData, devIdentityAllowed } from "@/lib/patients/identity";
import { handleApiError, ApiError, ok, fail } from "@/lib/api/errors";
import { rateLimit, keyFromIp } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const schema = z.object({
  initData: z.string().min(1),
});

/**
 * The patient's own appointments (their clinic only). Identity comes from
 * the verified Telegram initData — never from the browser.
 */
export async function POST(request: NextRequest) {
  try {
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const limit = rateLimit({ key: keyFromIp(ip, "my-appointments"), limit: 20, windowMs: 60_000 });
    if (!limit.ok) return fail("Juda ko‘p so‘rov", 429, "rate_limited");

    const body = schema.parse(await request.json());
    if (body.initData === "dev" && !devIdentityAllowed()) {
      throw new ApiError(403, "Development identity is not allowed", "dev_identity_forbidden");
    }

    const clinic = await getDefaultClinic();
    const resolved = await resolvePatientFromInitData(body.initData, clinic.id);
    if (!resolved) throw new ApiError(401, "Telegram identifikatori tasdiqlanmadi", "invalid_init_data");

    const supabase = createAdminClient();
    const { data: appointments, error } = await supabase
      .from("appointments")
      .select("*, doctors(name, title), services(name, price, duration_minutes), payments(status, amount, currency)")
      .eq("patient_id", resolved.patient.id)
      .eq("clinic_id", clinic.id)
      .order("start_at", { ascending: false });

    if (error) throw new ApiError(500, "Qabullarni yuklab bo‘lmadi");

    return ok({ appointments: appointments ?? [], patient: { id: resolved.patient.id, fullName: resolved.patient.full_name } });
  } catch (e) {
    return handleApiError(e);
  }
}