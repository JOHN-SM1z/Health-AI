/**
 * The same normalization as public.normalize_phone() (patients.phone_normalized,
 * 20261002000003): digits for matching ONE phone number however it is typed,
 * never matching two different people.
 *
 *  - an explicit international marker — a "+" before the first digit, or a
 *    leading "00" — means a full international number, kept as it is;
 *  - otherwise the number is read as an Uzbek national number: 9 digits get
 *    the country code 998, 10 digits with the trunk prefix 8 or 0 lose it and
 *    get 998, anything else stays as typed;
 *  - fewer than 7 or more than 15 digits (E.164's maximum) is no number to
 *    match on: null.
 *
 * So "+998 90 123-45-67", "998901234567", "00998901234567", "8 90 123 45 67" and
 * "90 123 45 67" are one number, "+298 123456" is never read as Uzbek, and "123"
 * matches nobody. Null when there is nothing to match on.
 */
export function normalizePhone(phone: string | null | undefined): string | null {
  const text = phone ?? "";
  const raw = text.replace(/[^0-9]/g, "");
  if (!raw) return null;
  let n: string;
  if (/^[^0-9]*\+/.test(text)) n = raw;
  else if (raw.startsWith("00")) n = raw.slice(2);
  else if (raw.length === 9) n = `998${raw}`;
  else if (raw.length === 10 && (raw[0] === "8" || raw[0] === "0")) n = `998${raw.slice(1)}`;
  else n = raw;
  return n.length >= 7 && n.length <= 15 ? n : null;
}

/** The digits of a search text, for finding a patient by part of a number. */
export function phoneDigits(text: string | null | undefined): string {
  return (text ?? "").replace(/[^0-9]/g, "");
}
