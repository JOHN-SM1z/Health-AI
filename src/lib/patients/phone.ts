/**
 * The same normalization as public.normalize_phone() (patients.phone_normalized):
 * digits only, and a 9-digit local number gets the 998 country code — so
 * "+998 90 123-45-67", "998901234567" and "90 123 45 67" are one number.
 * Null when there are no digits.
 */
export function normalizePhone(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/[^0-9]/g, "");
  if (!digits) return null;
  return digits.length === 9 ? `998${digits}` : digits;
}
