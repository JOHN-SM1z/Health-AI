import { fromZonedTime } from "date-fns-tz";
import { parseParameterValue, type LabValueType } from "@/lib/labs/values";

/**
 * Reading single cells of an import row (Phase 13). Pure. Nothing is
 * guessed: a cell that does not read cleanly is an error for that row.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Read<T> = { ok: true; value: T } | { ok: false };

const okv = <T>(value: T): Read<T> => ({ ok: true, value });
const bad = { ok: false } as const;

export function readPatientId(raw: string): Read<string> {
  return UUID.test(raw) ? okv(raw.toLowerCase()) : bad;
}

/** Same canonical form as the database (normalize_identity_document): no spaces or dashes, upper case. */
function canonicalIdentity(raw: string): string {
  return raw.replace(/[\s-]+/g, "").toUpperCase();
}

export function readPinfl(raw: string): Read<string> {
  const v = canonicalIdentity(raw);
  return /^[0-9]{14}$/.test(v) ? okv(v) : bad;
}

export function readDocumentNumber(raw: string): Read<string> {
  const v = canonicalIdentity(raw);
  return /^[A-Z0-9]{5,20}$/.test(v) ? okv(v) : bad;
}

/** The last nine digits — an Uzbek number without the country code, however it was written. */
export function phoneKey(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  return digits.length >= 9 ? digits.slice(-9) : null;
}

export function readPhone(raw: string): Read<string> {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 9 || digits.length > 15) return bad;
  return okv(digits.slice(-9));
}

/** Names compared without case, punctuation or word order ("Karimov Ali" = "ALI KARIMOV"). */
export function normalizeName(raw: string | null | undefined): string | null {
  const tokens = (raw ?? "")
    .toLowerCase()
    .replace(/[ʻʼ‘’`'"]/g, "")
    .split(/[^\p{L}]+/u)
    .filter(Boolean)
    .sort();
  return tokens.length ? tokens.join(" ") : null;
}

const MALE = new Set(["m", "male", "man", "erkak", "e", "м", "муж", "мужской"]);
const FEMALE = new Set(["f", "female", "woman", "ayol", "ж", "жен", "женский"]);

export function readSex(raw: string): Read<"male" | "female"> {
  const v = raw.trim().toLowerCase().replace(/\.$/, "");
  if (MALE.has(v)) return okv("male");
  if (FEMALE.has(v)) return okv("female");
  return bad;
}

type Parts = { y: number; m: number; d: number; hh: number; mm: number; ss: number; hasTime: boolean };

function dateParts(raw: string): Parts | null {
  const v = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(v);
  if (m) return { y: +m[1], m: +m[2], d: +m[3], hh: +(m[4] ?? 0), mm: +(m[5] ?? 0), ss: +(m[6] ?? 0), hasTime: m[4] !== undefined };
  // Day first, as written in Uzbekistan (01.10.2026, 01/10/2026).
  m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(v);
  if (m) return { y: +m[3], m: +m[2], d: +m[1], hh: +(m[4] ?? 0), mm: +(m[5] ?? 0), ss: +(m[6] ?? 0), hasTime: m[4] !== undefined };
  return null;
}

function validParts(p: Parts): boolean {
  if (p.y < 1900 || p.m < 1 || p.m > 12 || p.d < 1 || p.hh > 23 || p.mm > 59 || p.ss > 59) return false;
  const check = new Date(Date.UTC(p.y, p.m - 1, p.d));
  return check.getUTCFullYear() === p.y && check.getUTCMonth() === p.m - 1 && check.getUTCDate() === p.d;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A calendar date (YYYY-MM-DD) from 1900 on. */
export function readDate(raw: string): Read<string> {
  const p = dateParts(raw);
  if (!p || p.hasTime || !validParts(p)) return bad;
  return okv(`${p.y}-${pad(p.m)}-${pad(p.d)}`);
}

/**
 * When the test was performed, as an instant. Local dates and times are in
 * the clinic's time zone; a date without a time is taken as midday so it
 * stays on the same calendar day everywhere. ISO instants with an offset are
 * kept as they are.
 */
export function readPerformedAt(raw: string, timezone: string): Read<string> {
  const v = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(v)) {
    const t = Date.parse(v);
    return Number.isNaN(t) || new Date(t).getUTCFullYear() < 1900 ? bad : okv(new Date(t).toISOString());
  }
  const p = dateParts(v);
  if (!p || !validParts(p)) return bad;
  const local = `${p.y}-${pad(p.m)}-${pad(p.d)}T${p.hasTime ? `${pad(p.hh)}:${pad(p.mm)}:${pad(p.ss)}` : "12:00:00"}`;
  return okv(fromZonedTime(local, timezone).toISOString());
}

/** The calendar day of an instant in a time zone (YYYY-MM-DD). */
export function dayIn(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

export type ParameterSpecForImport = {
  code: string;
  valueType: LabValueType;
  decimals: number | null;
  choices: string[] | null;
  unit: string | null;
};

export type ImportValue = { numeric: string | null; text: string | null; boolean: boolean | null };

const YES = new Set(["ha", "yes", "true", "1", "да"]);
const NO = new Set(["yoq", "yo‘q", "yo'q", "yoʻq", "no", "false", "0", "нет"]);

/** A cell as the parameter's type. Choices match the configured spelling (case aside). */
export function readValue(raw: string, spec: ParameterSpecForImport): Read<ImportValue> {
  const text = raw.trim();
  if (text === "") return bad;
  if (spec.valueType === "boolean") {
    const v = text.toLowerCase();
    if (YES.has(v)) return okv({ numeric: null, text: null, boolean: true });
    if (NO.has(v)) return okv({ numeric: null, text: null, boolean: false });
    return bad;
  }
  if (spec.valueType === "choice") {
    const choice = (spec.choices ?? []).find((c) => c.toLowerCase() === text.toLowerCase());
    return choice ? okv({ numeric: null, text: choice, boolean: null }) : bad;
  }
  const parsed = parseParameterValue("_", { code: spec.code, valueType: spec.valueType, decimals: spec.decimals, choices: spec.choices }, text);
  if (!parsed.ok || "clear" in parsed.entry) return bad;
  if ("value_numeric" in parsed.entry) return okv({ numeric: parsed.entry.value_numeric, text: null, boolean: null });
  if ("value_text" in parsed.entry) return okv({ numeric: null, text: parsed.entry.value_text, boolean: null });
  return bad;
}

/** Units compared without case, spaces or typographic variants (µ/u, ×/x, ^). */
export function normalizeUnit(raw: string | null | undefined): string {
  return (raw ?? "")
    .toLowerCase()
    .replace(/[µμ]/g, "u")
    .replace(/[×*]/g, "x")
    .replace(/[\s^]/g, "");
}
