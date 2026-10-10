import { clinicDateKey } from "@/lib/time/local";

/**
 * A patient's age in whole years on the clinic's calendar day — what staff may see instead of the date of birth
 * (owner decision 2026-10-08: the date of birth, passport/ID and JSHSHIR stay server-side). Null when unknown.
 */
export function ageInYears(dateOfBirth: string | null | undefined, timezone = "Asia/Tashkent", now = new Date()): number | null {
  if (!dateOfBirth || !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) return null;
  const [by, bm, bd] = dateOfBirth.split("-").map(Number);
  const [ty, tm, td] = clinicDateKey(timezone, now).split("-").map(Number);
  const age = ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
  return age >= 0 ? age : null;
}
