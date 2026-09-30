/**
 * The same normalization as public.normalize_phone() (patients.phone_normalized):
 * digits only; a leading 00 before 998 is dropped; a national number — 9
 * digits, or 10 with the trunk prefix 8 or 0 — gets the 998 country code. So
 * "+998 90 123-45-67", "998901234567", "00998901234567", "8 90 123 45 67" and
 * "90 123 45 67" are one number. Null when there are no digits.
 */
export function normalizePhone(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/[^0-9]/g, "");
  if (!digits) return null;
  if (digits.startsWith("00998")) return digits.slice(2);
  if (digits.length === 9) return `998${digits}`;
  if (digits.length === 10 && (digits[0] === "8" || digits[0] === "0")) return `998${digits.slice(1)}`;
  return digits;
}
