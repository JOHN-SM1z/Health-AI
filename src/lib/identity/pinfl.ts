/**
 * The structure of a JSHSHIR (PINFL), the 14-digit personal number of an Uzbek citizen:
 *
 *   digit 1      century and sex — 1/2: 1800s, 3/4: 1900s, 5/6: 2000s; odd = male, even = female
 *   digits 2–7   date of birth, DDMMYY
 *   digits 8–10  region code
 *   digits 11–13 serial number for that day and region
 *   digit 14     check digit (its formula is not published, so it is not checked here)
 *
 * A typed JSHSHIR whose embedded date of birth differs from the date typed next to it is wrong — the patient is told
 * so at once. This proves nothing about who is typing (only OneID does); it catches typos and invented numbers, and
 * it reveals nothing about anyone else.
 */

const CENTURY: Record<string, number> = { "1": 1800, "2": 1800, "3": 1900, "4": 1900, "5": 2000, "6": 2000 };

/** The date of birth inside a JSHSHIR (YYYY-MM-DD), or null when the first seven digits are not a real date. */
export function pinflBirthDate(pinfl: string): string | null {
  if (!/^\d{14}$/.test(pinfl)) return null;
  const century = CENTURY[pinfl[0]];
  if (!century) return null;
  const dd = pinfl.slice(1, 3);
  const mm = pinfl.slice(3, 5);
  const yyyy = String(century + Number(pinfl.slice(5, 7)));
  const iso = `${yyyy}-${mm}-${dd}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : iso;
}

export function pinflSex(pinfl: string): "male" | "female" | null {
  if (!/^[1-6]\d{13}$/.test(pinfl)) return null;
  return Number(pinfl[0]) % 2 === 1 ? "male" : "female";
}

export type PinflCheck = "ok" | "invalid" | "birth_date_mismatch";

/** Whether a JSHSHIR is well formed and carries the given date of birth. */
export function checkPinflAgainstBirthDate(pinfl: string, dateOfBirth: string): PinflCheck {
  const embedded = pinflBirthDate(pinfl);
  if (!embedded) return "invalid";
  return embedded === dateOfBirth ? "ok" : "birth_date_mismatch";
}
