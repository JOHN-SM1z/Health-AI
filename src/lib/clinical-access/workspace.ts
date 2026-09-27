import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { recordAudit } from "@/lib/audit";
import { localDayWindow } from "@/lib/time/local";
import type { LinkedDoctor } from "@/lib/auth/guards";
import { canDoctorAccessPatientClinicalData, type ClinicalAccess, type ClinicalRelationship } from "@/lib/clinical-access/access";
import { listVisibleClinicalRecords, type ClinicalRecordView } from "@/lib/clinical-records/service";
import { listPatientReferralsForDoctor, type PatientReferral } from "@/lib/referrals/service";
import { patientAccessDenied } from "@/lib/clinical-access/denial";

/**
 * A doctor's clinical workspace for one patient: everything on it — the
 * patient, consultations, clinical records, referrals — is read after, and
 * scoped by, the clinical access decision (canDoctorAccessPatientClinicalData);
 * the page only renders what this returns.
 */

export type ClinicalAppointment = {
  id: string;
  startAt: string;
  endAt: string;
  status: string;
  /** The calling doctor's own appointment. */
  mine: boolean;
  doctor: { id: string; name: string } | null;
  service: { name: string } | null;
};

export type ConsultationRef = { appointmentId: string; startAt: string; serviceName: string | null };

export type PatientWorkspace = {
  patient: { id: string; fullName: string | null; phone: string | null; preferredLanguage: string };
  relationship: Exclude<ClinicalRelationship, "none">;
  activeReferralIds: string[];
  /** Consultations the decision covers, newest first. */
  appointments: ClinicalAppointment[];
  /** Clinical records the decision covers, with provenance, newest first. */
  records: ClinicalRecordView[];
  /** Referrals of this patient the doctor is on and may see, with their text. */
  referrals: PatientReferral[];
  consultation: {
    /** The doctor's own consultation with the patient that is in progress. */
    current: ConsultationRef | null;
    /** The doctor's own visit with the patient booked for today, not started yet. */
    booked: ConsultationRef | null;
    /** Whether the doctor may start a walk-in consultation now. */
    canStartWalkIn: boolean;
    blockedReason: "referral_pending" | null;
    /** Services the doctor can see the patient for. */
    services: Array<{ id: string; name: string }>;
  };
};

type AppointmentRow = {
  id: string;
  start_at: string;
  end_at: string;
  status: string;
  doctor_id: string;
  services: { name: string } | null;
  doctors: { name: string } | null;
};

/** Whether `access` lets the doctor start a consultation (own patient or an accepted referral). */
export function canStartConsultation(access: ClinicalAccess): boolean {
  return access.allowed && (access.scope.ownAppointments || access.scope.sharedHistoryDoctorIds.length > 0);
}

async function doctorServices(doctor: LinkedDoctor): Promise<Array<{ id: string; name: string }>> {
  const supabase = createAdminClient();
  const { data: linked } = await supabase.from("doctor_services").select("service_id").eq("doctor_id", doctor.doctorId);
  const ids = (linked ?? []).map((l) => l.service_id);
  // Mirrors the booking engine: a doctor with a service list offers only those.
  let query = supabase.from("services").select("id, name").eq("clinic_id", doctor.clinicId).eq("active", true).order("name");
  if (ids.length > 0) query = query.in("id", ids);
  const { data } = await query;
  return data ?? [];
}

export async function getPatientWorkspace(doctor: LinkedDoctor, patientId: string): Promise<PatientWorkspace> {
  const access = await canDoctorAccessPatientClinicalData(doctor.doctorId, patientId);
  if (!access.allowed || access.relationship === "none") throw await patientAccessDenied(doctor, patientId);

  // What is shown comes from the decision alone, never from the request:
  // the doctors whose visits are covered, plus referral-linked appointments.
  const visibleDoctorIds = [
    ...(access.scope.ownAppointments ? [doctor.doctorId] : []),
    ...access.scope.sharedHistoryDoctorIds,
  ];
  const coverage = [
    visibleDoctorIds.length > 0 ? `doctor_id.in.(${visibleDoctorIds.join(",")})` : null,
    access.scope.referralAppointmentIds.length > 0 ? `id.in.(${access.scope.referralAppointmentIds.join(",")})` : null,
  ].filter(Boolean);

  const supabase = createAdminClient();
  const [patientRes, appointmentsRes, records, referrals, services] = await Promise.all([
    supabase
      .from("patients")
      .select("id, full_name, phone, preferred_language")
      .eq("id", patientId)
      .eq("clinic_id", doctor.clinicId)
      .maybeSingle(),
    coverage.length > 0
      ? supabase
          .from("appointments")
          .select("id, start_at, end_at, status, doctor_id, services(name), doctors(name)")
          .eq("clinic_id", doctor.clinicId)
          .eq("patient_id", patientId)
          .or(coverage.join(","))
          .order("start_at", { ascending: false })
          .limit(100)
      : null,
    listVisibleClinicalRecords(doctor, patientId, access),
    listPatientReferralsForDoctor(doctor, patientId),
    doctorServices(doctor),
  ]);
  if (patientRes.error || appointmentsRes?.error) throw new ApiError(500, "Bemor ma‘lumotlarini yuklab bo‘lmadi");
  if (!patientRes.data) throw new ApiError(404, "Bemor topilmadi", "patient_not_found");

  const appointments = ((appointmentsRes?.data ?? []) as unknown as AppointmentRow[]).map((a) => ({
    id: a.id,
    startAt: a.start_at,
    endAt: a.end_at,
    status: a.status,
    mine: a.doctor_id === doctor.doctorId,
    doctor: a.doctors ? { id: a.doctor_id, name: a.doctors.name } : null,
    service: a.services,
  }));
  const asRef = (a: ClinicalAppointment): ConsultationRef => ({ appointmentId: a.id, startAt: a.startAt, serviceName: a.service?.name ?? null });
  const today = localDayWindow(doctor.clinicTimezone);
  const current = appointments.find((a) => a.mine && a.status === "in_progress") ?? null;
  const booked =
    [...appointments]
      .reverse()
      .find(
        (a) =>
          a.mine &&
          ["pending", "confirmed", "checked_in"].includes(a.status) &&
          a.startAt >= today.start &&
          a.startAt < today.end,
      ) ?? null;
  const canStart = canStartConsultation(access);

  await recordAudit({
    clinicId: doctor.clinicId,
    action: "patient_clinical_record_viewed",
    entityType: "patients",
    entityId: patientId,
    actor: { actorId: doctor.profileId, actorType: "staff" },
    metadata: {
      relationship: access.relationship,
      referral_ids: access.activeReferralIds,
      shared_history_doctor_ids: access.scope.sharedHistoryDoctorIds,
      record_count: records.length,
    },
    strict: true,
  });

  return {
    patient: {
      id: patientRes.data.id,
      fullName: patientRes.data.full_name,
      phone: patientRes.data.phone,
      preferredLanguage: patientRes.data.preferred_language,
    },
    relationship: access.relationship,
    activeReferralIds: access.activeReferralIds,
    appointments,
    records,
    referrals,
    consultation: {
      current: current ? asRef(current) : null,
      booked: booked ? asRef(booked) : null,
      canStartWalkIn: canStart,
      blockedReason: !canStart && access.activeReferralIds.length > 0 ? "referral_pending" : null,
      services,
    },
  };
}
