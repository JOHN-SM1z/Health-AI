import "server-only";
import { timingSafeEqual } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { ageInYears } from "@/lib/patients/age";
import { serverHmac } from "@/lib/security/server-hmac";
import { ApiError } from "@/lib/api/errors";
import { recordAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import type { StaffContext } from "@/lib/auth/staff";

/**
 * Patient merge (Phase 14) — owner / administrator only.
 *
 * A merge links a duplicate record to a canonical record of the same clinic;
 * nothing recorded for either is moved, rewritten or deleted (see
 * supabase/migrations/20261005000016_patient_merge.sql). The preview is
 * computed by the database and carries a fingerprint; the merge recomputes
 * it under row locks and refuses if anything changed, or if any blocker
 * exists. Every merge can be undone (unmerge), and both are audited.
 *
 * The preview shows names, phones and per-entity COUNTS only — never clinical
 * text, result values or identifier values (PINFL, passport, Telegram id),
 * and an AGE instead of the date of birth (owner decision 2026-10-08). The
 * database fingerprint hashes the date of birth among other fields, so the
 * browser receives a server-keyed HMAC of it instead (a short date space must
 * not be recoverable by hashing guesses); the merge recomputes the preview and
 * compares tokens before the database re-checks it under row locks.
 */

type Staff = StaffContext & { clinicId: string };

const ERRORS: Array<[RegExp, number, string, string]> = [
  [/patient_merge_not_found/, 404, "Bemor yoki birlashtirish topilmadi", "not_found"],
  [/patient_merge_forbidden/, 403, "Bemorlarni faqat klinika egasi yoki administrator birlashtiradi", "forbidden"],
  [/patient_merge_reason_required/, 400, "Sababini yozing", "reason_required"],
  [/patient_merge_preview_changed/, 409, "Kartalar ko‘rib chiqilgandan keyin o‘zgargan — qayta ko‘rib chiqing", "preview_changed"],
  [/patient_merge_already_undone/, 409, "Bu birlashtirish allaqachon bekor qilingan", "already_undone"],
  [/patient_merge_blocked/, 409, "Birlashtirib bo‘lmaydi — to‘siqlarni bartaraf eting", "merge_blocked"],
];

function mapError(error: { message?: string; code?: string }, what: string): ApiError {
  const known = ERRORS.find(([pattern]) => pattern.test(error.message ?? ""));
  if (known) {
    const blockers = /patient_merge_blocked: (.*)$/.exec(error.message ?? "")?.[1]?.split(",");
    return new ApiError(known[1], known[2], known[3], blockers ? { blockers } : undefined);
  }
  logger.error(`patient merge: ${what} failed`, { code: error.code });
  return new ApiError(500, "Amalni bajarib bo‘lmadi", "merge_failed");
}

type Counts = Record<string, number>;
type DbSide = {
  id: string;
  full_name: string | null;
  phone: string | null;
  date_of_birth: string | null;
  sex: string | null;
  has_pinfl: boolean;
  has_document: boolean;
  has_telegram: boolean;
  created_at: string;
  counts: Counts;
};
type Side = {
  id: string;
  full_name: string | null;
  phone: string | null;
  age: number | null;
  has_date_of_birth: boolean;
  has_sex: boolean;
  has_pinfl: boolean;
  has_document: boolean;
  has_telegram: boolean;
  created_at: string;
  counts: Counts;
};
export type MergePreview = {
  canonical: Side;
  duplicate: Side;
  plan: Record<string, string>;
  doctors_gaining_access: Array<{ doctor_id: string; name: string; from: "canonical" | "duplicate" }>;
  blockers: string[];
  warnings: string[];
  fingerprint: string;
};

type DbPreview = Omit<MergePreview, "canonical" | "duplicate"> & { canonical: DbSide; duplicate: DbSide };

/** Opaque to the browser: proves which preview the staff member saw without exposing what it hashed. */
const previewToken = (fingerprint: string) => serverHmac("patient-merge-preview", fingerprint);

function toSide(s: DbSide, timezone: string): Side {
  const { date_of_birth, sex, ...rest } = s;
  return { ...rest, age: ageInYears(date_of_birth, timezone), has_date_of_birth: date_of_birth !== null, has_sex: sex !== null };
}

async function dbPreview(staff: Staff, canonicalId: string, duplicateId: string): Promise<DbPreview> {
  const { data, error } = await createAdminClient().rpc("patient_merge_preview", {
    p_clinic_id: staff.clinicId,
    p_canonical_id: canonicalId,
    p_duplicate_id: duplicateId,
  });
  if (error) throw mapError(error, "preview");
  return data as unknown as DbPreview;
}

export async function getMergePreview(staff: Staff, canonicalId: string, duplicateId: string): Promise<MergePreview> {
  const raw = await dbPreview(staff, canonicalId, duplicateId);
  const preview: MergePreview = {
    ...raw,
    canonical: toSide(raw.canonical, staff.clinicTimezone),
    duplicate: toSide(raw.duplicate, staff.clinicTimezone),
    fingerprint: previewToken(raw.fingerprint),
  };
  await recordAudit({
    clinicId: staff.clinicId,
    action: "patient_merge_previewed",
    entityType: "patients",
    entityId: canonicalId,
    patientId: canonicalId,
    actor: { actorId: staff.profileId, actorType: "staff" },
    metadata: { duplicate_patient_id: duplicateId, blockers: preview.blockers },
  });
  return preview;
}

export async function mergePatients(
  staff: Staff,
  input: { canonicalId: string; duplicateId: string; reason: string; fingerprint: string },
): Promise<{ mergeId: string }> {
  // The browser holds a token, not the database fingerprint: recompute the preview, compare tokens, then let the
  // database compare fingerprints again under its row locks.
  const current = await dbPreview(staff, input.canonicalId, input.duplicateId);
  const expected = Buffer.from(previewToken(current.fingerprint), "hex");
  const given = Buffer.from(input.fingerprint, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new ApiError(409, "Kartalar ko‘rib chiqilgandan keyin o‘zgargan — qayta ko‘rib chiqing", "preview_changed");
  }
  const { data, error } = await createAdminClient().rpc("merge_patients", {
    p_clinic_id: staff.clinicId,
    p_canonical_id: input.canonicalId,
    p_duplicate_id: input.duplicateId,
    p_actor: staff.profileId,
    p_reason: input.reason,
    p_fingerprint: current.fingerprint,
  });
  if (error) throw mapError(error, "merge");
  return { mergeId: data as string };
}

export async function unmergePatients(staff: Staff, mergeId: string, reason: string) {
  const { data, error } = await createAdminClient().rpc("unmerge_patients", {
    p_clinic_id: staff.clinicId,
    p_merge_id: mergeId,
    p_actor: staff.profileId,
    p_reason: reason,
  });
  if (error) throw mapError(error, "unmerge");
  return data as {
    restored_fields: string[];
    left_on_canonical: string[];
    copied_fields_kept: string[];
    created_on_canonical_since_merge: Counts;
  };
}

const patientLine = (p: { full_name: string | null; date_of_birth: string | null; phone: string | null } | null, timezone: string) =>
  p ? { name: p.full_name, age: ageInYears(p.date_of_birth, timezone), phone: p.phone } : null;

export async function listMerges(staff: Staff) {
  const { data, error } = await createAdminClient()
    .from("patient_merges")
    .select(
      "id, canonical_patient_id, duplicate_patient_id, reason, merged_at, unmerged_at, unmerge_reason, moved, copied, " +
        "canonical:patients!patient_merges_canonical_fkey(full_name, date_of_birth, phone), duplicate:patients!patient_merges_duplicate_fkey(full_name, date_of_birth, phone), " +
        "merger:profiles!patient_merges_merged_by_fkey(full_name), unmerger:profiles!patient_merges_unmerged_by_fkey(full_name)",
    )
    .eq("clinic_id", staff.clinicId)
    .order("merged_at", { ascending: false })
    .limit(100);
  if (error) throw mapError(error, "list");
  type Row = {
    id: string;
    canonical_patient_id: string;
    duplicate_patient_id: string;
    reason: string;
    merged_at: string;
    unmerged_at: string | null;
    unmerge_reason: string | null;
    moved: Record<string, unknown>;
    copied: Record<string, unknown>;
    canonical: { full_name: string | null; date_of_birth: string | null; phone: string | null } | null;
    duplicate: { full_name: string | null; date_of_birth: string | null; phone: string | null } | null;
    merger: { full_name: string | null } | null;
    unmerger: { full_name: string | null } | null;
  };
  return ((data ?? []) as unknown as Row[]).map((m) => ({
    id: m.id,
    canonicalId: m.canonical_patient_id,
    duplicateId: m.duplicate_patient_id,
    canonical: patientLine(m.canonical, staff.clinicTimezone),
    duplicate: patientLine(m.duplicate, staff.clinicTimezone),
    reason: m.reason,
    mergedAt: m.merged_at,
    mergedBy: m.merger?.full_name ?? null,
    // Field names only — never the identity values themselves.
    movedFields: Object.keys(m.moved).filter((k) => !k.startsWith("telegram_") || k === "telegram_user_id"),
    copiedFields: Object.keys(m.copied).filter((k) => k !== "consent_given_at"),
    unmergedAt: m.unmerged_at,
    unmergedBy: m.unmerger?.full_name ?? null,
    unmergeReason: m.unmerge_reason,
  }));
}

/** Pairs worth a look — suggestions only; nothing is merged without a person. */
export async function listDuplicateCandidates(staff: Staff) {
  const db = createAdminClient();
  const { data, error } = await db.rpc("patient_duplicate_candidates", { p_clinic_id: staff.clinicId, p_limit: 100 });
  if (error) throw mapError(error, "candidates");
  const pairs = (data ?? []) as Array<{ patient_a: string; patient_b: string; reasons: string[] }>;
  const ids = [...new Set(pairs.flatMap((p) => [p.patient_a, p.patient_b]))];
  const people = new Map<string, { name: string | null; age: number | null; phone: string | null; telegram: boolean; createdAt: string }>();
  for (let i = 0; i < ids.length; i += 150) {
    const { data: ps, error: pe } = await db
      .from("patients")
      .select("id, full_name, telegram_first_name, telegram_last_name, date_of_birth, phone, telegram_user_id, created_at")
      .eq("clinic_id", staff.clinicId)
      .in("id", ids.slice(i, i + 150));
    if (pe) throw mapError(pe, "candidate patients");
    for (const p of ps ?? []) {
      people.set(p.id, {
        name: p.full_name ?? ([p.telegram_first_name, p.telegram_last_name].filter(Boolean).join(" ") || null),
        age: ageInYears(p.date_of_birth, staff.clinicTimezone),
        phone: p.phone,
        telegram: p.telegram_user_id !== null,
        createdAt: p.created_at,
      });
    }
  }
  // A record others were already merged into can only be the canonical one.
  const hosts = new Set<string>();
  for (let i = 0; i < ids.length; i += 150) {
    const { data: merged, error: me } = await db.from("patients").select("merged_into_patient_id").eq("clinic_id", staff.clinicId).in("merged_into_patient_id", ids.slice(i, i + 150));
    if (me) throw mapError(me, "candidate groups");
    for (const m of merged ?? []) if (m.merged_into_patient_id) hosts.add(m.merged_into_patient_id);
  }
  return pairs.map((p) => ({
    a: { id: p.patient_a, ...people.get(p.patient_a)!, hasMergedRecords: hosts.has(p.patient_a) },
    b: { id: p.patient_b, ...people.get(p.patient_b)!, hasMergedRecords: hosts.has(p.patient_b) },
    reasons: p.reasons,
  }));
}
