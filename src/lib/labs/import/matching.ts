/**
 * Matching an import row's person to a patient of the clinic (Phase 13).
 * Pure. There is no automatic merge tool, so the rule is: import only when
 * the patient is certain, and never create, merge or change a patient.
 *
 *   exact      — a strong identifier (Health AI patient id, PINFL, passport /
 *                ID number) names exactly one patient, and nothing else in
 *                the row contradicts that patient (date of birth, PINFL,
 *                document, sex). Imported.
 *   possible   — no strong identifier matched, but phone + date of birth (or
 *                full name + date of birth) fit exactly one patient. Never
 *                imported unless a staff member confirms that patient.
 *   conflict   — identifiers point to different patients, contradict the
 *                patient they name, an unknown Health AI id, or several
 *                patients fit equally (possible duplicate patients). Never
 *                imported; resolve the records first.
 *   unmatched  — no patient fits. Never imported (no patient is created).
 *
 * A name alone never matches anyone.
 */

export type ImportIdentity = {
  patientId?: string;
  pinfl?: string;
  documentNumber?: string;
  phoneKey?: string;
  dateOfBirth?: string;
  name?: string;
  sex?: "male" | "female";
};

export type CandidatePatient = {
  id: string;
  pinfl: string | null;
  documentNumber: string | null;
  phoneKey: string | null;
  dateOfBirth: string | null;
  name: string | null;
  sex: "male" | "female" | null;
};

export type StrongVia = "patient_id" | "pinfl" | "document_number";

export type ConflictReason =
  | "patient_id_unknown"
  | "identifiers_disagree"
  | "pinfl_differs"
  | "document_differs"
  | "dob_differs"
  | "sex_differs"
  | "several_patients";

export type MatchOutcome =
  | { kind: "exact"; patientId: string; via: StrongVia; warnings: Array<"name_differs" | "phone_differs"> }
  | { kind: "possible"; candidates: string[]; via: "phone_dob" | "name_dob"; warnings: Array<"name_differs"> }
  | { kind: "conflict"; reason: ConflictReason; candidates: string[] }
  | { kind: "unmatched"; reason: "no_candidate" | "insufficient_identifiers" };

/** A stable key for "the same person as written in the file". */
export function identityKey(i: ImportIdentity): string {
  return [i.patientId, i.pinfl, i.documentNumber, i.phoneKey, i.dateOfBirth, i.name, i.sex].map((v) => v ?? "").join("|");
}

export function hasAnyIdentifier(i: ImportIdentity): boolean {
  return Boolean(i.patientId || i.pinfl || i.documentNumber || i.phoneKey || i.dateOfBirth);
}

/** True when a known value of the patient contradicts the file. */
function contradiction(i: ImportIdentity, p: CandidatePatient): ConflictReason | null {
  if (i.pinfl && p.pinfl && i.pinfl !== p.pinfl) return "pinfl_differs";
  if (i.documentNumber && p.documentNumber && i.documentNumber !== p.documentNumber) return "document_differs";
  if (i.dateOfBirth && p.dateOfBirth && i.dateOfBirth !== p.dateOfBirth) return "dob_differs";
  if (i.sex && p.sex && i.sex !== p.sex) return "sex_differs";
  return null;
}

export function matchPatient(identity: ImportIdentity, patients: readonly CandidatePatient[]): MatchOutcome {
  const strong = new Map<string, StrongVia>();
  if (identity.patientId) {
    const p = patients.find((c) => c.id === identity.patientId);
    if (!p) return { kind: "conflict", reason: "patient_id_unknown", candidates: [] };
    strong.set(p.id, "patient_id");
  }
  if (identity.pinfl) {
    for (const p of patients) if (p.pinfl === identity.pinfl && !strong.has(p.id)) strong.set(p.id, "pinfl");
  }
  if (identity.documentNumber) {
    for (const p of patients) if (p.documentNumber === identity.documentNumber && !strong.has(p.id)) strong.set(p.id, "document_number");
  }

  if (strong.size > 1) return { kind: "conflict", reason: "identifiers_disagree", candidates: [...strong.keys()] };
  if (strong.size === 1) {
    const [[id, via]] = [...strong.entries()];
    const p = patients.find((c) => c.id === id)!;
    const reason = contradiction(identity, p);
    if (reason) return { kind: "conflict", reason, candidates: [id] };
    const warnings: Array<"name_differs" | "phone_differs"> = [];
    if (identity.name && p.name && identity.name !== p.name) warnings.push("name_differs");
    if (identity.phoneKey && p.phoneKey && identity.phoneKey !== p.phoneKey) warnings.push("phone_differs");
    return { kind: "exact", patientId: id, via, warnings };
  }

  // No strong identifier matched: date of birth plus phone or full name may
  // suggest a patient, for a staff member to confirm.
  if (!identity.dateOfBirth || (!identity.phoneKey && !identity.name)) {
    return { kind: "unmatched", reason: identity.pinfl || identity.documentNumber ? "no_candidate" : "insufficient_identifiers" };
  }
  // Same birth date, and nothing known about them that contradicts the file.
  const sameBirth = patients.filter((p) => p.dateOfBirth === identity.dateOfBirth && contradiction(identity, p) === null);

  if (identity.phoneKey) {
    const byPhone = sameBirth.filter((p) => p.phoneKey === identity.phoneKey);
    if (byPhone.length === 1) {
      const p = byPhone[0];
      return { kind: "possible", candidates: [p.id], via: "phone_dob", warnings: identity.name && p.name && identity.name !== p.name ? ["name_differs"] : [] };
    }
    if (byPhone.length > 1) {
      const narrowed = identity.name ? byPhone.filter((p) => p.name === identity.name) : [];
      if (narrowed.length === 1) return { kind: "possible", candidates: [narrowed[0].id], via: "phone_dob", warnings: [] };
      return { kind: "conflict", reason: "several_patients", candidates: byPhone.map((p) => p.id) };
    }
  }
  if (identity.name) {
    const byName = sameBirth.filter((p) => p.name === identity.name);
    if (byName.length === 1) return { kind: "possible", candidates: [byName[0].id], via: "name_dob", warnings: [] };
    if (byName.length > 1) return { kind: "conflict", reason: "several_patients", candidates: byName.map((p) => p.id) };
  }
  return { kind: "unmatched", reason: "no_candidate" };
}
