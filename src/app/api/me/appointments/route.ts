import type { NextRequest } from "next/server";
import { z } from "zod";
import { getClinicFromRequest } from "@/lib/clinics/context";
import { resolvePatientFromInitData, devIdentityAllowed } from "@/lib/patients/identity";
import { handleApiError, ApiError, ok, fail } from "@/lib/api/errors";
import { rateLimit, keyFromIp } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import { patientRecordIds } from "@/lib/patients/record-group";
import { patientQueuePositions } from "@/lib/operations/outpatient";

export const dynamic = "force-dynamic";

const schema = z.object({
  initData: z.string().nullable().optional(),
});

/**
 * The patient's own appointments (their clinic only). Identity comes from
 * the verified Telegram initData — never from the browser.
 */
export async function POST(request: NextRequest) {
  try {
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    // The page refreshes itself every 15 s while open (live status), and
    // several patients may share one clinic Wi-Fi address.
    const limit = rateLimit({ key: keyFromIp(ip, "my-appointments"), limit: 60, windowMs: 60_000 });
    if (!limit.ok) return fail("Juda ko‘p so‘rov", 429, "rate_limited");

    const body = schema.parse(await request.json());
    if (body.initData === "dev" && !devIdentityAllowed()) {
      throw new ApiError(403, "Development identity is not allowed", "dev_identity_forbidden");
    }

    const clinic = await getClinicFromRequest(request);
    const resolved = await resolvePatientFromInitData(body.initData, clinic.id);
    if (!resolved) throw new ApiError(401, "Telegram identifikatori tasdiqlanmadi", "invalid_init_data");

    const supabase = createAdminClient();
    // The person's visits across merged records (Phase 14).
    const recordIds = await patientRecordIds(clinic.id, resolved.patient.id);
    const { data: appointments, error } = await supabase
      .from("appointments")
      .select("*, doctors(name, title), services(name, price, duration_minutes), payments(status, amount, currency, payment_url)")
      .in("patient_id", recordIds)
      .eq("clinic_id", clinic.id)
      .order("start_at", { ascending: false });

    if (error) throw new ApiError(500, "Qabullarni yuklab bo‘lmadi");

    return ok({
      appointments: appointments ?? [],
      // Walk-in visits still open: the digital queue ticket and live position.
      queue: await patientQueuePositions(clinic.id, recordIds),
      patient: { id: resolved.patient.id, fullName: resolved.patient.full_name },
      clinic: { name: clinic.name, timezone: clinic.timezone },
    });
  } catch (e) {
    return handleApiError(e);
  }
}