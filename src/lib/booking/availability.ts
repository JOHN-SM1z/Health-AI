import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateSlots, type WorkingHoursRow, type TimeBlock, type ExistingAppointment } from "@/lib/booking/slots";
import { ApiError } from "@/lib/api/errors";
import { fromClinicTime, clinicDayLabel } from "@/lib/timezone";

export type AvailabilitySlot = {
  start: string;
  end: string;
  startLocal: string;
  dayLocal: string;
  doctorId: string;
  doctorName: string;
};

/**
 * Real available slots for a clinic (optionally narrowed to one service
 * and/or one doctor), computed server-side from actual working hours, time
 * blocks and existing appointments — never from frontend assumptions.
 *
 * Clinic scope is always passed in by the caller, which is the actual trust
 * boundary: the public /api/availability route resolves it from the Mini
 * App's own ?clinic= URL (an intentionally public, unauthenticated lookup),
 * while /api/admin/availability resolves it from the staff session. Neither
 * caller may ever substitute a client-supplied clinic id for the other's.
 */
export async function getAvailability(params: {
  clinicId: string;
  timezone: string;
  serviceId?: string;
  doctorId?: string;
  days: number;
}): Promise<{ serviceDurationMinutes: number | null; slots: AvailabilitySlot[] }> {
  const { clinicId, timezone, serviceId, doctorId, days } = params;
  const supabase = createAdminClient();

  let durationMinutes: number | null = null;
  if (serviceId) {
    const { data: service } = await supabase
      .from("services")
      .select("duration_minutes, clinic_id")
      .eq("id", serviceId)
      .eq("clinic_id", clinicId)
      .eq("active", true)
      .maybeSingle();
    if (!service) throw new ApiError(404, "Xizmat topilmadi", "service_not_found");
    durationMinutes = service.duration_minutes;
  }

  let doctorIds: string[] = [];
  if (doctorId) {
    const { data: doctor } = await supabase
      .from("doctors")
      .select("id")
      .eq("id", doctorId)
      .eq("clinic_id", clinicId)
      .eq("active", true)
      .maybeSingle();
    if (!doctor) throw new ApiError(404, "Shifokor topilmadi", "doctor_not_found");
    doctorIds = [doctor.id];
  } else {
    const { data: doctors } = await supabase.from("doctors").select("id").eq("clinic_id", clinicId).eq("active", true);
    doctorIds = (doctors ?? []).map((d) => d.id);
  }

  // Per-doctor service eligibility + duration override — must match
  // book_appointment()'s own semantics exactly (same opt-in rule: a doctor
  // with ANY doctor_services rows is restricted to that explicit list, with
  // its own duration_override_minutes when set; a doctor with none offers
  // every service at the base duration).
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

  const dayStart = fromClinicTime(`${clinicDayLabel(new Date(), timezone)}T00:00:00`, timezone);

  const slotsByDoctor: Record<string, AvailabilitySlot[]> = {};

  // Batched once for every doctor instead of once per doctor: avoids an N+1
  // round trip when no doctorId filter fans this out to every active doctor.
  const workingHoursByDoctor = new Map<string, WorkingHoursRow[]>();
  const timeBlocksByDoctor = new Map<string, TimeBlock[]>();
  const appointmentsByDoctor = new Map<string, ExistingAppointment[]>();

  if (doctorIds.length > 0) {
    const [workingHoursRes, timeBlocksRes, appointmentsRes] = await Promise.all([
      supabase.from("doctor_working_hours").select("doctor_id, weekday, start_time, end_time").in("doctor_id", doctorIds),
      supabase
        .from("doctor_time_blocks")
        .select("doctor_id, starts_at, ends_at")
        .in("doctor_id", doctorIds)
        .gte("ends_at", dayStart.toISOString()),
      supabase
        .from("appointments")
        .select("doctor_id, start_at, end_at, status")
        .in("doctor_id", doctorIds)
        .gte("end_at", dayStart.toISOString()),
    ]);
    for (const row of workingHoursRes.data ?? []) {
      const list = workingHoursByDoctor.get(row.doctor_id) ?? [];
      list.push(row);
      workingHoursByDoctor.set(row.doctor_id, list);
    }
    for (const row of timeBlocksRes.data ?? []) {
      const list = timeBlocksByDoctor.get(row.doctor_id) ?? [];
      list.push(row);
      timeBlocksByDoctor.set(row.doctor_id, list);
    }
    for (const row of appointmentsRes.data ?? []) {
      const list = appointmentsByDoctor.get(row.doctor_id) ?? [];
      list.push(row);
      appointmentsByDoctor.set(row.doctor_id, list);
    }
  }

  for (const id of doctorIds) {
    // This doctor has an explicit service list that doesn't include the
    // requested service — book_appointment would reject it outright
    // (service_not_offered), so no slot shown here could ever be booked.
    if (serviceId && restrictedDoctorIds.has(id) && !doctorServiceById.has(id)) {
      slotsByDoctor[id] = [];
      continue;
    }

    const effectiveDuration = doctorServiceById.get(id)?.duration_override_minutes ?? durationMinutes ?? 20;

    const slots = generateSlots({
      timezone,
      workingHours: workingHoursByDoctor.get(id) ?? [],
      timeBlocks: timeBlocksByDoctor.get(id) ?? [],
      existingAppointments: appointmentsByDoctor.get(id) ?? [],
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

  if (doctorIds.length > 0) {
    const { data: doctors } = await supabase.from("doctors").select("id, name").in("id", doctorIds);
    for (const d of doctors ?? []) {
      for (const slot of slotsByDoctor[d.id] ?? []) slot.doctorName = d.name;
    }
  }

  const slots = Object.values(slotsByDoctor)
    .flat()
    .sort((a, b) => a.start.localeCompare(b.start));

  return { serviceDurationMinutes: durationMinutes, slots };
}
