import type { NextRequest } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRoles } from "@/lib/auth/guards";
import { handleApiError, ApiError, ok } from "@/lib/api/errors";
import { parseBody, uuidSchema } from "@/lib/api/validate";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

const notesSchema = z.object({
  patientId: uuidSchema,
  operationalNotes: z.string().max(1000).trim(),
});

/**
 * Patient directory for one clinic (management/operational staff).
 *
 * Search matches name, phone and Telegram username; the browser may only
 * ever see patients of the staff member's own clinic (clinic_id is taken
 * from the verified staff session, never from the request).
 */
export async function GET(request: NextRequest) {
  try {
    const staff = await requireRoles("owner", "admin", "manager", "receptionist");
    const supabase = createAdminClient();

    const searchParams = request.nextUrl.searchParams;
    const q = searchParams.get("q")?.trim().slice(0, 80) ?? "";
    const onlyTelegram = searchParams.get("telegram") === "1";
    const noConsent = searchParams.get("noConsent") === "1";
    const page = Math.max(1, Number(searchParams.get("page") ?? 1) || 1);
    const detailId = searchParams.get("id");

    if (detailId) {
      const { data: patient, error: patientError } = await supabase
        .from("patients")
        .select(
          "id, full_name, phone, telegram_username, telegram_first_name, telegram_last_name, consent_given, consent_given_at, last_seen_at, created_at, operational_notes",
        )
        .eq("id", detailId)
        .eq("clinic_id", staff.clinicId)
        .maybeSingle();
      if (patientError) throw patientError;
      if (!patient) return ok({ patient: null, appointments: [], conversations: [] });

      const [{ data: appointments, error: appointmentsError }, { data: conversations, error: conversationsError }] =
        await Promise.all([
          supabase
            .from("appointments")
            .select(
              "id, start_at, status, source, services(name), doctors(name)",
            )
            .eq("patient_id", detailId)
            .order("start_at", { ascending: false })
            .limit(20),
          supabase
            .from("conversations")
            .select("id, status, channel, updated_at")
            .eq("patient_id", detailId)
            .order("updated_at", { ascending: false })
            .limit(10),
        ]);
      if (appointmentsError) throw appointmentsError;
      if (conversationsError) throw conversationsError;
      return ok({ patient, appointments: appointments ?? [], conversations: conversations ?? [] });
    }

    let query = supabase
      .from("patients")
      .select(
        "id, full_name, phone, telegram_username, telegram_first_name, telegram_last_name, consent_given, consent_given_at, last_seen_at, created_at, appointments!appointments_patient_id_fkey(count), conversations!conversations_patient_id_fkey(count)",
        { count: "exact" },
      )
      .eq("clinic_id", staff.clinicId)
      .order("last_seen_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);

    if (onlyTelegram) query = query.not("telegram_user_id", "is", null);
    if (noConsent) query = query.eq("consent_given", false);

    if (q) {
      query = query.or(
        `full_name.ilike.%${q}%,phone.ilike.%${q}%,telegram_username.ilike.%${q}%,telegram_first_name.ilike.%${q}%`,
      );
    }

    const { data, error, count } = await query;
    if (error) throw error;

    const patients = (data ?? []).map((p) => ({
      ...p,
      appointments_count: (p.appointments as unknown as [{ count: number }] | null)?.[0]?.count ?? 0,
      conversations_count: (p.conversations as unknown as [{ count: number }] | null)?.[0]?.count ?? 0,
    }));

    return ok({ patients, total: count ?? 0, page, pageSize: PAGE_SIZE });
  } catch (e) {
    return handleApiError(e);
  }
}

/**
 * Updates a patient's operational note — front-desk logistics only (e.g.
 * preferred appointment times, communication constraints), never a
 * clinical/diagnostic record. Same operational-staff roles as the list/
 * detail GET above.
 */
export async function PATCH(request: NextRequest) {
  try {
    const staff = await requireRoles("owner", "admin", "manager", "receptionist");
    const body = await parseBody(request, notesSchema);
    const supabase = createAdminClient();

    const { data, error } = await supabase
      .from("patients")
      .update({ operational_notes: body.operationalNotes || null })
      .eq("id", body.patientId)
      .eq("clinic_id", staff.clinicId)
      .select("id, operational_notes")
      .maybeSingle();
    if (error) throw new ApiError(500, "Izohni saqlab bo‘lmadi");
    if (!data) throw new ApiError(404, "Bemor topilmadi", "patient_not_found");

    return ok({ patient: data });
  } catch (e) {
    return handleApiError(e);
  }
}
