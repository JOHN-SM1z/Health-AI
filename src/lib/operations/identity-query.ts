/**
 * Reception's patient lookup rules, shared by the search route and the
 * reception screen (owner, 2026-10-08): the receptionist types the patient's
 * passport/ID number or JSHSHIR and the date of birth as dd.mm.yyyy, and the
 * card is found in one step. A typed document is a lookup key, not identity
 * verification — that is MyID's job once it is integrated.
 */

export type QueryKind = "patient_number" | "pinfl" | "document" | "phone" | "name";

export type ClassifiedQuery = { kind: QueryKind; value: string };

/** What the typed text is, and its normalised value (documents upper-case, no spaces or dashes). */
export function classifyQuery(input: string): ClassifiedQuery {
  const text = input.trim();
  const compact = text.replace(/[\s-]+/g, "").toUpperCase();
  if (/^\d{1,9}$/.test(compact)) return { kind: "patient_number", value: compact };
  if (/^\d{14}$/.test(compact)) return { kind: "pinfl", value: compact };
  if (/^[A-Z]{2}\d{5,10}$/.test(compact)) return { kind: "document", value: compact };
  if (/^\+?\d[\d ()-]{6,}$/.test(text)) return { kind: "phone", value: text.replace(/\D/g, "").slice(-9) };
  return { kind: "name", value: text };
}

/** A passport/ID number or JSHSHIR: with the date of birth, it identifies a card in one step. */
export const isIdentityDocument = (q: ClassifiedQuery) => q.kind === "document" || q.kind === "pinfl";

/**
 * A date of birth typed as dd.mm.yyyy (dots, slashes, dashes or spaces; or
 * eight digits ddmmyyyy) → ISO yyyy-mm-dd. Null when it is not a real
 * calendar date between 1900 and `today` (ISO, the clinic's day).
 */
export function parseDob(input: string, today: string): string | null {
  const text = input.trim();
  const m = /^(\d{1,2})[./\-\s](\d{1,2})[./\-\s](\d{4})$/.exec(text) ?? /^(\d{2})(\d{2})(\d{4})$/.exec(text);
  if (!m) return null;
  const iso = `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) return null;
  if (iso < "1900-01-01" || iso > today) return null;
  return iso;
}

/** ISO yyyy-mm-dd → dd.mm.yyyy for display. */
export function formatDob(iso: string | null | undefined): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "—";
  const [y, mo, d] = iso.split("-");
  return `${d}.${mo}.${y}`;
}
