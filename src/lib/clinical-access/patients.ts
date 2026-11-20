import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import type { LinkedDoctor } from "@/lib/auth/guards";

/**
 * The patients a doctor may open: their own (a live — not cancelled —
 * appointment with them, or a record they wrote) and those actively referred
 * to them (pending, accepted or in progress, unexpired) — the same
 * rule as public.doctor_patient_access(), so every patient listed here opens
 * in the workspace and no other patient of the clinic ever appears.
 */

export type DoctorPatientSummary = {
  id: string;
  fullName: string | null;
  phone: string | null;
  relationship: "own" | "referred";
  /** The latest visit with this doctor that has taken place (bookings and cancellations aside). */
  lastVisitAt: string | null;
  /** An active referral of the patient to this doctor, if any. */
  referral: { id: string; status: string; referringDoctorName: string | null } | null;
};

const MAX_VISITS_SCANNED = 5_000;
const MAX_RESULTS = 200;
const ID_CHUNK = 150;

const digits = (s: string) => s.replace(/\D/g, "");
/** Visits that have taken place (a walk-in may start up to a minute ahead). */
const VISITED = ["checked_in", "in_progress", "completed"];

/** Case-insensitive name match, or a phone match on digits. The query never reaches the database. */
function matches(p: { full_name: string | null; phone: string | null }, q: string): boolean {
  if (!q) return true;
  const needle = q.toLocaleLowerCase("uz");
  if ((p.full_name ?? "").toLocaleLowerCase("uz").includes(needle)) return true;
  const qDigits = digits(q);
  return qDigits.length >= 3 && digits(p.phone ?? "").includes(qDigits);
}

export async function listDoctorPatients(doctor: LinkedDoctor, query: string): Promise<DoctorPatientSummary[]> {
  const supabase = createAdminClient();
  const [visitsRes, authoredRes, referralsRes] = await Promise.all([
    supabase
      .from("appointments")
      .select("patient_id, start_at, status")
      .eq("clinic_id", doctor.clinicId)
      .eq("doctor_id", doctor.doctorId)
      .neq("status", "cancelled")
      .order("start_at", { ascending: false })
      .limit(MAX_VISITS_SCANNED),
    supabase
      .from("clinical_records")
      .select("patient_id")
      .eq("clinic_id", doctor.clinicId)
      .eq("author_doctor_id", doctor.doctorId)
      .limit(MAX_VISITS_SCANNED),
    supabase
      .from("referrals")
      .select("id, patient_id, status, created_at, referring:doctors!referrals_referring_doctor_same_clinic_fkey(name)")
      .eq("clinic_id", doctor.clinicId)
      .eq("referred_to_doctor_id", doctor.doctorId)
      .in("status", ["pending", "accepted", "in_progress"])
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false }),
  ]);
  if (visitsRes.error || authoredRes.error || referralsRes.error) throw new ApiError(500, "Bemorlarni yuklab bo‘lmadi");

  // A live appointment or an authored record makes the patient the doctor's own (as in the decision).
  const own = new Set<string>((authoredRes.data ?? []).map((r) => r.patient_id));
  const lastVisit = new Map<string, string>();
  for (const v of visitsRes.data ?? []) {
    own.add(v.patient_id);
    if (!lastVisit.has(v.patient_id) && VISITED.includes(v.status)) lastVisit.set(v.patient_id, v.start_at);
  }
  const referralOf = new Map<string, { id: string; status: string; created_at: string; referringDoctorName: string | null }>();
  for (const r of (referralsRes.data ?? []) as unknown as Array<{
    id: string;
    patient_id: string;
    status: string;
    created_at: string;
    referring: { name: string } | null;
  }>) {
    if (!referralOf.has(r.patient_id)) {
      referralOf.set(r.patient_id, { id: r.id, status: r.status, created_at: r.created_at, referringDoctorName: r.referring?.name ?? null });
    }
  }

  type Row = { id: string; full_name: string | null; phone: string | null; merged_into_patient_id: string | null };
  const fetchPatients = async (wanted: string[]) => {
    const out: Row[] = [];
    for (let i = 0; i < wanted.length; i += ID_CHUNK) {
      const { data, error } = await supabase
        .from("patients")
        .select("id, full_name, phone, merged_into_patient_id")
        .eq("clinic_id", doctor.clinicId)
        .in("id", wanted.slice(i, i + ID_CHUNK));
      if (error) throw new ApiError(500, "Bemorlarni yuklab bo‘lmadi");
      out.push(...((data ?? []) as Row[]));
    }
    return out;
  };
  const found = await fetchPatients([...new Set([...own, ...referralOf.keys()])]);

  // A record merged into another (Phase 14) is listed as the person's
  // canonical record, once: the same group the access decision uses.
  const canonicalOf = new Map(found.map((p) => [p.id, p.merged_into_patient_id ?? p.id]));
  const missing = [...new Set([...canonicalOf.values()])].filter((id) => !found.some((p) => p.id === id));
  const patients = [...found, ...(await fetchPatients(missing))].filter((p) => !p.merged_into_patient_id);
  for (const [id, canonical] of canonicalOf) {
    if (id === canonical) continue;
    if (own.has(id)) own.add(canonical);
    const visit = lastVisit.get(id);
    if (visit && (!lastVisit.has(canonical) || visit > lastVisit.get(canonical)!)) lastVisit.set(canonical, visit);
    const referral = referralOf.get(id);
    if (referral && !referralOf.has(canonical)) referralOf.set(canonical, referral);
  }

  const q = query.trim();
  const activity = (p: DoctorPatientSummary) => Date.parse((p.referral ? referralOf.get(p.id)!.created_at : p.lastVisitAt) ?? "") || 0;
  return patients
    .filter((p) => matches(p, q))
    .map((p) => {
      const referral = referralOf.get(p.id);
      return {
        id: p.id,
        fullName: p.full_name,
        phone: p.phone,
        relationship: own.has(p.id) ? ("own" as const) : ("referred" as const),
        lastVisitAt: lastVisit.get(p.id) ?? null,
        referral: referral ? { id: referral.id, status: referral.status, referringDoctorName: referral.referringDoctorName } : null,
      };
    })
    .sort((a, b) => {
      // Active referrals first, then most recent activity.
      if (!!a.referral !== !!b.referral) return a.referral ? -1 : 1;
      return activity(b) - activity(a);
    })
    .slice(0, MAX_RESULTS);
}
