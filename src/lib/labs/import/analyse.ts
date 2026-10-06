import { createHash } from "node:crypto";
import type { LabValueType } from "@/lib/labs/values";
import {
  dayIn,
  normalizeName,
  normalizeUnit,
  readDate,
  readDocumentNumber,
  readPatientId,
  readPerformedAt,
  readPhone,
  readPinfl,
  readSex,
  readValue,
  type ImportValue,
} from "@/lib/labs/import/fields";
import { normalizeHeader, type ImportField, type ImportMapping } from "@/lib/labs/import/mapping";
import { hasAnyIdentifier, identityKey, matchPatient, type CandidatePatient, type ImportIdentity } from "@/lib/labs/import/matching";

/**
 * Validation, patient matching and duplicate detection for an import
 * (Phase 13). Pure: the server loads the file's rows, the catalog, candidate
 * patients and existing results, and stores what this returns.
 *
 * A "group" is one patient, one test, one moment (and source accession): it
 * becomes one result, imported whole or not at all. Its key is a hash of
 * those, so the same data always has the same key (the database refuses to
 * import a key twice).
 */

export type CatalogParameter = {
  id: string;
  code: string;
  name: string;
  valueType: LabValueType;
  decimals: number | null;
  choices: string[] | null;
  unit: string | null;
};
export type CatalogTest = { id: string; code: string; name: string; parameters: CatalogParameter[] };

export type RowError =
  // reading the row
  | "malformed_row"
  | "invalid_patient_id"
  | "invalid_pinfl"
  | "invalid_document"
  | "invalid_phone"
  | "invalid_dob"
  | "invalid_sex"
  | "no_identifiers"
  | "missing_test"
  | "unknown_test"
  | "missing_parameter"
  | "unknown_parameter"
  | "missing_value"
  | "invalid_value"
  | "unit_mismatch"
  | "missing_date"
  | "invalid_date"
  | "future_date"
  | "performed_before_birth"
  | "accession_too_long"
  // the patient
  | "insufficient_identifiers"
  | "no_candidate"
  | "confirm_patient"
  | "patient_id_unknown"
  | "identifiers_disagree"
  | "pinfl_differs"
  | "document_differs"
  | "dob_differs"
  | "sex_differs"
  | "several_patients"
  // the group
  | "duplicate_in_file"
  | "conflicting_in_file"
  | "several_results_same_day"
  | "group_has_errors"
  | "existing_result"
  | "existing_result_differs"
  // warnings (the row is still imported)
  | "name_differs"
  | "phone_differs";

export const WARNINGS: ReadonlySet<RowError> = new Set(["name_differs", "phone_differs"]);

export type RowStatus = "ready" | "invalid" | "unmatched" | "possible_match" | "conflict" | "duplicate";

export type ReadRow = {
  rowNumber: number;
  errors: RowError[];
  identity: ImportIdentity;
  patientKey: string;
  testId: string | null;
  parameterId: string | null;
  value: ImportValue | null;
  performedAt: string | null;
  accession: string | null;
};

export type AnalysedRow = {
  rowNumber: number;
  status: RowStatus;
  errors: RowError[];
  patientKey: string;
  patientId: string | null;
  matchKind: "patient_id" | "pinfl" | "document_number" | "staff_confirmed" | null;
  matchConfirmedBy: string | null;
  candidatePatientIds: string[];
  testId: string | null;
  parameterId: string | null;
  value: ImportValue | null;
  performedAt: string | null;
  accession: string | null;
  groupKey: string | null;
};

const FUTURE_SLACK_MS = 5 * 60_000;

// A row whose identifiers do not read cleanly is never matched to anyone.
const IDENTITY_ERRORS: ReadonlySet<RowError> = new Set(["invalid_patient_id", "invalid_pinfl", "invalid_document", "invalid_phone", "invalid_dob", "invalid_sex"]);
const CONFLICTS: ReadonlySet<RowError> = new Set(["patient_id_unknown", "identifiers_disagree", "pinfl_differs", "document_differs", "dob_differs", "sex_differs", "several_patients"]);

function findTest(catalog: readonly CatalogTest[], raw: string): CatalogTest | null {
  const code = raw.toLowerCase();
  const byCode = catalog.filter((t) => t.code.toLowerCase() === code);
  if (byCode.length === 1) return byCode[0];
  const name = normalizeHeader(raw);
  const byName = catalog.filter((t) => normalizeHeader(t.name) === name);
  return byName.length === 1 ? byName[0] : null;
}

function findParameter(test: CatalogTest, raw: string): CatalogParameter | null {
  const code = raw.toLowerCase();
  const byCode = test.parameters.filter((p) => p.code.toLowerCase() === code);
  if (byCode.length === 1) return byCode[0];
  const name = normalizeHeader(raw);
  const byName = test.parameters.filter((p) => normalizeHeader(p.name) === name);
  return byName.length === 1 ? byName[0] : null;
}

/** Reads every row against the mapping and the catalog. */
export function readRows(
  rows: ReadonlyArray<{ rowNumber: number; cells: string[] }>,
  headerCount: number,
  mapping: ImportMapping,
  catalog: readonly CatalogTest[],
  timezone: string,
  now: Date,
): ReadRow[] {
  const today = dayIn(now.toISOString(), timezone);
  return rows.map(({ rowNumber, cells }) => {
    const empty: ReadRow = { rowNumber, errors: [], identity: {}, patientKey: "", testId: null, parameterId: null, value: null, performedAt: null, accession: null };
    if (cells.length !== headerCount) return { ...empty, errors: ["malformed_row"] };

    const cell = (field: ImportField) => (mapping[field] === undefined ? "" : (cells[mapping[field]!] ?? "").trim());
    const errors: RowError[] = [];
    const identity: ImportIdentity = {};

    const read = <T>(field: ImportField, reader: (raw: string) => { ok: true; value: T } | { ok: false }, error: RowError): T | undefined => {
      const raw = cell(field);
      if (raw === "") return undefined;
      const r = reader(raw);
      if (!r.ok) {
        errors.push(error);
        return undefined;
      }
      return r.value;
    };
    identity.patientId = read("patient_id", readPatientId, "invalid_patient_id");
    identity.pinfl = read("pinfl", readPinfl, "invalid_pinfl");
    identity.documentNumber = read("document_number", readDocumentNumber, "invalid_document");
    identity.phoneKey = read("phone", readPhone, "invalid_phone");
    const dob = read("date_of_birth", readDate, "invalid_dob");
    if (dob && dob > today) errors.push("invalid_dob");
    else identity.dateOfBirth = dob;
    identity.sex = read("sex", readSex, "invalid_sex");
    const name = cell("full_name") || [cell("last_name"), cell("first_name")].filter(Boolean).join(" ");
    identity.name = normalizeName(name) ?? undefined;
    for (const key of Object.keys(identity) as Array<keyof ImportIdentity>) if (identity[key] === undefined) delete identity[key];
    if (!hasAnyIdentifier(identity) && !errors.length) errors.push("no_identifiers");

    let testId: string | null = null;
    let parameterId: string | null = null;
    let value: ImportValue | null = null;
    const testRaw = cell("test_code");
    const test = testRaw ? findTest(catalog, testRaw) : null;
    if (!testRaw) errors.push("missing_test");
    else if (!test) errors.push("unknown_test");
    else {
      testId = test.id;
      const paramRaw = cell("parameter_code");
      const param = paramRaw ? findParameter(test, paramRaw) : test.parameters.length === 1 ? test.parameters[0] : null;
      if (!param) errors.push(paramRaw ? "unknown_parameter" : "missing_parameter");
      else {
        parameterId = param.id;
        const valueRaw = cell("value");
        if (!valueRaw) errors.push("missing_value");
        else {
          const v = readValue(valueRaw, param);
          if (v.ok) value = v.value;
          else errors.push("invalid_value");
        }
        const unit = cell("unit");
        if (unit && normalizeUnit(unit) !== normalizeUnit(param.unit)) errors.push("unit_mismatch");
      }
    }
    if (!test && cell("value") === "") errors.push("missing_value");

    let performedAt: string | null = null;
    const dateRaw = cell("performed_at");
    if (!dateRaw) errors.push("missing_date");
    else {
      const d = readPerformedAt(dateRaw, timezone);
      if (!d.ok) errors.push("invalid_date");
      else if (Date.parse(d.value) > now.getTime() + FUTURE_SLACK_MS) errors.push("future_date");
      else performedAt = d.value;
    }

    let accession: string | null = cell("accession") || null;
    if (accession && accession.length > 80) {
      errors.push("accession_too_long");
      accession = null;
    }

    return { rowNumber, errors, identity, patientKey: identityKey(identity), testId, parameterId, value, performedAt, accession };
  });
}

/** What must be loaded to match these rows: patients by id, PINFL, document, or birth date. */
export function patientLookups(rows: readonly ReadRow[]) {
  const ids = new Set<string>();
  const pinfls = new Set<string>();
  const documents = new Set<string>();
  const birthDates = new Set<string>();
  for (const { identity: i } of rows) {
    if (i.patientId) ids.add(i.patientId);
    if (i.pinfl) pinfls.add(i.pinfl);
    if (i.documentNumber) documents.add(i.documentNumber);
    if (i.dateOfBirth) birthDates.add(i.dateOfBirth);
  }
  return { ids: [...ids], pinfls: [...pinfls], documents: [...documents], birthDates: [...birthDates] };
}

export type ExistingResult = { patientId: string; testId: string; at: string; values: Map<string, ImportValue> };
export type Confirmation = { patientId: string; by: string };

export function groupKeyOf(patientId: string, testId: string, performedAt: string, accession: string | null): string {
  return createHash("sha256").update(`${patientId}|${testId}|${performedAt}|${accession ?? ""}`).digest("hex");
}

function sameValue(a: ImportValue, b: ImportValue): boolean {
  if (a.numeric !== null || b.numeric !== null) return a.numeric !== null && b.numeric !== null && Number(a.numeric) === Number(b.numeric);
  if (a.boolean !== null || b.boolean !== null) return a.boolean === b.boolean;
  return a.text === b.text;
}

/** Matches, groups and checks duplicates; every row gets a status. */
export function analyseRows(
  read: readonly ReadRow[],
  ctx: {
    patients: readonly CandidatePatient[];
    confirmations: ReadonlyMap<string, Confirmation>;
    existing: readonly ExistingResult[];
    timezone: string;
  },
): AnalysedRow[] {
  const byId = new Map(ctx.patients.map((p) => [p.id, p]));
  const matches = new Map<string, ReturnType<typeof matchPatient>>();

  const rows: AnalysedRow[] = read.map((r) => {
    const out: AnalysedRow = {
      rowNumber: r.rowNumber,
      status: "invalid",
      errors: [...r.errors],
      patientKey: r.patientKey,
      patientId: null,
      matchKind: null,
      matchConfirmedBy: null,
      candidatePatientIds: [],
      testId: r.testId,
      parameterId: r.parameterId,
      value: r.value,
      performedAt: r.performedAt,
      accession: r.accession,
      groupKey: null,
    };
    if (r.errors.includes("malformed_row") || !hasAnyIdentifier(r.identity) || r.errors.some((e) => IDENTITY_ERRORS.has(e))) {
      return out; // the person cannot be matched safely
    }

    let match = matches.get(r.patientKey);
    if (!match) {
      match = matchPatient(r.identity, ctx.patients);
      matches.set(r.patientKey, match);
    }
    const confirmed = ctx.confirmations.get(r.patientKey);
    if (match.kind === "exact") {
      out.patientId = match.patientId;
      out.matchKind = match.via;
      out.errors.push(...match.warnings);
    } else if (match.kind === "possible" && confirmed && match.candidates.includes(confirmed.patientId)) {
      out.patientId = confirmed.patientId;
      out.matchKind = "staff_confirmed";
      out.matchConfirmedBy = confirmed.by;
      out.errors.push(...match.warnings);
    } else if (match.kind === "possible") {
      out.candidatePatientIds = match.candidates;
      out.errors.push("confirm_patient", ...match.warnings);
    } else if (match.kind === "conflict") {
      out.candidatePatientIds = match.candidates;
      out.errors.push(match.reason);
    } else {
      out.errors.push(match.reason);
    }

    const dob = out.patientId ? byId.get(out.patientId)?.dateOfBirth : null;
    if (dob && out.performedAt && dayIn(out.performedAt, ctx.timezone) < dob) out.errors.push("performed_before_birth");
    if (out.patientId && out.testId && out.performedAt) {
      out.groupKey = groupKeyOf(out.patientId, out.testId, out.performedAt, out.accession);
    }
    return out;
  });

  const blocking = (row: AnalysedRow) => row.errors.filter((e) => !WARNINGS.has(e));
  for (const row of rows) {
    const errs = blocking(row);
    if (!errs.length) row.status = "ready";
    else if (errs.includes("confirm_patient")) row.status = errs.length === 1 ? "possible_match" : "invalid";
    else if (errs.some((e) => CONFLICTS.has(e)))
      row.status = errs.length === 1 ? "conflict" : "invalid";
    else if (errs.some((e) => e === "no_candidate" || e === "insufficient_identifiers")) row.status = errs.length === 1 ? "unmatched" : "invalid";
    else row.status = "invalid";
  }

  // Groups: one result each.
  const groups = new Map<string, AnalysedRow[]>();
  for (const row of rows) if (row.groupKey) groups.set(row.groupKey, [...(groups.get(row.groupKey) ?? []), row]);

  for (const members of groups.values()) {
    // The same parameter twice in a group: identical → a duplicate line; different → a conflict.
    const byParam = new Map<string, AnalysedRow[]>();
    for (const row of members) if (row.parameterId && row.value) byParam.set(row.parameterId, [...(byParam.get(row.parameterId) ?? []), row]);
    for (const same of byParam.values()) {
      if (same.length < 2) continue;
      if (same.every((r) => sameValue(r.value!, same[0].value!))) {
        for (const extra of same.slice(1)) {
          extra.status = "duplicate";
          extra.errors.push("duplicate_in_file");
          extra.groupKey = null; // not part of the result
        }
      } else {
        for (const r of same) {
          r.status = "conflict";
          r.errors.push("conflicting_in_file");
        }
      }
    }
  }

  // One result per patient, test and day: several groups on one day cannot be told apart from duplicates.
  const byDay = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.groupKey) continue;
    const day = `${row.patientId}|${row.testId}|${dayIn(row.performedAt!, ctx.timezone)}`;
    byDay.set(day, (byDay.get(day) ?? new Set()).add(row.groupKey));
  }
  for (const row of rows) {
    if (!row.groupKey) continue;
    const day = `${row.patientId}|${row.testId}|${dayIn(row.performedAt!, ctx.timezone)}`;
    if (byDay.get(day)!.size > 1 && row.status === "ready") {
      row.status = "conflict";
      row.errors.push("several_results_same_day");
    }
  }

  // Against the clinic's records: never alongside (or over) an existing result of that patient, test and day.
  for (const [key, all] of groups) {
    const members = all.filter((r) => r.groupKey === key);
    const head = members[0];
    if (!head || members.some((r) => r.status !== "ready")) continue;
    const day = dayIn(head.performedAt!, ctx.timezone);
    const existing = ctx.existing.filter((e) => e.patientId === head.patientId && e.testId === head.testId && dayIn(e.at, ctx.timezone) === day);
    if (!existing.length) continue;
    const identical = existing.some(
      (e) => e.values.size === members.length && members.every((r) => e.values.has(r.parameterId!) && sameValue(e.values.get(r.parameterId!)!, r.value!)),
    );
    for (const r of members) {
      r.status = identical ? "duplicate" : "conflict";
      r.errors.push(identical ? "existing_result" : "existing_result_differs");
    }
  }

  // A group is imported whole or not at all.
  for (const [key, all] of groups) {
    const members = all.filter((r) => r.groupKey === key);
    if (members.some((r) => r.status !== "ready")) {
      for (const r of members) {
        if (r.status === "ready") {
          r.status = "invalid";
          r.errors.push("group_has_errors");
        }
      }
    }
  }
  return rows;
}

export type ImportSummary = {
  rows: number;
  byStatus: Record<string, number>;
  readyResults: number;
  readyPatients: number;
};

export function summarise(rows: ReadonlyArray<{ status: string; groupKey: string | null; patientId: string | null }>): ImportSummary {
  const byStatus: Record<string, number> = {};
  const groups = new Set<string>();
  const patients = new Set<string>();
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    if (r.status === "ready" && r.groupKey) {
      groups.add(r.groupKey);
      if (r.patientId) patients.add(r.patientId);
    }
  }
  return { rows: rows.length, byStatus, readyResults: groups.size, readyPatients: patients.size };
}
