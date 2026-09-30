import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { recordAudit, recordAudits } from "@/lib/audit";
import { logger } from "@/lib/logger";
import type { LinkedDoctor } from "@/lib/auth/guards";
import { canDoctorAccessPatientClinicalData } from "@/lib/clinical-access/access";
import type { StaffContext } from "@/lib/auth/staff";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Referral workflow on top of public.referrals — a clinical handoff between
 * doctors or to a department, never a permission request: the receiving
 * doctor sees the patient's history from the moment the referral exists
 * (see src/lib/clinical-access/access.ts). The database is the authority on
 * every rule (same clinic, consultation actually took place,
 * status machine, who may act, immutability, audit trail — see
 * supabase/migrations/20260926000001_referrals.sql); this module resolves
 * which side of a referral the caller is on, shapes responses, logs access,
 * and turns rule violations into API errors. Clinical text (reason, handoff
 * note, decline/revocation reasons) is only ever returned to the two
 * doctors on the referral and is never logged.
 */

export type ReferralStatus = Database["public"]["Enums"]["referral_status"];
export type ReferralPriority = Database["public"]["Enums"]["referral_priority"];
export type ReferralRole = "referrer" | "receiver";
export type ReferralAction = "accept" | "decline" | "complete" | "revoke";

type StaffInClinic = StaffContext & { clinicId: string };
type DoctorRef = { id: string; name: string; title?: string | null };
type DepartmentRef = { id: string; name: string };
type AppointmentRef = { id: string; start_at: string; status: string; services?: { name: string } | null };

/** Referrals still under way: PENDING → ACCEPTED → IN_PROGRESS, until completed, declined, revoked or expired. */
const OPEN_STATUSES: ReferralStatus[] = ["pending", "accepted", "in_progress"];
const INACTIVE_APPOINTMENT_STATUSES = ["cancelled", "no_show"];

const REFERRING = "referring:doctors!referrals_referring_doctor_same_clinic_fkey";
const REFERRED_TO = "referred_to:doctors!referrals_referred_to_doctor_same_clinic_fkey";
const DEPARTMENT = "department:specialties!referrals_referred_to_specialty_fkey";

type Recipient = { referred_to_doctor_id: string | null; referred_to_specialty_id: string | null };

/** A department referral nobody has taken yet. */
const unclaimed = (row: Recipient) => row.referred_to_doctor_id === null;

/** Status as the user should see it: an open referral past expires_at is expired. */
export function effectiveStatus(status: ReferralStatus, expiresAt: string, now = Date.now()): ReferralStatus {
  return OPEN_STATUSES.includes(status) && Date.parse(expiresAt) <= now ? "expired" : status;
}

/**
 * Which actions to offer the caller; the database re-checks every one. An
 * accepted referral moves on by the receiving doctor starting their
 * consultation (not an action here), and is completed once that started.
 */
export function allowedActions(role: ReferralRole, status: ReferralStatus, departmentOnly = false): ReferralAction[] {
  if (role === "receiver") {
    // A department referral waits for one of its doctors to take it: none of
    // them can decline it for the others.
    if (status === "pending") return departmentOnly ? ["accept"] : ["accept", "decline"];
    if (status === "in_progress") return ["complete"];
    return [];
  }
  return OPEN_STATUSES.includes(status) ? ["revoke"] : [];
}

function roleOf(doctor: LinkedDoctor, row: { referring_doctor_id: string } & Recipient): ReferralRole | null {
  if (row.referring_doctor_id === doctor.doctorId) return "referrer";
  if (row.referred_to_doctor_id === doctor.doctorId) return "receiver";
  // Every doctor of the department receives a department referral until one
  // of them takes it.
  if (unclaimed(row) && doctor.specialtyId && row.referred_to_specialty_id === doctor.specialtyId) return "receiver";
  return null;
}

/**
 * Same rule as the "referrals read for receiving doctor" RLS policy: the
 * referring doctor always sees their referral; the receiving doctor while it
 * is open or completed — and never past expires_at, so a completed referral
 * does not stay readable forever. (An open one past expires_at is already
 * reported as expired by effectiveStatus.)
 */
function visibleTo(role: ReferralRole | null, status: ReferralStatus, expiresAt: string, now = Date.now()): boolean {
  if (role === "referrer") return true;
  return role === "receiver" && (OPEN_STATUSES.includes(status) || status === "completed") && Date.parse(expiresAt) > now;
}

/** Incoming for this doctor: addressed to them, or to their department while untaken — never their own referral. */
function incomingFilter(doctor: LinkedDoctor): string {
  return doctor.specialtyId
    ? `referred_to_doctor_id.eq.${doctor.doctorId},and(referred_to_doctor_id.is.null,referred_to_specialty_id.eq.${doctor.specialtyId},status.eq.pending,referring_doctor_id.neq.${doctor.doctorId})`
    : `referred_to_doctor_id.eq.${doctor.doctorId}`;
}

/** Maps a database rule violation to an API error without logging row data. */
export function referralError(error: { code?: string; message?: string }): ApiError {
  const message = error.message ?? "";
  const has = (fragment: string) => message.includes(fragment);

  if (error.code === "23505" && (has("referrals_one_open_per_pair") || has("referrals_one_open_per_department"))) {
    return new ApiError(409, "Bu bemor u yerga allaqachon yo‘llangan", "referral_already_open");
  }
  if (has("does not belong to that department")) {
    return new ApiError(400, "Shifokor tanlangan bo‘limga tegishli emas", "doctor_not_in_department");
  }
  if (has("department referral is taken by accepting")) {
    return new ApiError(409, "Yo‘llanma holati buni ruxsat bermaydi", "invalid_transition");
  }
  if (error.code === "23503") {
    if (has("referrals_referred_to_doctor_same_clinic_fkey")) return new ApiError(404, "Shifokor topilmadi", "doctor_not_found");
    if (has("referrals_referred_to_specialty_fkey")) return new ApiError(404, "Bo‘lim topilmadi", "department_not_found");
    if (has("referrals_originating_appointment_fkey")) return new ApiError(404, "Qabul topilmadi", "consultation_not_found");
    if (has("referrals_patient_same_clinic_fkey")) return new ApiError(404, "Bemor topilmadi", "patient_not_found");
    if (has("referrals_follow_up_appointment_fkey")) {
      return new ApiError(409, "Qabul yo‘llanmadagi bemor va shifokorga tegishli emas", "follow_up_mismatch");
    }
  }
  if (has("referrals_not_self_referral") || has("self-referral")) {
    return new ApiError(400, "O‘zingizga yo‘llanma berib bo‘lmaydi", "self_referral");
  }
  if (has("must be in progress or completed")) {
    return new ApiError(409, "Yo‘llanma faqat boshlangan yoki yakunlangan qabuldan beriladi", "consultation_not_attended");
  }
  if (has("receiving doctor is inactive") || has("no linked doctor account")) {
    return new ApiError(409, "Bu shifokorga hozir yo‘llanma berib bo‘lmaydi", "receiving_doctor_unavailable");
  }
  if (has("referring doctor is inactive") || has("created_by must be")) {
    return new ApiError(403, "Faqat qabulni o‘tkazgan shifokor yo‘llanma bera oladi", "not_referring_doctor");
  }
  if (has("expired at")) return new ApiError(409, "Yo‘llanma muddati tugagan", "referral_expired");
  if (has("in progress only once") || has("invalid status transition accepted -> completed")) {
    return new ApiError(409, "Avval bemor bilan qabulingizni boshlang", "consultation_not_started");
  }
  if (has("invalid status transition") || has("cannot be edited") || has("may only set its own fields")) {
    return new ApiError(409, "Yo‘llanma holati buni ruxsat bermaydi", "invalid_transition");
  }
  if (has("only the receiving doctor") || has("only the referring doctor")) {
    return new ApiError(403, "Bu amal uchun ruxsat yo‘q", "forbidden");
  }
  if (has("only be booked once the referral is accepted")) {
    return new ApiError(409, "Yo‘llanma hali qabul qilinmagan", "referral_not_accepted");
  }
  if (has("already booked")) return new ApiError(409, "Bu yo‘llanma uchun qabul allaqachon yozilgan", "follow_up_exists");
  if (has("follow-up appointment is cancelled")) {
    return new ApiError(409, "Bekor qilingan qabulni bog‘lab bo‘lmaydi", "follow_up_cancelled");
  }
  if (error.code === "23514" || error.code === "23502") return new ApiError(400, "Yo‘llanma ma‘lumotlari noto‘g‘ri", "validation");

  // Only the code is logged: a database error's detail can echo the row.
  logger.error("referral write failed", { code: error.code });
  return new ApiError(500, "Yo‘llanmani saqlab bo‘lmadi", "referral_write_failed");
}

const LAPSED: Partial<Record<ReferralStatus, [string, string]>> = {
  revoked: ["referral_revoked", "Yo‘llanma bekor qilingan"],
  expired: ["referral_expired", "Yo‘llanma muddati tugagan"],
  declined: ["referral_declined", "Yo‘llanma rad etilgan"],
  completed: ["referral_completed", "Yo‘llanma yakunlangan"],
};

/**
 * 410 for a referral that no longer gives its receiving doctor access (the
 * doctor was on it, so its status is no secret to them); 404 otherwise.
 */
export function lapsedReferralError(status: ReferralStatus): ApiError {
  const lapsed = LAPSED[status];
  return lapsed ? new ApiError(410, lapsed[1], lapsed[0]) : new ApiError(404, "Yo‘llanma topilmadi", "referral_not_found");
}

/**
 * Records open referrals past expires_at as expired (audited by the database
 * as 'referral_expired', actor: system) — one clinic, or every clinic when
 * called by the scheduled job. Access already ended at expires_at: every
 * decision compares with the database clock; this only records it. Returns
 * how many were expired, or null if the sweep failed (reads carry on).
 */
export async function expireDueReferrals(clinicId?: string): Promise<number | null> {
  const { data, error } = await createAdminClient().rpc("expire_due_referrals", clinicId ? { p_clinic_id: clinicId } : {});
  if (error) {
    logger.warn("referral expiry sweep failed", { clinicId, code: error.code });
    return null;
  }
  return data ?? 0;
}

// ---------------------------------------------------------------------------
// Doctor side
// ---------------------------------------------------------------------------

export type ReferralSummary = {
  id: string;
  status: ReferralStatus;
  priority: ReferralPriority;
  createdAt: string;
  expiresAt: string;
  patientId: string;
  patientName: string | null;
  /** The referral's own text — both doctors on it may read it. */
  reason: string;
  handoffNote: string | null;
  referringDoctor: DoctorRef | null;
  /** Null for a department referral nobody has taken yet. */
  referredToDoctor: DoctorRef | null;
  department: DepartmentRef | null;
  allowedActions: ReferralAction[];
};

type SummaryRow = {
  id: string;
  status: ReferralStatus;
  priority: ReferralPriority;
  created_at: string;
  expires_at: string;
  patient_id: string;
  reason: string;
  handoff_note: string | null;
  referring_doctor_id: string;
  referred_to_doctor_id: string | null;
  referred_to_specialty_id: string | null;
  patient: { full_name: string | null } | null;
  referring: DoctorRef | null;
  referred_to: DoctorRef | null;
  department: DepartmentRef | null;
};

/**
 * Incoming (sent to the caller) or outgoing (sent by the caller) referrals,
 * optionally only those in one (effective) status.
 */
export async function listReferralsForDoctor(
  doctor: LinkedDoctor,
  box: "incoming" | "outgoing",
  status?: ReferralStatus,
): Promise<ReferralSummary[]> {
  await expireDueReferrals(doctor.clinicId);

  let query = createAdminClient()
    .from("referrals")
    .select(
      `id, status, priority, created_at, expires_at, patient_id, reason, handoff_note, referring_doctor_id, referred_to_doctor_id, referred_to_specialty_id, patient:patients!referrals_patient_same_clinic_fkey(full_name), ${REFERRING}(id, name), ${REFERRED_TO}(id, name), ${DEPARTMENT}(id, name)`,
    )
    .eq("clinic_id", doctor.clinicId)
    .order("created_at", { ascending: false })
    .limit(100);
  query =
    box === "incoming"
      ? query.or(incomingFilter(doctor)).in("status", [...OPEN_STATUSES, "completed"])
      : query.eq("referring_doctor_id", doctor.doctorId);
  // An open referral inside the sweep margin is still stored as open but is
  // shown as expired, so "expired" is filtered after the effective status.
  if (status && status !== "expired") query = query.eq("status", status);

  const { data, error } = await query;
  if (error) throw new ApiError(500, "Yo‘llanmalarni yuklab bo‘lmadi");

  const now = Date.now();
  const shown = ((data ?? []) as unknown as SummaryRow[])
    .map((row) => ({
      id: row.id,
      status: effectiveStatus(row.status, row.expires_at, now),
      priority: row.priority,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      patientId: row.patient_id,
      patientName: row.patient?.full_name ?? null,
      reason: row.reason,
      handoffNote: row.handoff_note,
      referringDoctor: row.referring,
      referredToDoctor: row.referred_to,
      department: row.department,
      allowedActions: allowedActions(box === "incoming" ? "receiver" : "referrer", effectiveStatus(row.status, row.expires_at, now), unclaimed(row)),
    }))
    .filter((r) => box === "outgoing" || visibleTo("receiver", r.status, r.expiresAt, now))
    .filter((r) => !status || r.status === status);

  // Each referral whose text is released is logged as viewed — before it is
  // returned, and the request fails if that write fails.
  await recordAudits(
    shown.map((r) => ({
      clinicId: doctor.clinicId,
      action: "referral_viewed",
      entityType: "referrals",
      entityId: r.id,
      patientId: r.patientId,
      referralId: r.id,
      actor: { actorId: doctor.profileId, actorType: "staff" as const },
      metadata: { via: "list", box, role: box === "incoming" ? "receiver" : "referrer", status: r.status },
    })),
    { strict: true },
  );
  return shown;
}

export type ReferralDetail = {
  id: string;
  role: ReferralRole;
  status: ReferralStatus;
  priority: ReferralPriority;
  reason: string;
  handoffNote: string | null;
  declinedReason: string | null;
  revokedReason: string | null;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  /** When the receiving doctor's consultation for the referral started. */
  startedAt: string | null;
  declinedAt: string | null;
  completedAt: string | null;
  revokedAt: string | null;
  referringDoctor: DoctorRef | null;
  /** Null for a department referral nobody has taken yet. */
  referredToDoctor: DoctorRef | null;
  department: DepartmentRef | null;
  patientId: string;
  /** Whether the caller may open the patient's record (clinical access). */
  patientRecordAccessible: boolean;
  /** The name is part of the referral record; contact details need clinical access. */
  patient: { fullName: string | null; phone: string | null; preferredLanguage: string | null } | null;
  consultation: AppointmentRef | null;
  followUp: AppointmentRef | null;
  /**
   * The patient's recent visits in the clinic (every doctor's) — part of the
   * history the referral hands over from the moment it exists. Null when
   * the caller has no clinical access to the patient.
   */
  history: AppointmentRef[] | null;
  allowedActions: ReferralAction[];
};

type DetailRow = {
  id: string;
  patient_id: string;
  referring_doctor_id: string;
  referred_to_doctor_id: string | null;
  referred_to_specialty_id: string | null;
  originating_appointment_id: string;
  follow_up_appointment_id: string | null;
  reason: string;
  handoff_note: string | null;
  priority: ReferralPriority;
  status: ReferralStatus;
  expires_at: string;
  created_at: string;
  accepted_at: string | null;
  started_at: string | null;
  declined_at: string | null;
  declined_reason: string | null;
  completed_at: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
  referring: DoctorRef | null;
  referred_to: DoctorRef | null;
  department: DepartmentRef | null;
};

/**
 * One referral for a doctor on it (404 for anyone else, so existence is not
 * revealed). The referral record — reason, note, doctors, dates, the patient's
 * name, the originating consultation and the follow-up — follows the
 * referral's own visibility; the patient's contact details and visit history
 * follow the clinical access decision (canDoctorAccessPatientClinicalData),
 * so they end the moment the referral stops being active. Every view is
 * written to the access log before any patient data is returned, and the
 * request fails if that write fails.
 */
export async function getReferralForDoctor(doctor: LinkedDoctor, referralId: string): Promise<ReferralDetail> {
  const supabase = createAdminClient();
  await expireDueReferrals(doctor.clinicId);

  const { data, error } = await supabase
    .from("referrals")
    .select(
      `id, patient_id, referring_doctor_id, referred_to_doctor_id, referred_to_specialty_id, originating_appointment_id, follow_up_appointment_id, reason, handoff_note, priority, status, expires_at, created_at, accepted_at, started_at, declined_at, declined_reason, completed_at, revoked_at, revoked_reason, ${REFERRING}(id, name, title), ${REFERRED_TO}(id, name, title), ${DEPARTMENT}(id, name)`,
    )
    .eq("id", referralId)
    .eq("clinic_id", doctor.clinicId)
    .maybeSingle();
  if (error) throw new ApiError(500, "Yo‘llanmani yuklab bo‘lmadi");

  const row = data as unknown as DetailRow | null;
  const role = row ? roleOf(doctor, row) : null;
  const status = row ? effectiveStatus(row.status, row.expires_at) : null;
  if (!row || !status || !role) throw new ApiError(404, "Yo‘llanma topilmadi", "referral_not_found");
  // The receiving doctor may learn why a referral they had is gone — never its content.
  if (!visibleTo(role, status, row.expires_at)) throw lapsedReferralError(status);

  // The referral hands over the patient's history at once — no acceptance
  // needed; everything below follows the one clinical access decision.
  const access = await canDoctorAccessPatientClinicalData(doctor.doctorId, row.patient_id);
  const historyShared = access.fullHistory;
  const contactShared = access.allowed;
  const consultationShown = access.fullHistory;
  const followUpShown = access.fullHistory && !!row.follow_up_appointment_id;
  const appointmentColumns = "id, start_at, status, services(name)";

  const [patientRes, consultationRes, followUpRes, historyRes] = await Promise.all([
    supabase
      .from("patients")
      .select("full_name, phone, preferred_language")
      .eq("id", row.patient_id)
      .eq("clinic_id", doctor.clinicId)
      .maybeSingle(),
    consultationShown
      ? supabase
          .from("appointments")
          .select(appointmentColumns)
          .eq("id", row.originating_appointment_id)
          .eq("clinic_id", doctor.clinicId)
          .maybeSingle()
      : null,
    followUpShown && row.follow_up_appointment_id
      ? supabase
          .from("appointments")
          .select(appointmentColumns)
          .eq("id", row.follow_up_appointment_id)
          .eq("clinic_id", doctor.clinicId)
          .maybeSingle()
      : null,
    historyShared
      ? supabase
          .from("appointments")
          .select(appointmentColumns)
          .eq("clinic_id", doctor.clinicId)
          .eq("patient_id", row.patient_id)
          .order("start_at", { ascending: false })
          .limit(20)
      : null,
  ]);
  if (patientRes.error || consultationRes?.error || followUpRes?.error || historyRes?.error) {
    throw new ApiError(500, "Yo‘llanmani yuklab bo‘lmadi");
  }

  await recordAudit({
    clinicId: doctor.clinicId,
    action: "referral_opened",
    entityType: "referrals",
    entityId: row.id,
    patientId: row.patient_id,
    referralId: row.id,
    actor: { actorId: doctor.profileId, actorType: "staff" },
    metadata: { via: "detail", role, status, relationship: access.relationship, history_shared: historyShared },
    strict: true,
  });

  return {
    id: row.id,
    role,
    status,
    priority: row.priority,
    reason: row.reason,
    handoffNote: row.handoff_note,
    declinedReason: row.declined_reason,
    revokedReason: row.revoked_reason,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    startedAt: row.started_at,
    declinedAt: row.declined_at,
    completedAt: row.completed_at,
    revokedAt: row.revoked_at,
    referringDoctor: row.referring,
    referredToDoctor: row.referred_to,
    department: row.department,
    patientId: row.patient_id,
    patientRecordAccessible: contactShared,
    patient: patientRes.data
      ? {
          fullName: patientRes.data.full_name,
          phone: contactShared ? patientRes.data.phone : null,
          preferredLanguage: contactShared ? patientRes.data.preferred_language : null,
        }
      : null,
    consultation: (consultationRes?.data as AppointmentRef | null | undefined) ?? null,
    followUp: (followUpRes?.data as AppointmentRef | null | undefined) ?? null,
    history: historyShared ? ((historyRes?.data ?? []) as AppointmentRef[]) : null,
    allowedActions: allowedActions(role, status, unclaimed(row)),
  };
}

export type PatientReferral = {
  id: string;
  /** The caller's side of it — "observer" when they are on neither side (read-only). */
  role: ReferralRole | "observer";
  status: ReferralStatus;
  priority: ReferralPriority;
  reason: string;
  handoffNote: string | null;
  createdAt: string;
  expiresAt: string;
  referringDoctor: DoctorRef | null;
  referredToDoctor: DoctorRef | null;
  department: DepartmentRef | null;
  followUpAppointmentId: string | null;
  acceptedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  allowedActions: ReferralAction[];
};

/**
 * All of the patient's referrals — part of their longitudinal clinic record —
 * for a doctor the clinical access decision already gave the patient's
 * history (call it only after that decision). Actions only where the doctor
 * is on the referral.
 */
export async function listPatientReferralsForDoctor(doctor: LinkedDoctor, patientId: string): Promise<PatientReferral[]> {
  const { data, error } = await createAdminClient()
    .from("referrals")
    .select(
      `id, status, priority, reason, handoff_note, created_at, expires_at, accepted_at, started_at, completed_at, follow_up_appointment_id, referring_doctor_id, referred_to_doctor_id, referred_to_specialty_id, ${REFERRING}(id, name), ${REFERRED_TO}(id, name), ${DEPARTMENT}(id, name)`,
    )
    .eq("clinic_id", doctor.clinicId)
    .eq("patient_id", patientId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new ApiError(500, "Yo‘llanmalarni yuklab bo‘lmadi");

  const now = Date.now();
  const rows = (data ?? []) as unknown as Array<
    {
      id: string;
      status: ReferralStatus;
      priority: ReferralPriority;
      reason: string;
      handoff_note: string | null;
      created_at: string;
      expires_at: string;
      accepted_at: string | null;
      started_at: string | null;
      completed_at: string | null;
      follow_up_appointment_id: string | null;
      referring_doctor_id: string;
      referring: DoctorRef | null;
      referred_to: DoctorRef | null;
      department: DepartmentRef | null;
    } & Recipient
  >;
  return rows.map((row) => {
    const role = roleOf(doctor, row);
    const status = effectiveStatus(row.status, row.expires_at, now);
    return {
      id: row.id,
      role: role ?? "observer",
      status,
      priority: row.priority,
      reason: row.reason,
      handoffNote: row.handoff_note,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      referringDoctor: row.referring,
      referredToDoctor: row.referred_to,
      department: row.department,
      followUpAppointmentId: row.follow_up_appointment_id,
      acceptedAt: row.accepted_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      allowedActions: role ? allowedActions(role, status, unclaimed(row)) : [],
    };
  });
}

/**
 * The receiving doctor's latest referral for a patient, for explaining a
 * refusal ("revoked", "expired"…). Null when there never was one.
 */
export async function latestReferralToDoctor(
  doctor: LinkedDoctor,
  patientId: string,
): Promise<{ id: string; status: ReferralStatus; expiresAt: string } | null> {
  const { data } = await createAdminClient()
    .from("referrals")
    .select("id, status, expires_at")
    .eq("clinic_id", doctor.clinicId)
    .eq("patient_id", patientId)
    .eq("referred_to_doctor_id", doctor.doctorId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? { id: data.id, status: effectiveStatus(data.status, data.expires_at), expiresAt: data.expires_at } : null;
}

export type CreateReferralInput = {
  /** One random key per intended referral; a repeat of the request replays it. */
  idempotencyKey: string;
  appointmentId: string;
  /** A doctor, a department, or both (the doctor then from that department). */
  referredToDoctorId?: string | null;
  referredToSpecialtyId?: string | null;
  reason: string;
  handoffNote?: string | null;
  priority: ReferralPriority;
  validForDays?: number;
};

export type CreatedReferral = { id: string; replayed: boolean };

type KeyedReferral = {
  id: string;
  originating_appointment_id: string;
  referred_to_doctor_id: string | null;
  referred_to_specialty_id: string | null;
  reason: string;
  handoff_note: string | null;
  priority: ReferralPriority;
};

/** The referral this doctor already created with this key, if any. */
async function findByCreationKey(doctor: LinkedDoctor, key: string): Promise<KeyedReferral | null> {
  const { data, error } = await createAdminClient()
    .from("referrals")
    .select("id, originating_appointment_id, referred_to_doctor_id, referred_to_specialty_id, reason, handoff_note, priority")
    .eq("clinic_id", doctor.clinicId)
    .eq("referring_doctor_id", doctor.doctorId)
    .eq("creation_key", key)
    .maybeSingle();
  if (error) throw new ApiError(500, "Yo‘llanmani tekshirib bo‘lmadi");
  return data;
}

/**
 * A repeated submission resolves to the referral it already created. A key
 * reused for a different referral is refused rather than silently answered
 * with someone else's result.
 */
function replay(previous: KeyedReferral, input: CreateReferralInput): CreatedReferral {
  const same =
    previous.originating_appointment_id === input.appointmentId &&
    // A department referral a doctor has since taken still replays: only a
    // doctor named in the request has to match the stored one.
    (input.referredToDoctorId ? previous.referred_to_doctor_id === input.referredToDoctorId : !input.referredToSpecialtyId ? previous.referred_to_doctor_id === null : true) &&
    previous.referred_to_specialty_id === (input.referredToSpecialtyId || null) &&
    previous.reason === input.reason &&
    previous.handoff_note === (input.handoffNote || null) &&
    previous.priority === input.priority;
  if (!same) {
    throw new ApiError(409, "Bu so‘rov boshqa ma‘lumotlar bilan allaqachon yuborilgan", "idempotency_key_reused");
  }
  return { id: previous.id, replayed: true };
}

/**
 * The receiving doctor must be a colleague the caller may refer to: a doctor
 * record in the caller's own clinic (anything else is "not found", so other
 * clinics' doctors are never revealed), active, linked to a staff account
 * that holds the doctor role, and not the caller. Same rule as
 * listReferralRecipients, checked before anything is written; the database
 * trigger and composite foreign key enforce it again on insert.
 */
async function assertReferralRecipient(doctor: LinkedDoctor, doctorId: string, specialtyId: string | null): Promise<void> {
  if (doctorId === doctor.doctorId) throw new ApiError(400, "O‘zingizga yo‘llanma berib bo‘lmaydi", "self_referral");

  const supabase = createAdminClient();
  const { data: target, error } = await supabase
    .from("doctors")
    .select("id, active, profile_id, specialty_id")
    .eq("id", doctorId)
    .eq("clinic_id", doctor.clinicId)
    .maybeSingle();
  if (error) throw new ApiError(500, "Shifokorni tekshirib bo‘lmadi");
  if (!target) throw new ApiError(404, "Shifokor topilmadi", "doctor_not_found");
  if (target.profile_id === doctor.profileId) {
    throw new ApiError(400, "O‘zingizga yo‘llanma berib bo‘lmaydi", "self_referral");
  }

  if (specialtyId && target.specialty_id !== specialtyId) {
    throw new ApiError(400, "Shifokor tanlangan bo‘limga tegishli emas", "doctor_not_in_department");
  }

  const unavailable = new ApiError(409, "Bu shifokorga hozir yo‘llanma berib bo‘lmaydi", "receiving_doctor_unavailable");
  if (!target.active || !target.profile_id) throw unavailable;
  const { data: role, error: roleError } = await supabase
    .from("staff_roles")
    .select("profile_id")
    .eq("clinic_id", doctor.clinicId)
    .eq("profile_id", target.profile_id)
    .eq("role", "doctor")
    .maybeSingle();
  if (roleError) throw new ApiError(500, "Shifokorni tekshirib bo‘lmadi");
  if (!role) throw unavailable;
}

/** A department of the caller's clinic that has a doctor (other than the caller) to take a referral. */
async function assertDepartment(doctor: LinkedDoctor, specialtyId: string): Promise<void> {
  const departments = await listReferralDepartments(doctor);
  if (!departments.some((d) => d.id === specialtyId)) throw new ApiError(404, "Bo‘lim topilmadi", "department_not_found");
}

/**
 * A referral from the calling doctor's own consultation. The patient and
 * clinic come from that consultation, never from the request. Idempotent per
 * `idempotencyKey`: a repeat — sequential or concurrent — returns the
 * referral already created (`replayed: true`) and writes nothing, so the
 * audit trail records the creation exactly once.
 */
export async function createReferral(doctor: LinkedDoctor, input: CreateReferralInput): Promise<CreatedReferral> {
  const previous = await findByCreationKey(doctor, input.idempotencyKey);
  if (previous) return replay(previous, input);

  const supabase = createAdminClient();
  const { data: consultation, error } = await supabase
    .from("appointments")
    .select("id, patient_id")
    .eq("id", input.appointmentId)
    .eq("clinic_id", doctor.clinicId)
    .eq("doctor_id", doctor.doctorId)
    .maybeSingle();
  if (error) throw new ApiError(500, "Qabulni tekshirib bo‘lmadi");
  if (!consultation) throw new ApiError(404, "Qabul topilmadi", "consultation_not_found");

  const referredToDoctorId = input.referredToDoctorId || null;
  const referredToSpecialtyId = input.referredToSpecialtyId || null;
  if (!referredToDoctorId && !referredToSpecialtyId) {
    throw new ApiError(400, "Bo‘lim yoki shifokorni tanlang", "validation");
  }
  if (referredToDoctorId) await assertReferralRecipient(doctor, referredToDoctorId, referredToSpecialtyId);
  else await assertDepartment(doctor, referredToSpecialtyId!);

  // An open referral that has quietly expired must not block a new one.
  await expireDueReferrals(doctor.clinicId);

  const { data, error: insertError } = await supabase
    .from("referrals")
    .insert({
      clinic_id: doctor.clinicId,
      patient_id: consultation.patient_id,
      referring_doctor_id: doctor.doctorId,
      referred_to_doctor_id: referredToDoctorId,
      referred_to_specialty_id: referredToSpecialtyId,
      originating_appointment_id: consultation.id,
      reason: input.reason,
      handoff_note: input.handoffNote || null,
      priority: input.priority,
      created_by: doctor.profileId,
      creation_key: input.idempotencyKey,
      ...(input.validForDays
        ? { expires_at: new Date(Date.now() + input.validForDays * 86_400_000).toISOString() }
        : {}),
    })
    .select("id")
    .single();
  if (insertError) {
    // A concurrent copy of this request may have won the insert. The loser can
    // trip any unique index the two rows share (the one-open-referral-per-pair
    // index is checked before the key's), so look the key up on any conflict.
    if (insertError.code === "23505") {
      const winner = await findByCreationKey(doctor, input.idempotencyKey);
      if (winner) return replay(winner, input);
    }
    throw referralError(insertError);
  }
  return { id: data.id, replayed: false };
}

type TransitionPatch = Database["public"]["Tables"]["referrals"]["Update"];

async function applyTransition(clinicId: string, referralId: string, from: ReferralStatus, patch: TransitionPatch) {
  // Compare-and-swap on the status just read: a concurrent change turns
  // into a clean 409 instead of acting on a state the user never saw.
  const { data, error } = await createAdminClient()
    .from("referrals")
    .update(patch)
    .eq("id", referralId)
    .eq("clinic_id", clinicId)
    .eq("status", from)
    .select("status")
    .maybeSingle();
  if (error) throw referralError(error);
  if (!data) throw new ApiError(409, "Yo‘llanma holati o‘zgargan, sahifani yangilang", "referral_changed");
  return { status: data.status };
}

function transitionRefused(role: ReferralRole, status: ReferralStatus, action: ReferralAction): ApiError {
  if (role === "receiver" && action === "complete" && status === "accepted") {
    return new ApiError(409, "Avval bemor bilan qabulingizni boshlang", "consultation_not_started");
  }
  if (status === "expired") return new ApiError(409, "Yo‘llanma muddati tugagan", "referral_expired");
  return new ApiError(409, "Yo‘llanma holati buni ruxsat bermaydi", "invalid_transition");
}

/**
 * accept/decline (pending) and complete (in progress) by the receiving
 * doctor, revoke (while open) by the referring doctor.
 */
export async function actOnReferral(
  doctor: LinkedDoctor,
  referralId: string,
  action: ReferralAction,
  reason?: string,
): Promise<{ status: ReferralStatus }> {
  const { data: row, error } = await createAdminClient()
    .from("referrals")
    .select("id, status, expires_at, referring_doctor_id, referred_to_doctor_id, referred_to_specialty_id")
    .eq("id", referralId)
    .eq("clinic_id", doctor.clinicId)
    .maybeSingle();
  if (error) throw new ApiError(500, "Yo‘llanmani yuklab bo‘lmadi");

  const role = row ? roleOf(doctor, row) : null;
  if (!row || !role) throw new ApiError(404, "Yo‘llanma topilmadi", "referral_not_found");
  if (role !== (action === "revoke" ? "referrer" : "receiver")) {
    throw new ApiError(403, "Bu amal uchun ruxsat yo‘q", "forbidden");
  }
  // The action must be one the referral's current state offers this doctor:
  // a receiver can't act on a referral they can no longer see (410), and a
  // repeated or out-of-order action is refused (409) — never a silent no-op.
  const status = effectiveStatus(row.status, row.expires_at);
  if (!visibleTo(role, status, row.expires_at)) throw lapsedReferralError(status);
  if (!allowedActions(role, status, unclaimed(row)).includes(action)) throw transitionRefused(role, status, action);

  const actor = doctor.profileId;
  const patch: TransitionPatch =
    action === "accept"
      ? // Accepting a department referral nobody has taken makes the caller its receiving doctor.
        { status: "accepted", accepted_by: actor, ...(unclaimed(row) ? { referred_to_doctor_id: doctor.doctorId } : {}) }
      : action === "decline"
        ? { status: "declined", declined_by: actor, declined_reason: reason || null }
        : action === "complete"
          ? { status: "completed", completed_by: actor }
          : { status: "revoked", revoked_by: actor, revoked_reason: reason ?? null };
  return applyTransition(doctor.clinicId, row.id, row.status, patch);
}

/** Referral-eligible colleagues: active, with a doctor account, not the caller — with their department. */
export async function listReferralRecipients(doctor: LinkedDoctor) {
  const supabase = createAdminClient();
  const [doctorsRes, rolesRes] = await Promise.all([
    supabase
      .from("doctors")
      .select("id, name, title, profile_id, specialty_id, specialties(name)")
      .eq("clinic_id", doctor.clinicId)
      .eq("active", true)
      .not("profile_id", "is", null)
      .order("name", { ascending: true }),
    supabase.from("staff_roles").select("profile_id").eq("clinic_id", doctor.clinicId).eq("role", "doctor"),
  ]);
  if (doctorsRes.error || rolesRes.error) throw new ApiError(500, "Shifokorlarni yuklab bo‘lmadi");

  const doctorAccounts = new Set((rolesRes.data ?? []).map((r) => r.profile_id));
  return (doctorsRes.data ?? [])
    .filter((d) => d.id !== doctor.doctorId && d.profile_id !== doctor.profileId && doctorAccounts.has(d.profile_id!))
    .map((d) => ({
      id: d.id,
      name: d.name,
      title: d.title,
      specialtyId: d.specialty_id,
      specialty: d.specialties?.name ?? null,
    }));
}

/** Departments (specialties) with at least one doctor the caller could refer to. */
export async function listReferralDepartments(doctor: LinkedDoctor): Promise<DepartmentRef[]> {
  const byId = new Map<string, DepartmentRef>();
  for (const d of await listReferralRecipients(doctor)) {
    if (d.specialtyId && d.specialty) byId.set(d.specialtyId, { id: d.specialtyId, name: d.specialty });
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Clinic staff side (metadata only — never the clinical text)
// ---------------------------------------------------------------------------

export type PatientReferralSummary = {
  id: string;
  status: ReferralStatus;
  priority: ReferralPriority;
  createdAt: string;
  expiresAt: string;
  referringDoctor: string | null;
  referredToDoctor: { id: string; name: string } | null;
  department: string | null;
  followUp: { id: string; startAt: string; status: string } | null;
  canBookFollowUp: boolean;
};

type PatientReferralRow = {
  id: string;
  status: ReferralStatus;
  priority: ReferralPriority;
  created_at: string;
  expires_at: string;
  follow_up_appointment_id: string | null;
  referring: { name: string } | null;
  referred_to: { id: string; name: string } | null;
  department: { name: string } | null;
  follow_up: { start_at: string; status: string } | null;
};

/** A patient's referrals for front-desk scheduling: who, when, status, booking. */
export async function listPatientReferrals(clinicId: string, patientId: string): Promise<PatientReferralSummary[]> {
  const { data, error } = await createAdminClient()
    .from("referrals")
    .select(
      `id, status, priority, created_at, expires_at, follow_up_appointment_id, ${REFERRING}(name), ${REFERRED_TO}(id, name), ${DEPARTMENT}(name), follow_up:appointments!referrals_follow_up_appointment_fkey(start_at, status)`,
    )
    .eq("clinic_id", clinicId)
    .eq("patient_id", patientId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw error;

  const now = Date.now();
  return ((data ?? []) as unknown as PatientReferralRow[]).map((row) => {
    const status = effectiveStatus(row.status, row.expires_at, now);
    const followUp =
      row.follow_up_appointment_id && row.follow_up
        ? { id: row.follow_up_appointment_id, startAt: row.follow_up.start_at, status: row.follow_up.status }
        : null;
    return {
      id: row.id,
      status,
      priority: row.priority,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      referringDoctor: row.referring?.name ?? null,
      referredToDoctor: row.referred_to,
      department: row.department?.name ?? null,
      followUp,
      canBookFollowUp:
        status === "accepted" && (!followUp || INACTIVE_APPOINTMENT_STATUSES.includes(followUp.status)),
    };
  });
}

/**
 * Before reception books a referral's follow-up: the referral must be
 * accepted and unexpired, the appointment must be with the receiving doctor
 * for the referred patient, and no active follow-up may exist yet.
 */
export async function assertFollowUpBookable(
  clinicId: string,
  referralId: string,
  doctorId: string,
  patientId?: string,
): Promise<{ patientId: string; currentFollowUpId: string | null }> {
  const { data, error } = await createAdminClient()
    .from("referrals")
    .select(
      "id, status, expires_at, patient_id, referred_to_doctor_id, follow_up_appointment_id, follow_up:appointments!referrals_follow_up_appointment_fkey(status)",
    )
    .eq("id", referralId)
    .eq("clinic_id", clinicId)
    .maybeSingle();
  if (error) throw new ApiError(500, "Yo‘llanmani tekshirib bo‘lmadi");
  const row = data as unknown as
    | {
        status: ReferralStatus;
        expires_at: string;
        patient_id: string;
        referred_to_doctor_id: string | null;
        follow_up_appointment_id: string | null;
        follow_up: { status: string } | null;
      }
    | null;
  if (!row) throw new ApiError(404, "Yo‘llanma topilmadi", "referral_not_found");
  if (effectiveStatus(row.status, row.expires_at) !== "accepted") {
    throw new ApiError(409, "Yo‘llanma hali qabul qilinmagan yoki yopilgan", "referral_not_accepted");
  }
  if (doctorId !== row.referred_to_doctor_id) {
    throw new ApiError(400, "Qabul yo‘llanma berilgan shifokorga yozilishi kerak", "follow_up_wrong_doctor");
  }
  if (patientId && patientId !== row.patient_id) {
    throw new ApiError(400, "Qabul yo‘llanmadagi bemorga yozilishi kerak", "follow_up_wrong_patient");
  }
  if (row.follow_up_appointment_id && row.follow_up && !INACTIVE_APPOINTMENT_STATUSES.includes(row.follow_up.status)) {
    throw new ApiError(409, "Bu yo‘llanma uchun qabul allaqachon yozilgan", "follow_up_exists");
  }
  return { patientId: row.patient_id, currentFollowUpId: row.follow_up_appointment_id };
}

/** Links a booked appointment; false when another booking won the race. */
export async function linkFollowUp(
  clinicId: string,
  referralId: string,
  appointmentId: string,
  currentFollowUpId: string | null,
): Promise<boolean> {
  let query = createAdminClient()
    .from("referrals")
    .update({ follow_up_appointment_id: appointmentId })
    .eq("id", referralId)
    .eq("clinic_id", clinicId);
  query = currentFollowUpId
    ? query.eq("follow_up_appointment_id", currentFollowUpId)
    : query.is("follow_up_appointment_id", null);
  const { data, error } = await query.select("id").maybeSingle();
  if (error) throw referralError(error);
  return !!data;
}

/** Clinic management (owner/admin/manager) withdraws a referral. */
export async function revokeReferralAsManagement(staff: StaffInClinic, referralId: string, reason: string) {
  const { data: row, error } = await createAdminClient()
    .from("referrals")
    .select("id, status, expires_at")
    .eq("id", referralId)
    .eq("clinic_id", staff.clinicId)
    .maybeSingle();
  if (error) throw new ApiError(500, "Yo‘llanmani yuklab bo‘lmadi");
  if (!row) throw new ApiError(404, "Yo‘llanma topilmadi", "referral_not_found");
  // Only an open referral can be withdrawn; a closed one is final.
  const status = effectiveStatus(row.status, row.expires_at);
  if (!OPEN_STATUSES.includes(status)) throw transitionRefused("referrer", status, "revoke");
  return applyTransition(staff.clinicId, row.id, row.status, {
    status: "revoked",
    revoked_by: staff.profileId,
    revoked_reason: reason,
  });
}
