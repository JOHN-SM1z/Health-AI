import type { NextRequest } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { getClinicFromRequest } from "@/lib/clinics/context";
import { generateSlots } from "@/lib/booking/slots";
import { handleApiError, fail, ok } from "@/lib/api/errors";
import { rateLimit, keyFromIp } from "@/lib/rate-limit";
import { fromClinicTime, clinicDayLabel } from "@/lib/timezone";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  serviceId: z.string().uuid().optional(),
  doctorId: z.string().uuid().optional(),
  days: z.coerce.number().int().min(1).max(30).default(14),
});

/**
 * Returns available slots for a doctor+service combination.
 * Slot generation runs server-side from real working hours, time blocks
 * and existing appointments — never from frontend assumptions.
 */
export async function GET(request: NextRequest) {
  try {
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const limit = rateLimit({ key: keyFromIp(ip, "availability"), limit: 60, windowMs: 10_000 });
    if (!limit.ok) return fail("Juda ko‘p so‘rov", 429, "rate_limited");

    const query = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
    if (!query.success) return fail("Noto‘g‘ri so‘rov parametrlari", 400, "validation");

    const { serviceId, doctorId, days } = query.data;
    const supabase = createAdminClient();
    const clinic = await getClinicFromRequest(request);
    const timezone = clinic.timezone;

    // Service determines the slot duration.
    let durationMinutes: number | null = null;
    if (serviceId) {
      const { data: service } = await supabase
        .from("services")
        .select("duration_minutes, clinic_id")
        .eq("id", serviceId)
        .eq("clinic_id", clinic.id)
        .eq("active", true)
        .maybeSingle();
      if (!service) return fail("Xizmat topilmadi", 404, "service_not_found");
      durationMinutes = service.duration_minutes;
    }

    // Doctor list to generate slots for.
    let doctorIds: string[] = [];
    if (doctorId) {
      const { data: doctor } = await supabase
        .from("doctors")
        .select("id")
        .eq("id", doctorId)
        .eq("clinic_id", clinic.id)
        .eq("active", true)
        .maybeSingle();
      if (!doctor) return fail("Shifokor topilmadi", 404, "doctor_not_found");
      doctorIds = [doctor.id];
    } else {
      const { data: doctors } = await supabase
        .from("doctors")
        .select("id")
        .eq("clinic_id", clinic.id)
        .eq("active", true);
      doctorIds = (doctors ?? []).map((d) => d.id);
    }

    // Per-doctor service eligibility + duration override — must match
    // book_appointment()'s own semantics exactly (same opt-in rule: a
    // doctor with ANY doctor_services rows is restricted to that explicit
    // list, with its own duration_override_minutes when set; a doctor with
    // none offers every service at the base duration). Computed once here
    // rather than duplicated per-doctor inside the loop below.
    const doctorServiceById = new Map<string, { duration_override_minutes: number | null }>();
    const restrictedDoctorIds = new Set<string>();
    if (serviceId && doctorIds.length > 0) {
      const { data: doctorServices } = await supabase
        .from("doctor_services")
        .select("doctor_id, service_id, duration_override_minutes")
        .in("doctor_id", doctorIds);
      for (const ds of doctorServices ?? []) {
        restrictedDoctorIds.add(ds.doctor_id);
        if (ds.service_id === serviceId) {
          doctorServiceById.set(ds.doctor_id, { duration_override_minutes: ds.duration_override_minutes });
        }
      }
    }

    const todayLocal = new Date();
    const dayStart = fromClinicTime(`${clinicDayLabel(todayLocal, timezone)}T00:00:00`, timezone);

    const slotsByDoctor: Record<string, Array<{ start: string; end: string; startLocal: string; dayLocal: string; doctorId: string; doctorName: string }>> = {};

    for (const id of doctorIds) {
      // This doctor has an explicit service list that doesn't include the
      // requested service — book_appointment would reject it outright
      // (service_not_offered), so no slot shown here could ever be booked.
      if (serviceId && restrictedDoctorIds.has(id) && !doctorServiceById.has(id)) {
        slotsByDoctor[id] = [];
        continue;
      }

      const [workingHours, timeBlocks, appointments] = await Promise.all([
        supabase.from("doctor_working_hours").select("weekday, start_time, end_time").eq("doctor_id", id),
        supabase
          .from("doctor_time_blocks")
          .select("starts_at, ends_at")
          .eq("doctor_id", id)
          .gte("ends_at", dayStart.toISOString()),
        supabase
          .from("appointments")
          .select("start_at, end_at, status")
          .eq("doctor_id", id)
          .gte("end_at", dayStart.toISOString()),
      ]);

      const effectiveDuration = doctorServiceById.get(id)?.duration_override_minutes ?? durationMinutes ?? 20;

      const slots = generateSlots({
        timezone,
        workingHours: workingHours.data ?? [],
        timeBlocks: timeBlocks.data ?? [],
        existingAppointments: appointments.data ?? [],
        serviceDurationMinutes: effectiveDuration,
        dayStart,
        dayCount: days,
      });

      slotsByDoctor[id] = slots.map((s) => ({
        start: s.start.toISOString(),
        end: s.end.toISOString(),
        startLocal: s.startLocal,
        dayLocal: s.dayLocal,
        doctorId: id,
        doctorName: "",
      }));
    }

    // Attach doctor names.
    if (doctorIds.length > 0) {
      const { data: doctors } = await supabase
        .from("doctors")
        .select("id, name")
        .in("id", doctorIds);
      for (const d of doctors ?? []) {
        for (const slot of slotsByDoctor[d.id] ?? []) slot.doctorName = d.name;
      }
    }

    const slots = Object.values(slotsByDoctor).flat().sort((a, b) => a.start.localeCompare(b.start));

    return ok({
      timezone,
      serviceDurationMinutes: durationMinutes,
      slots,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    return handleApiError(e);
  }
}