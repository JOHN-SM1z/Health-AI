/**
 * Turning what a lab technician typed into a typed parameter value (Phase 8).
 *
 * Pure and shared: the entry screen uses it to show a mistake before saving,
 * and the server uses it again before calling the database (which checks the
 * type, the configured choices and the decimal places a third time). Nothing
 * here interprets a value clinically.
 */

export type LabValueType = "numeric" | "text" | "boolean" | "choice";

export type ParameterSpec = {
  code: string;
  valueType: LabValueType;
  decimals: number | null;
  choices: string[] | null;
};

/** What the database function takes for one parameter. */
export type DbValueEntry =
  | { parameter_id: string; value_numeric: string }
  | { parameter_id: string; value_text: string }
  | { parameter_id: string; value_boolean: boolean }
  | { parameter_id: string; clear: true };

export type ParsedValue = { ok: true; entry: DbValueEntry } | { ok: false; message: string };

const NUMBER = /^[-+]?\d+(?:[.,]\d+)?$/;
const MAX_ABS = 1e12;

/**
 * `raw` is the typed text (numeric, text, choice) or a boolean; empty text,
 * `null` and `undefined` clear the value. Numbers accept a decimal comma
 * ("7,2") and are kept as text so no precision is lost on the way.
 */
export function parseParameterValue(parameterId: string, spec: ParameterSpec, raw: string | boolean | null | undefined): ParsedValue {
  if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) {
    return { ok: true, entry: { parameter_id: parameterId, clear: true } };
  }

  switch (spec.valueType) {
    case "numeric": {
      if (typeof raw !== "string") return { ok: false, message: "Son kiriting" };
      const text = raw.trim().replace(/\s+/g, "");
      if (!NUMBER.test(text)) return { ok: false, message: "Son kiriting (masalan: 7,2)" };
      const normalized = text.replace(",", ".").replace(/^\+/, "");
      if (Math.abs(Number(normalized)) >= MAX_ABS) return { ok: false, message: "Qiymat juda katta" };
      const places = normalized.includes(".") ? normalized.split(".")[1].replace(/0+$/, "").length : 0;
      if (spec.decimals !== null && places > spec.decimals) {
        return { ok: false, message: spec.decimals === 0 ? "Butun son kiriting" : `Ko‘pi bilan ${spec.decimals} ta kasr xona` };
      }
      return { ok: true, entry: { parameter_id: parameterId, value_numeric: normalized } };
    }
    case "boolean": {
      if (typeof raw !== "boolean") return { ok: false, message: "Ha yoki Yo‘q tanlang" };
      return { ok: true, entry: { parameter_id: parameterId, value_boolean: raw } };
    }
    case "choice": {
      if (typeof raw !== "string" || !(spec.choices ?? []).includes(raw.trim())) {
        return { ok: false, message: "Ro‘yxatdagi qiymatlardan birini tanlang" };
      }
      return { ok: true, entry: { parameter_id: parameterId, value_text: raw.trim() } };
    }
    case "text": {
      if (typeof raw !== "string") return { ok: false, message: "Matn kiriting" };
      const text = raw.trim();
      if (text.length > 500) return { ok: false, message: "Ko‘pi bilan 500 belgi" };
      return { ok: true, entry: { parameter_id: parameterId, value_text: text } };
    }
  }
}

/** "120–150", "≥ 4", "≤ 9", or the expected text — the configured range, never an interpretation. */
export function formatRange(r: { low: number | string | null; high: number | string | null; text: string | null } | null): string | null {
  if (!r) return null;
  if (r.text) return r.text;
  if (r.low != null && r.high != null) return `${Number(r.low)}–${Number(r.high)}`;
  if (r.low != null) return `≥ ${Number(r.low)}`;
  if (r.high != null) return `≤ ${Number(r.high)}`;
  return null;
}
