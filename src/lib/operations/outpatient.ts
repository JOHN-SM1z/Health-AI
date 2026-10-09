import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { logger } from "@/lib/logger";
import type { StaffContext } from "@/lib/auth/staff";
import type { LinkedDoctor } from "@/lib/auth/guards";
import type { Json } from "@/lib/supabase/database.types";
import { ORDER_ERRORS } from "@/lib/labs/ordering";
import { classifyQuery, isIdentityDocument } from "@/lib/operations/identity-query";
import { deliverClinicNotificationsSoon } from "@/lib/notifications/deliver-soon";
import { recordAudit } from "@/lib/audit";

/**
 * Outpatient pilot — the server side of 20261007000002. Every write is one
 * service-role RPC that re-checks the actor's role in the clinic inside the
 * database; the clinic and the actor always come from the session, never
 * from the request. Money and queue numbers are computed by the database.
 */

type Staff = StaffContext & { clinicId: string };

export type VisitStatus = "booked" | "awaiting_payment" | "waiting" | "called" | "in_progress" | "completed" | "cancelled";
export type Balance = { charged: number; collected: number; refunded: number; outstanding: number; cashNet: number; terminalNet: number; onlineNet: number };

// Database refusals (RAISE … HINT) → what the desk sees.
const REFUSALS: Record<string, [number, string]> = {
  forbidden: [403, "Bu amal uchun ruxsat yo‘q"],
  invalid_request: [400, "Noto‘g‘ri so‘rov"],
  idempotency_conflict: [409, "So‘rov takrorlandi, lekin ma’lumot boshqacha — sahifani yangilang"],
  doctor_not_found: [404, "Shifokor topilmadi yoki faol emas"],
  invalid_services: [400, "1 dan 10 tagacha turli xizmat tanlang"],
  service_not_found: [404, "Xizmat topilmadi yoki faol emas"],
  service_not_offered: [409, "Bu shifokor bu xizmatni ko‘rsatmaydi"],
  invalid_patient: [400, "Bemor ma’lumotlari to‘liq emas: F.I.Sh. va tug‘ilgan sana majburiy"],
  patient_not_found: [404, "Bemor topilmadi"],
  patient_merged: [409, "Bu karta asosiy kartaga birlashtirilgan — asosiy kartani tanlang"],
  patient_exists: [409, "Bu bemor allaqachon ro‘yxatda bor — mavjud kartani tanlang"],
  not_today: [409, "Bu onlayn yozuv boshqa kun uchun"],
  identity_conflict: [409, "Kiritilgan ma’lumotlar mavjud karta bilan mos kelmaydi — hujjat va tug‘ilgan sanani tekshiring yoki administratorga murojaat qiling"],
  already_registered: [409, "Bemor bu shifokorga allaqachon ro‘yxatdan o‘tgan"],
  already_registered_lab: [409, "Bemor laboratoriya navbatida allaqachon bor"],
  visit_not_found: [404, "Tashrif topilmadi"],
  visit_cancelled: [409, "Tashrif bekor qilingan"],
  stale: [409, "Ma’lumot o‘zgargan — sahifani yangilang"],
  nothing_due: [409, "To‘lanadigan summa yo‘q"],
  amount_mismatch: [409, "To‘lov summasi qarzga teng bo‘lishi kerak (qisman to‘lov yoqilmagan)"],
  refund_not_permitted: [403, "Qaytarish uchun menejer ruxsati kerak"],
  reason_required: [400, "Sababini yozing"],
  refund_exceeds_paid: [409, "Qaytarish shu usulda to‘langan summadan oshib ketadi"],
  not_a_cashier: [409, "Ruxsat faqat kassirga beriladi"],
  grant_not_found: [404, "Faol ruxsat topilmadi"],
  charge_not_found: [404, "Xizmat qatori topilmadi"],
  refund_first: [409, "Avval to‘lovni qaytaring"],
  invalid_transition: [409, "Bu amalni hozir bajarib bo‘lmaydi"],
  cancel_lab_test: [409, "Tahlil laboratoriyada bekor qilinadi — keyin u hisobdan avtomatik chiqadi"],
  visit_finished: [409, "Tashrif yakunlangan"],
  lab_sample_taken: [409, "Namuna allaqachon olingan — tashrifni bekor qilib bo‘lmaydi, laboratoriya hal qiladi"],
  // start_walk_in_consultation's booking-engine codes
  outside_working_hours: [409, "Hozir ish vaqtingiz emas"],
  time_blocked: [409, "Hozir sizda tanaffus yoki band vaqt belgilangan"],
  slot_taken: [409, "Hozir sizda boshqa qabul bor"],
  booking_failed: [409, "Qabulni boshlab bo‘lmadi, qayta urinib ko‘ring"],
};

function refusal(error: { code?: string; hint?: string | null; message?: string; details?: string | null }, op: string): ApiError {
  const hint = error.hint ?? "";
  const known = REFUSALS[hint];
  if (known) {
    // The matched card's id stays on the server: `existingCardOnly` decides whether reception may see it.
    const details = hint === "patient_exists" && error.details ? { matchedPatientId: error.details } : undefined;
    return new ApiError(known[0], known[1], hint, details);
  }
  if (error.code === "42501") return new ApiError(403, REFUSALS.forbidden[1], "forbidden");
  if (error.code === "40001") return new ApiError(409, REFUSALS.stale[1], "stale");
  logger.error("outpatient rpc failed", { op, code: error.code });
  return new ApiError(500, "Amalni bajarib bo‘lmadi");
}

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  // The RPC names are fixed in this module; the generated types cover them.
  const { data, error } = await (createAdminClient().rpc as unknown as (
    fn: string,
    a: Record<string, unknown>,
  ) => Promise<{ data: T; error: { code?: string; hint?: string; message?: string; details?: string } | null }>)(name, args);
  if (error) throw refusal(error, name);
  return data;
}

/**
 * A new-patient registration matched an existing card (same JSHSHIR, passport/ID, or name + date of birth). Reception
 * is offered that card only when the typed date of birth matches it too; otherwise the answer says only that the
 * details conflict — it never tells the desk whose document it is (owner decision 2026-10-08).
 */
async function existingCardOnly(e: unknown, clinicId: string, newPatient: NewPatientInput | null | undefined): Promise<never> {
  if (!(e instanceof ApiError) || e.code !== "patient_exists") throw e;
  const matched = e.details?.matchedPatientId;
  if (typeof matched === "string" && newPatient?.dateOfBirth) {
    const { data } = await createAdminClient()
      .from("patients")
      .select("id, date_of_birth")
      .eq("clinic_id", clinicId)
      .eq("id", matched)
      .maybeSingle();
    if (data && data.date_of_birth === newPatient.dateOfBirth) throw new ApiError(409, e.message, "patient_exists", { patientId: data.id });
  }
  throw new ApiError(REFUSALS.identity_conflict[0], REFUSALS.identity_conflict[1], "identity_conflict");
}

// ---------------------------------------------------------------------------
// Patient identification (reception)
// ---------------------------------------------------------------------------

/**
 * What the desk sees of a card: name, phone and card number (owner decision 2026-10-08). The passport/ID number, JSHSHIR,
 * date of birth and sex stay on the server: they are compared here, never returned.
 */
export type PatientMatch = {
  id: string;
  patientNumber: number;
  fullName: string | null;
  phone: string | null;
  /** True when the date of birth the desk typed was checked on the server and matches; null when none was typed. */
  dobMatches: boolean | null;
};

export type PatientSearch = {
  patients: PatientMatch[];
  /** Passport/ID or JSHSHIR and date of birth both matched exactly one card: select it at once. */
  exact: boolean;
  /** The document matched a card but the date of birth did not; that card is not offered. */
  dobMismatch: boolean;
};

/**
 * Finds a returning patient: by passport/ID number or JSHSHIR with the date
 * of birth (one step — the owner's walk-in flow), or by patient number, phone
 * or name (optionally narrowed by date of birth). A document whose card has a
 * different date of birth is reported as a mismatch and the card is not
 * returned: a wrong-patient safety check that also reveals nothing about it.
 * A document or JSHSHIR is never looked up without a date of birth (enforced
 * here, not only on the screen). Identity values are compared on the server
 * and never returned. Merged records are never offered; at most 10 results.
 */
export async function searchPatients(staff: Staff, q: string, dateOfBirth?: string): Promise<PatientSearch> {
  const none: PatientSearch = { patients: [], exact: false, dobMismatch: false };
  if (q.trim().length < 2) return none;
  const term = classifyQuery(q);
  if (isIdentityDocument(term) && !dateOfBirth) {
    throw new ApiError(400, "Pasport yoki JSHSHIR bilan birga tug‘ilgan sanani ham kiriting", "dob_required");
  }
  const supabase = createAdminClient();
  let query = supabase
    .from("patients")
    .select("id, patient_number, full_name, date_of_birth, phone")
    .eq("clinic_id", staff.clinicId)
    .is("merged_into_patient_id", null)
    .limit(10);

  if (term.kind === "patient_number") query = query.eq("patient_number", Number(term.value));
  else if (term.kind === "pinfl") query = query.eq("pinfl", term.value);
  else if (term.kind === "document") query = query.eq("document_number", term.value);
  else if (term.kind === "phone") query = query.ilike("phone", `%${term.value}%`);
  else query = query.ilike("full_name", `%${term.value.replace(/["\\%*_]/g, "")}%`);
  // A document is matched first and its date of birth compared below.
  const byDocument = isIdentityDocument(term) && !!dateOfBirth;
  if (dateOfBirth && !byDocument) query = query.eq("date_of_birth", dateOfBirth);

  const { data, error } = await query.order("patient_number", { ascending: false });
  if (error) throw new ApiError(500, "Qidirib bo‘lmadi");
  const rows = data ?? [];
  const kept = byDocument ? rows.filter((p) => p.date_of_birth === dateOfBirth) : rows;
  return {
    patients: kept.map((p) => ({
      id: p.id,
      patientNumber: Number(p.patient_number),
      fullName: p.full_name,
      phone: p.phone,
      // Every row kept was filtered on the typed date of birth.
      dobMatches: dateOfBirth ? true : null,
    })),
    exact: byDocument && kept.length === 1,
    dobMismatch: byDocument && rows.length > 0 && kept.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Registration and the live queue
// ---------------------------------------------------------------------------

export type NewPatientInput = {
  fullName: string;
  dateOfBirth: string;
  sex?: "female" | "male" | null;
  phone?: string | null;
  documentNumber?: string | null;
  pinfl?: string | null;
};

export async function registerArrival(
  staff: Staff,
  input: { key: string; patientId?: string | null; newPatient?: NewPatientInput | null; doctorId: string; serviceIds: string[]; smsConsent?: boolean },
): Promise<{ visitId: string; replayed: boolean }> {
  const np = input.newPatient
    ? {
        full_name: input.newPatient.fullName,
        date_of_birth: input.newPatient.dateOfBirth,
        sex: input.newPatient.sex ?? null,
        phone: input.newPatient.phone ?? null,
        document_number: input.newPatient.documentNumber ?? null,
        pinfl: input.newPatient.pinfl ?? null,
      }
    : null;
  const r = await rpc<{ visit_id: string; replayed: boolean }>("register_arrival", {
    p_clinic: staff.clinicId,
    p_actor: staff.profileId,
    p_key: input.key,
    p_patient: input.patientId ?? null,
    p_new_patient: np as Json,
    p_doctor: input.doctorId,
    p_service_ids: input.serviceIds,
  }).catch((e: unknown) => existingCardOnly(e, staff.clinicId, input.newPatient));
  // A free visit is queued at once: its Telegram ticket goes out now.
  deliverClinicNotificationsSoon(staff.clinicId);
  if (input.smsConsent) await smsConsentForVisit(staff, r.visit_id);
  return { visitId: r.visit_id, replayed: r.replayed };
}

export type VisitCharge = { id: string; serviceName: string; amount: number; status: "active" | "voided"; voidReason: string | null; isLabTest: boolean };
export type VisitSummary = {
  id: string;
  /** "doctor": a consultation queue; "lab": the laboratory's walk-in queue (no doctor). */
  kind: "doctor" | "lab";
  labOrderId: string | null;
  status: VisitStatus;
  queueDate: string | null;
  queueNumber: number | null;
  /** When the patient registered at the desk; for an online booking, when they were marked arrived (or paid, before). */
  arrivedAt: string;
  queuedAt: string | null;
  calledAt: string | null;
  /** "online": paid in the Mini App (20261008000012); "desk": registered at reception. */
  source: "desk" | "online";
  /** The booked time of an online visit; null for a walk-in. */
  slotAt: string | null;
  patient: { id: string; patientNumber: number; fullName: string | null };
  /** null for a laboratory visit. */
  doctor: { id: string; name: string } | null;
  balance: Balance;
  charges: VisitCharge[];
};

/** What the queue is called on screens and tickets. */
export const queueLabel = (v: { kind: string; doctor: { name: string } | null }) => (v.kind === "lab" ? "Laboratoriya" : (v.doctor?.name ?? "Shifokor"));

const VISIT_SELECT =
  "id, kind, lab_order_id, status, source, queue_date, queue_number, arrived_at, queued_at, called_at, patient_id, doctor_id, appointments(start_at), patients!inner(id, patient_number, full_name), doctors(id, name), visit_charges(id, service_name, amount, status, void_reason, created_at, lab_order_item_id)";

type VisitRow = {
  id: string;
  kind: "doctor" | "lab";
  lab_order_id: string | null;
  status: VisitStatus;
  queue_date: string | null;
  queue_number: number | null;
  source: "desk" | "online";
  arrived_at: string | null;
  queued_at: string | null;
  called_at: string | null;
  appointments: { start_at: string } | null;
  patients: { id: string; patient_number: number; full_name: string | null } | null;
  doctors: { id: string; name: string } | null;
  visit_charges: Array<{ id: string; service_name: string; amount: number; status: "active" | "voided"; void_reason: string | null; created_at: string; lab_order_item_id: string | null }> | null;
};

async function balances(visitIds: string[]): Promise<Map<string, Balance>> {
  const out = new Map<string, Balance>();
  if (visitIds.length === 0) return out;
  const { data, error } = await createAdminClient()
    .from("visit_transactions")
    .select("visit_id, kind, method, amount")
    .in("visit_id", visitIds);
  if (error) throw new ApiError(500, "To‘lovlarni yuklab bo‘lmadi");
  for (const id of visitIds) out.set(id, { charged: 0, collected: 0, refunded: 0, outstanding: 0, cashNet: 0, terminalNet: 0, onlineNet: 0 });
  for (const t of data ?? []) {
    const b = out.get(t.visit_id)!;
    const amount = Number(t.amount);
    const signed = t.kind === "collection" ? amount : -amount;
    if (t.kind === "collection") b.collected += amount;
    else b.refunded += amount;
    // Online money never counts as the drawer's cash or the terminal's.
    if (t.method === "cash") b.cashNet += signed;
    else if (t.method === "terminal") b.terminalNet += signed;
    else b.onlineNet += signed;
  }
  return out;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

async function toSummaries(rows: VisitRow[]): Promise<VisitSummary[]> {
  const money = await balances(rows.map((r) => r.id));
  return rows.map((r) => {
    const charges = [...(r.visit_charges ?? [])]
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((c) => ({ id: c.id, serviceName: c.service_name, amount: Number(c.amount), status: c.status, voidReason: c.void_reason, isLabTest: c.lab_order_item_id !== null }));
    const b = money.get(r.id)!;
    b.charged = round2(charges.filter((c) => c.status === "active").reduce((s, c) => s + c.amount, 0));
    b.collected = round2(b.collected);
    b.refunded = round2(b.refunded);
    b.cashNet = round2(b.cashNet);
    b.terminalNet = round2(b.terminalNet);
    b.onlineNet = round2(b.onlineNet);
    b.outstanding = round2(b.charged - b.collected + b.refunded);
    return {
      id: r.id,
      kind: r.kind,
      labOrderId: r.lab_order_id,
      status: r.status,
      queueDate: r.queue_date,
      queueNumber: r.queue_number,
      arrivedAt: r.arrived_at ?? r.queued_at ?? "",
      queuedAt: r.queued_at,
      calledAt: r.called_at,
      source: r.source ?? "desk",
      slotAt: r.appointments?.start_at ?? null,
      patient: { id: r.patients!.id, patientNumber: Number(r.patients!.patient_number), fullName: r.patients!.full_name },
      doctor: r.doctors ? { id: r.doctors.id, name: r.doctors.name } : null,
      balance: b,
      charges,
    };
  });
}

/** Two visits wait in the same queue: the same doctor's, or both the laboratory's. */
const sameQueue = (a: VisitSummary, b: VisitSummary) => (a.kind === "lab" ? b.kind === "lab" : b.doctor?.id === a.doctor?.id && b.kind === "doctor");

/** A booked patient who arrives later than this after their time goes behind those already waiting. */
export const LATE_ARRIVAL_GRACE_MS = 10 * 60_000;

/**
 * When a numbered visit takes its turn (owner decision 2026-10-08): a patient booked online at their booked time —
 * unless they arrived more than the grace period late, then at their arrival; a walk-in when they paid (were queued).
 */
export function turnTime(v: Pick<VisitSummary, "slotAt" | "arrivedAt" | "queuedAt" | "source">): string {
  if (v.source === "online" && v.slotAt) {
    const late = v.arrivedAt && new Date(v.arrivedAt).getTime() > new Date(v.slotAt).getTime() + LATE_ARRIVAL_GRACE_MS;
    return late ? new Date(v.arrivedAt).toISOString() : new Date(v.slotAt).toISOString();
  }
  return new Date(v.queuedAt ?? v.arrivedAt).toISOString();
}

/**
 * Queue order: earlier clinic day first; within a day, booked patients by their booked time and walk-ins fitted
 * between them by when they paid (turnTime), the number breaking ties; unnumbered (awaiting payment) by arrival.
 */
export function queueOrder(a: VisitSummary, b: VisitSummary): number {
  if (a.queueNumber !== null && b.queueNumber !== null) {
    return (
      (a.queueDate ?? "").localeCompare(b.queueDate ?? "") || turnTime(a).localeCompare(turnTime(b)) || a.queueNumber - b.queueNumber
    );
  }
  if (a.queueNumber === null && b.queueNumber === null) return a.arrivedAt.localeCompare(b.arrivedAt);
  return a.queueNumber === null ? 1 : -1;
}

/**
 * Every unfinished visit of the clinic (awaiting payment, waiting, called,
 * in progress) — regardless of the day it started, so nobody disappears at
 * midnight. Optionally one doctor's. At most 300, oldest first.
 */
export async function listOpenVisits(clinicId: string, opts: { doctorId?: string; statuses?: VisitStatus[] } = {}): Promise<VisitSummary[]> {
  let query = createAdminClient()
    .from("visits")
    .select(VISIT_SELECT)
    .eq("clinic_id", clinicId)
    .in("status", opts.statuses ?? ["awaiting_payment", "waiting", "called", "in_progress"])
    .order("queued_at", { ascending: true, nullsFirst: false })
    .limit(300);
  if (opts.doctorId) query = query.eq("doctor_id", opts.doctorId);
  const { data, error } = await query;
  if (error) throw new ApiError(500, "Navbatni yuklab bo‘lmadi");
  return (await toSummaries((data ?? []) as unknown as VisitRow[])).sort(queueOrder);
}

export async function getVisit(clinicId: string, visitId: string): Promise<VisitSummary> {
  const { data, error } = await createAdminClient().from("visits").select(VISIT_SELECT).eq("clinic_id", clinicId).eq("id", visitId).maybeSingle();
  if (error) throw new ApiError(500, "Tashrifni yuklab bo‘lmadi");
  if (!data) throw new ApiError(404, REFUSALS.visit_not_found[1], "visit_not_found");
  return (await toSummaries([data as unknown as VisitRow]))[0];
}

/** Visits of the clinic's current day that ended (completed/cancelled) — for the kassa's refunds and totals. */
export async function listRecentClosedVisits(clinicId: string, sinceIso: string): Promise<VisitSummary[]> {
  const { data, error } = await createAdminClient()
    .from("visits")
    .select(VISIT_SELECT)
    .eq("clinic_id", clinicId)
    .in("status", ["completed", "cancelled"])
    .gte("arrived_at", sinceIso)
    .order("arrived_at", { ascending: false })
    .limit(200);
  if (error) throw new ApiError(500, "Tashriflarni yuklab bo‘lmadi");
  return toSummaries((data ?? []) as unknown as VisitRow[]);
}

/**
 * The patient agreed (or no longer agrees) at the desk to queue SMS (20261008000013) — used only when they have no
 * Telegram and the clinic has SMS on. Audited with ids only.
 */
export async function setSmsConsent(staff: Staff, patientId: string, consent: boolean): Promise<{ smsConsent: boolean }> {
  const db = createAdminClient();
  const { data, error } = await db
    .from("patients")
    .update({ sms_consent_at: consent ? new Date().toISOString() : null })
    .eq("clinic_id", staff.clinicId)
    .eq("id", patientId)
    .select("id")
    .maybeSingle();
  if (error) throw new ApiError(500, "Saqlab bo‘lmadi");
  if (!data) throw new ApiError(404, REFUSALS.patient_not_found[1], "patient_not_found");
  await recordAudit({
    clinicId: staff.clinicId,
    action: consent ? "patient_sms_consent_given" : "patient_sms_consent_withdrawn",
    entityType: "patients",
    entityId: patientId,
    patientId,
    actor: { actorType: "staff", actorId: staff.profileId },
  });
  return { smsConsent: consent };
}

async function smsConsentForVisit(staff: Staff, visitId: string) {
  const { data } = await createAdminClient().from("visits").select("patient_id").eq("clinic_id", staff.clinicId).eq("id", visitId).maybeSingle();
  if (data) await setSmsConsent(staff, data.patient_id, true);
}

/** Patients who paid online for a clinic day and have not arrived yet (reception's "Keldi" list), by booked time. */
export async function listBookedVisits(clinicId: string, day: string): Promise<VisitSummary[]> {
  const { data, error } = await createAdminClient()
    .from("visits")
    .select(VISIT_SELECT)
    .eq("clinic_id", clinicId)
    .eq("status", "booked")
    .eq("queue_date", day)
    .limit(300);
  if (error) throw new ApiError(500, "Onlayn yozuvlarni yuklab bo‘lmadi");
  return (await toSummaries((data ?? []) as unknown as VisitRow[])).sort((a, b) => (a.slotAt ?? "").localeCompare(b.slotAt ?? ""));
}

/** Reception: the patient who paid online is here — they join their doctor's queue at their booked time. */
export async function markBookedArrived(staff: Staff, visitId: string): Promise<{ visitId: string; queueNumber: number }> {
  const r = await rpc<{ visit_id: string; queue_number: number }>("mark_booked_arrived", { p_clinic: staff.clinicId, p_actor: staff.profileId, p_visit: visitId });
  deliverClinicNotificationsSoon(staff.clinicId);
  return { visitId: r.visit_id, queueNumber: r.queue_number };
}

export async function transitionVisit(
  staff: Staff,
  visitId: string,
  input: { expected: VisitStatus; status: VisitStatus; reason?: string | null },
): Promise<{ status: VisitStatus }> {
  const r = await rpc<{ status: VisitStatus }>("transition_visit", {
    p_clinic: staff.clinicId,
    p_actor: staff.profileId,
    p_visit: visitId,
    p_expected: input.expected,
    p_status: input.status,
    p_reason: input.reason ?? null,
  });
  // "You are called" reaches the patient's Telegram now, not at the next scheduled run.
  if (r.status === "called") deliverClinicNotificationsSoon(staff.clinicId);
  return r;
}

export async function addVisitCharge(staff: Staff, visitId: string, input: { key: string; serviceId: string }) {
  return rpc<{ charge_id: string; replayed: boolean }>("add_visit_charge", {
    p_clinic: staff.clinicId,
    p_actor: staff.profileId,
    p_visit: visitId,
    p_service: input.serviceId,
    p_key: input.key,
  });
}

export async function voidVisitCharge(staff: Staff, chargeId: string, reason: string) {
  return rpc<{ charge_id: string }>("void_visit_charge", {
    p_clinic: staff.clinicId,
    p_actor: staff.profileId,
    p_charge: chargeId,
    p_reason: reason,
  });
}

/**
 * A laboratory walk-in: the patient (existing, or new — same duplicate rules),
 * a lab order of the chosen tests/panels and a lab visit, in one database
 * transaction. The tests become lines of the visit's bill (no separate lab
 * bill); the lab queue number is issued on full payment.
 */
export async function registerLabArrival(
  staff: Staff,
  input: { key: string; patientId?: string | null; newPatient?: NewPatientInput | null; testIds: string[]; panelIds: string[]; smsConsent?: boolean },
): Promise<{ visitId: string; labOrderId: string | null; replayed: boolean }> {
  const np = input.newPatient
    ? {
        full_name: input.newPatient.fullName,
        date_of_birth: input.newPatient.dateOfBirth,
        sex: input.newPatient.sex ?? null,
        phone: input.newPatient.phone ?? null,
        document_number: input.newPatient.documentNumber ?? null,
        pinfl: input.newPatient.pinfl ?? null,
      }
    : null;
  const { data, error } = await createAdminClient().rpc("register_lab_arrival", {
    p_clinic: staff.clinicId,
    p_actor: staff.profileId,
    p_key: input.key,
    p_patient: input.patientId ?? null,
    p_new_patient: np as Json,
    p_test_ids: input.testIds,
    p_panel_ids: input.panelIds,
  });
  if (error) {
    // create_lab_order's own refusals (no date of birth, inactive test, …).
    const known = ORDER_ERRORS.find(([pattern]) => pattern.test(error.message ?? ""));
    if (known && !error.hint) throw new ApiError(known[1], known[2], known[3]);
    return existingCardOnly(refusal(error, "register_lab_arrival"), staff.clinicId, input.newPatient);
  }
  const r = data as { visit_id: string; lab_order_id?: string; replayed: boolean };
  deliverClinicNotificationsSoon(staff.clinicId);
  if (input.smsConsent) await smsConsentForVisit(staff, r.visit_id);
  return { visitId: r.visit_id, labOrderId: r.lab_order_id ?? null, replayed: r.replayed };
}

// ---------------------------------------------------------------------------
// Kassa
// ---------------------------------------------------------------------------

export async function recordVisitPayment(
  staff: Staff,
  visitId: string,
  input: { key: string; lines: Array<{ method: "cash" | "terminal"; amount: number }>; expectedOutstanding: number },
): Promise<{ queueNumber: number | null; replayed: boolean }> {
  const r = await rpc<{ queue_number?: number | null; replayed: boolean }>("record_visit_payment", {
    p_clinic: staff.clinicId,
    p_actor: staff.profileId,
    p_visit: visitId,
    p_key: input.key,
    p_lines: input.lines as unknown as Json,
    p_expected_outstanding: input.expectedOutstanding,
  });
  // Paid: the queue ticket goes to the patient's Telegram now.
  deliverClinicNotificationsSoon(staff.clinicId);
  return { queueNumber: r.queue_number ?? null, replayed: r.replayed };
}

export async function refundVisitPayment(
  staff: Staff,
  visitId: string,
  input: { key: string; method: "cash" | "terminal"; amount: number; reason: string },
): Promise<{ replayed: boolean }> {
  return rpc<{ replayed: boolean }>("refund_visit_payment", {
    p_clinic: staff.clinicId,
    p_actor: staff.profileId,
    p_visit: visitId,
    p_key: input.key,
    p_method: input.method,
    p_amount: input.amount,
    p_reason: input.reason,
  });
}

export type KassaTotals = {
  from: string;
  to: string;
  scope: "mine" | "clinic";
  /** "online": paid in the Mini App — never in the drawer or the terminal. */
  byMethod: Record<"cash" | "terminal" | "online", { collected: number; refunded: number; net: number }>;
  byStaff: Array<{ profileId: string; name: string | null; collected: number; refunded: number }>;
};

/**
 * Money actually received and paid back in [from, to), by method — the
 * cashier's reconciliation against the drawer and the terminal's report.
 * Collected money only: not revenue, not profit. A cashier sees their own
 * figures; owner, manager and admin see the clinic's.
 */
export async function kassaTotals(staff: Staff, fromIso: string, toIso: string, clinicWide: boolean): Promise<KassaTotals> {
  let query = createAdminClient()
    .from("visit_transactions")
    .select("kind, method, amount, executed_by")
    .eq("clinic_id", staff.clinicId)
    .gte("created_at", fromIso)
    .lt("created_at", toIso)
    .limit(20000);
  if (!clinicWide) query = query.eq("executed_by", staff.profileId);
  const { data, error } = await query;
  if (error) throw new ApiError(500, "Hisobotni yuklab bo‘lmadi");
  const byMethod = {
    cash: { collected: 0, refunded: 0, net: 0 },
    terminal: { collected: 0, refunded: 0, net: 0 },
    online: { collected: 0, refunded: 0, net: 0 },
  };
  const staffTotals = new Map<string, { collected: number; refunded: number }>();
  for (const t of data ?? []) {
    const m = byMethod[t.method as "cash" | "terminal" | "online"];
    const amount = Number(t.amount);
    if (t.kind === "collection") m.collected += amount;
    else m.refunded += amount;
    // Online payments have no cashier; an online refund is attributed to the manager who confirmed it.
    if (!t.executed_by || (t.method === "online" && t.kind === "collection")) continue;
    const s = staffTotals.get(t.executed_by) ?? { collected: 0, refunded: 0 };
    if (t.kind === "collection") s.collected += amount;
    else s.refunded += amount;
    staffTotals.set(t.executed_by, s);
  }
  for (const m of Object.values(byMethod)) {
    m.collected = round2(m.collected);
    m.refunded = round2(m.refunded);
    m.net = round2(m.collected - m.refunded);
  }
  const ids = [...staffTotals.keys()];
  const { data: profiles } = ids.length
    ? await createAdminClient().from("profiles").select("id, full_name").in("id", ids)
    : { data: [] as Array<{ id: string; full_name: string | null }> };
  const names = new Map((profiles ?? []).map((p) => [p.id, p.full_name]));
  return {
    from: fromIso,
    to: toIso,
    scope: clinicWide ? "clinic" : "mine",
    byMethod,
    byStaff: ids.map((id) => ({ profileId: id, name: names.get(id) ?? null, ...staffTotals.get(id)!, collected: round2(staffTotals.get(id)!.collected), refunded: round2(staffTotals.get(id)!.refunded) })),
  };
}

// ---------------------------------------------------------------------------
// Refund grants
// ---------------------------------------------------------------------------

export type RefundGrant = { profileId: string; name: string | null; grantedBy: string; grantedAt: string };

export async function listCashiersWithGrants(clinicId: string): Promise<Array<{ profileId: string; name: string | null; grant: RefundGrant | null }>> {
  const supabase = createAdminClient();
  const [{ data: cashiers, error: e1 }, { data: grants, error: e2 }] = await Promise.all([
    supabase.from("staff_roles").select("profile_id, profiles!inner(full_name)").eq("clinic_id", clinicId).eq("role", "cashier"),
    supabase.from("refund_grants").select("profile_id, granted_by, granted_at").eq("clinic_id", clinicId).is("revoked_at", null),
  ]);
  if (e1 || e2) throw new ApiError(500, "Kassirlarni yuklab bo‘lmadi");
  const active = new Map((grants ?? []).map((g) => [g.profile_id, g]));
  return ((cashiers ?? []) as unknown as Array<{ profile_id: string; profiles: { full_name: string | null } | null }>).map((c) => {
    const g = active.get(c.profile_id);
    return {
      profileId: c.profile_id,
      name: c.profiles?.full_name ?? null,
      grant: g ? { profileId: c.profile_id, name: c.profiles?.full_name ?? null, grantedBy: g.granted_by, grantedAt: g.granted_at } : null,
    };
  });
}

export async function hasActiveRefundGrant(clinicId: string, profileId: string): Promise<boolean> {
  const { data } = await createAdminClient()
    .from("refund_grants")
    .select("id")
    .eq("clinic_id", clinicId)
    .eq("profile_id", profileId)
    .is("revoked_at", null)
    .maybeSingle();
  return !!data;
}

export async function grantRefundPermission(staff: Staff, cashierId: string) {
  return rpc<{ grant_id: string; replayed: boolean }>("grant_refund_permission", {
    p_clinic: staff.clinicId,
    p_actor: staff.profileId,
    p_cashier: cashierId,
  });
}

export async function revokeRefundPermission(staff: Staff, cashierId: string, reason: string) {
  return rpc<{ grant_id: string }>("revoke_refund_permission", {
    p_clinic: staff.clinicId,
    p_actor: staff.profileId,
    p_cashier: cashierId,
    p_reason: reason,
  });
}

// ---------------------------------------------------------------------------
// Doctor's live queue
// ---------------------------------------------------------------------------

export async function startVisitConsultation(doctor: LinkedDoctor, visitId: string, expected: VisitStatus): Promise<{ appointmentId: string; patientId: string }> {
  const r = await rpc<{ appointment_id: string }>("start_visit_consultation", {
    p_clinic: doctor.clinicId,
    p_actor: doctor.profileId,
    p_visit: visitId,
    p_expected: expected,
  });
  const visit = await getVisit(doctor.clinicId, visitId);
  return { appointmentId: r.appointment_id, patientId: visit.patient.id };
}

// ---------------------------------------------------------------------------
// Public waiting-room screen and the patient's own position
// ---------------------------------------------------------------------------

export type PublicQueue = {
  clinicName: string;
  doctors: Array<{ name: string; called: number[]; waiting: number[] }>;
};

/** Numbers and doctor names only — no patient names or ids. */
export async function publicQueue(clinicId: string): Promise<PublicQueue | null> {
  const supabase = createAdminClient();
  const { data: clinic } = await supabase.from("clinics").select("name, is_active").eq("id", clinicId).maybeSingle();
  if (!clinic || !clinic.is_active) return null;
  const { data, error } = await supabase
    .from("visits")
    .select("kind, status, queue_date, queue_number, doctors(name)")
    .eq("clinic_id", clinicId)
    .in("status", ["waiting", "called"])
    .not("queue_number", "is", null)
    .order("queue_date")
    .order("queue_number")
    .limit(500);
  if (error) throw new ApiError(500, "Navbatni yuklab bo‘lmadi");
  const byDoctor = new Map<string, { called: number[]; waiting: number[] }>();
  for (const v of (data ?? []) as unknown as Array<{ kind: string; status: string; queue_number: number; doctors: { name: string } | null }>) {
    const name = queueLabel({ kind: v.kind, doctor: v.doctors });
    const d = byDoctor.get(name) ?? { called: [], waiting: [] };
    (v.status === "called" ? d.called : d.waiting).push(v.queue_number);
    byDoctor.set(name, d);
  }
  return { clinicName: clinic.name, doctors: [...byDoctor.entries()].map(([name, d]) => ({ name, ...d })) };
}

export type PatientQueuePosition = {
  visitId: string;
  kind: "doctor" | "lab";
  status: VisitStatus;
  queueNumber: number | null;
  doctorName: string;
  ahead: number | null;
  outstanding: number;
};

async function queuePositions(clinicId: string, pick: (v: VisitSummary) => boolean): Promise<PatientQueuePosition[]> {
  // The patient's own include a booking paid online (number issued, not yet arrived).
  const mine = (await listOpenVisits(clinicId, { statuses: ["booked", "awaiting_payment", "waiting", "called", "in_progress"] })).filter(pick);
  if (mine.length === 0) return [];
  const all = await listOpenVisits(clinicId, { statuses: ["waiting", "called"] });
  return mine.map((v) => ({
    visitId: v.id,
    kind: v.kind,
    status: v.status,
    queueNumber: v.queueNumber,
    doctorName: queueLabel(v),
    ahead:
      v.queueNumber === null || !["waiting", "called"].includes(v.status)
        ? null
        : all.filter((o) => sameQueue(v, o) && o.id !== v.id && queueOrder(o, v) < 0).length,
    outstanding: v.balance.outstanding,
  }));
}

/** The patient's own unfinished visits with their live position (Mini App). */
export async function patientQueuePositions(clinicId: string, patientIds: string[]): Promise<PatientQueuePosition[]> {
  if (patientIds.length === 0) return [];
  return queuePositions(clinicId, (v) => patientIds.includes(v.patient.id));
}

// ---------------------------------------------------------------------------
// Following a visit's queue in Telegram (20261008000003, owner 2026-10-08)
// ---------------------------------------------------------------------------

const followTokenHash = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

/** The start parameter's token: 32 base64url characters (192 random bits). */
export const FOLLOW_TOKEN = /^[A-Za-z0-9_-]{32}$/;

/**
 * A one-time link for the patient to follow THIS visit's queue in the
 * clinic's Telegram bot, shown as a QR code at the kassa or reception. Only
 * the token's hash is stored; a new link replaces an unused one. Following
 * gives the queue only — never the card, records or results.
 */
export async function createVisitFollowLink(staff: Staff, visitId: string): Promise<{ url: string; expiresAt: string }> {
  const { data: bot, error } = await createAdminClient()
    .from("clinic_telegram_integrations")
    .select("telegram_username, enabled, status")
    .eq("clinic_id", staff.clinicId)
    .maybeSingle();
  if (error) throw new ApiError(500, "Telegram botini tekshirib bo‘lmadi");
  if (!bot?.telegram_username || !bot.enabled || bot.status !== "active") {
    throw new ApiError(409, "Klinikaning Telegram boti ulanmagan — navbat raqamini bemorga ayting", "bot_not_configured");
  }
  const token = randomBytes(24).toString("base64url");
  const r = await rpc<{ token_id: string; expires_at: string }>("create_visit_follow_token", {
    p_clinic: staff.clinicId,
    p_actor: staff.profileId,
    p_visit: visitId,
    p_token_hash: followTokenHash(token),
  });
  return { url: `https://t.me/${bot.telegram_username}?start=v_${token}`, expiresAt: r.expires_at };
}

export type FollowClaim = { status: "subscribed" | "already" | "invalid"; visitId?: string };

/** The bot's side: the Telegram user who opened the link starts following the visit. */
export async function claimVisitFollow(clinicId: string, token: string, telegramUserId: number): Promise<FollowClaim> {
  if (!FOLLOW_TOKEN.test(token)) return { status: "invalid" };
  const r = await rpc<{ status: FollowClaim["status"]; visit_id?: string }>("claim_visit_follow_token", {
    p_clinic: clinicId,
    p_token_hash: followTokenHash(token),
    p_telegram_user_id: telegramUserId,
  });
  return { status: r.status, visitId: r.visit_id };
}

/**
 * Every unfinished visit this Telegram user may see the queue of in this
 * clinic: the ones they follow, and their own linked card's.
 */
export async function telegramQueuePositions(clinicId: string, telegramUserId: number): Promise<PatientQueuePosition[]> {
  const db = createAdminClient();
  const [followed, own] = await Promise.all([
    db.from("visit_followers").select("visit_id").eq("clinic_id", clinicId).eq("telegram_user_id", telegramUserId),
    db.from("patients").select("id").eq("clinic_id", clinicId).eq("telegram_user_id", telegramUserId),
  ]);
  if (followed.error || own.error) throw new ApiError(500, "Navbatni yuklab bo‘lmadi");
  const visitIds = new Set((followed.data ?? []).map((f) => f.visit_id));
  const patientIds = new Set((own.data ?? []).map((p) => p.id));
  if (visitIds.size === 0 && patientIds.size === 0) return [];
  return queuePositions(clinicId, (v) => visitIds.has(v.id) || patientIds.has(v.patient.id));
}
