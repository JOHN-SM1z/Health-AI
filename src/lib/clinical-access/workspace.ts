import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { recordAudit } from "@/lib/audit";
import { localDayWindow } from "@/lib/time/local";
import type { LinkedDoctor } from "@/lib/auth/guards";
import type { Database } from "@/lib/supabase/database.types";
import { canDoctorAccessPatientClinicalData, type ClinicalAccess, type ClinicalRelationship } from "@/lib/clinical-access/access";
import { listVisibleClinicalRecords, type ClinicalRecordView } from "@/lib/clinical-records/service";
import { listPatientReferralsForDoctor, type PatientReferral } from "@/lib/referrals/service";
import { patientAccessDenied } from "@/lib/clinical-access/denial";
import { loadFinalisedSummaries, type LabResultSummary } from "@/lib/labs/longitudinal";
import { recordCategory, type RecordCategory, type RecordStage } from "@/lib/clinical-records/categories";

/**
 * A doctor's workspace for one patient: the patient's longitudinal clinic
 * record — every doctor's consultations and clinical records, the patient's
 * referrals — as the clinical access decision (canDoctorAccessPatientClinicalData)
 * allows it. Everything on it is read after that decision; the page only
 * renders what this returns. No payment history, staff or clinic data: only
 * the payment status of the doctor's own visit in front of them.
 */

export type PaymentStatus = Database["public"]["Enums"]["payment_status"];

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

export type ConsultationRef = {
  appointmentId: string;
  startAt: string;
  serviceName: string | null;
  /** Whether this visit is paid — the only payment detail a doctor sees. Null: no payment record. */
  paymentStatus: PaymentStatus | null;
};

/**
 * A record as the calling doctor sees it: written in their consultation
 * under way (current) or earlier (historical) — e.g. the referring doctor's
 * diagnosis is a historical diagnosis, the receiving doctor's own one a new
 * diagnosis. The record itself is never changed, and stays its author's.
 */
export type WorkspaceRecord = ClinicalRecordView & { stage: RecordStage; category: RecordCategory };

export type PatientWorkspace = {
  patient: { id: string; fullName: string | null; phone: string | null; preferredLanguage: string };
  relationship: Exclude<ClinicalRelationship, "none">;
  activeReferralIds: string[];
  /**
   * When access that rests only on a referral ends at the latest (the open
   * referrals' expires_at) — null for a doctor with their own relationship.
   * It ends earlier if the referral is declined or revoked.
   */
  referralAccessUntil: string | null;
  /** The patient's consultations in the clinic, every doctor's, newest first. */
  appointments: ClinicalAppointment[];
  /** The current version of every clinical record, with provenance, newest first. */
  records: WorkspaceRecord[];
  /** The patient's referrals, with their text — actions only where the doctor is on them. */
  referrals: PatientReferral[];
  /**
   * The patient's FINALISED laboratory results (summaries only; values are opened one result at a time), every doctor's, as part of the
   * same longitudinal record. Work in progress - drafts, unverified, abandoned - is never included.
   */
  labResults: LabResultSummary[];
  consultation: {
    /** The doctor's own consultation with the patient that is in progress. */
    current: ConsultationRef | null;
    /** The doctor's own visit with the patient booked for today, not started yet. */
    booked: ConsultationRef | null;
    /** Whether the doctor may start a walk-in consultation now. */
    canStartWalkIn: boolean;
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

const APPOINTMENT_COLUMNS = "id, start_at, end_at, status, doctor_id, services(name), doctors(name)";

function referralAccessUntil(access: ClinicalAccess, referrals: PatientReferral[]): string | null {
  if (access.relationship !== "referred") return null;
  const open = referrals.filter((r) => access.activeReferralIds.includes(r.id));
  return open.length > 0 ? open.map((r) => r.expiresAt).sort().at(-1)! : null;
}

/**
 * Whether `access` lets the doctor start a consultation: any legitimate
 * relationship — their own patient, or an open referral (a pending one is
 * accepted as the consultation starts; see startConsultation).
 */
export function canStartConsultation(access: ClinicalAccess): boolean {
  return access.allowed;
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

/** Payment status of the doctor's own visits in front of them (never amounts or other visits). */
async function paymentStatusOf(doctor: LinkedDoctor, appointmentIds: string[]): Promise<Map<string, PaymentStatus>> {
  if (appointmentIds.length === 0) return new Map();
  const { data, error } = await createAdminClient()
    .from("payments")
    .select("appointment_id, status")
    .eq("clinic_id", doctor.clinicId)
    .in("appointment_id", appointmentIds);
  if (error) throw new ApiError(500, "Bemor ma‘lumotlarini yuklab bo‘lmadi");
  // A laboratory payment has no appointment: it is never a visit's payment.
  return new Map((data ?? []).flatMap((p) => (p.appointment_id ? [[p.appointment_id, p.status] as const] : [])));
}

export async function getPatientWorkspace(doctor: LinkedDoctor, patientId: string): Promise<PatientWorkspace> {
  const access = await canDoctorAccessPatientClinicalData(doctor.doctorId, patientId);
  if (!access.allowed || access.relationship === "none") throw await patientAccessDenied(doctor, patientId);

  const supabase = createAdminClient();
  const [patientRes, appointmentsRes, records, referrals, services, labResults] = await Promise.all([
    supabase
      .from("patients")
      .select("id, full_name, phone, preferred_language")
      .eq("id", patientId)
      .eq("clinic_id", doctor.clinicId)
      .maybeSingle(),
    supabase
      .from("appointments")
      .select(APPOINTMENT_COLUMNS)
      .eq("clinic_id", doctor.clinicId)
      .eq("patient_id", patientId)
      .order("start_at", { ascending: false })
      .limit(200),
    listVisibleClinicalRecords(doctor, patientId, access),
    listPatientReferralsForDoctor(doctor, patientId),
    doctorServices(doctor),
    // Finalised laboratory results join the same record; the access decision above already allowed the whole history.
    loadFinalisedSummaries(doctor.doctorId, doctor.clinicId, patientId, 50),
  ]);
  if (patientRes.error || appointmentsRes.error) throw new ApiError(500, "Bemor ma‘lumotlarini yuklab bo‘lmadi");
  if (!patientRes.data) throw new ApiError(404, "Bemor topilmadi", "patient_not_found");

  // A record always comes with its consultation, even one older than the
  // visit window above.
  const rows = (appointmentsRes.data ?? []) as unknown as AppointmentRow[];
  const listed = new Set(rows.map((a) => a.id));
  const missing = [...new Set(records.map((r) => r.appointmentId))].filter((id) => !listed.has(id));
  for (let i = 0; i < missing.length; i += 150) {
    const { data: older, error } = await supabase
      .from("appointments")
      .select(APPOINTMENT_COLUMNS)
      .eq("clinic_id", doctor.clinicId)
      .eq("patient_id", patientId)
      .in("id", missing.slice(i, i + 150));
    if (error) throw new ApiError(500, "Bemor ma‘lumotlarini yuklab bo‘lmadi");
    rows.push(...((older ?? []) as unknown as AppointmentRow[]));
  }
  if (missing.length > 0) rows.sort((a, b) => b.start_at.localeCompare(a.start_at));

  const appointments = rows.map((a) => ({
    id: a.id,
    startAt: a.start_at,
    endAt: a.end_at,
    status: a.status,
    mine: a.doctor_id === doctor.doctorId,
    doctor: a.doctors ? { id: a.doctor_id, name: a.doctors.name } : null,
    service: a.services,
  }));
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
  const payments = await paymentStatusOf(doctor, [current?.id, booked?.id].filter((id): id is string => !!id));
  const asRef = (a: ClinicalAppointment): ConsultationRef => ({
    appointmentId: a.id,
    startAt: a.startAt,
    serviceName: a.service?.name ?? null,
    paymentStatus: payments.get(a.id) ?? null,
  });

  // The access log names the patient, the relationship the access rests on
  // (and the referral, when exactly one), and which records were shown —
  // ids only, written before anything is returned.
  await recordAudit({
    clinicId: doctor.clinicId,
    action: "clinical_record_viewed",
    entityType: "patients",
    entityId: patientId,
    patientId,
    referralId: access.relationship === "referred" && access.activeReferralIds.length === 1 ? access.activeReferralIds[0] : null,
    actor: { actorId: doctor.profileId, actorType: "staff" },
    metadata: {
      via: "workspace",
      relationship: access.relationship,
      referral_ids: access.activeReferralIds,
      shown_referral_ids: referrals.map((r) => r.id),
      record_count: records.length,
      record_ids: records.map((r) => r.id),
      other_author_record_ids: records.filter((r) => !r.mine).map((r) => r.id),
      lab_result_item_ids: labResults.map((r) => r.itemId),
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
    referralAccessUntil: referralAccessUntil(access, referrals),
    appointments,
    records: records.map((r) => {
      const stage: RecordStage = current && r.appointmentId === current.id ? "current" : "historical";
      return { ...r, stage, category: recordCategory(r.type, stage) };
    }),
    referrals,
    labResults,
    consultation: {
      current: current ? asRef(current) : null,
      booked: booked ? asRef(booked) : null,
      canStartWalkIn: canStartConsultation(access),
      services,
    },
  };
}
