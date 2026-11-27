/**
 * Choices and pure helpers of the prescribing screen (specification §9.3),
 * shared by the server and the browser. Everything here is the doctor's own
 * input or plain arithmetic on it — nothing is suggested by a model (RX-03).
 */

export const DOSE_UNITS = ["tabletka", "kapsula", "ml", "mg", "g", "mkg", "tomchi", "doza", "XB", "sham", "paket"] as const;

export const ROUTES = [
  "ichishga",
  "til ostiga",
  "mushak ichiga",
  "vena ichiga",
  "teri ostiga",
  "sirtga",
  "ingalyatsiya",
  "ko‘zga",
  "quloqqa",
  "burunga",
  "to‘g‘ri ichakka",
  "qinga",
] as const;

/** The frequency chips: "N×1" is N times a day. Anything else is the doctor's own wording. */
export const FREQUENCY_CHIPS = ["1×1", "2×1", "3×1", "4×1"] as const;

export const TIMINGS = ["any", "before_food", "after_food", "with_food"] as const;
export type Timing = (typeof TIMINGS)[number];

export const TIMING_LABELS: Record<Timing, string> = {
  any: "Ovqatga bog‘liq emas",
  before_food: "Ovqatdan oldin",
  after_food: "Ovqatdan keyin",
  with_food: "Ovqat bilan",
};

export const ALLERGY_KINDS = ["inn", "class", "other"] as const;
export type AllergyKind = (typeof ALLERGY_KINDS)[number];

export const ALLERGY_KIND_LABELS: Record<AllergyKind, string> = {
  inn: "Dori moddasi (INN)",
  class: "Dorilar guruhi",
  other: "Boshqa",
};

export const ALLERGY_SEVERITIES = ["unknown", "mild", "moderate", "severe"] as const;
export type AllergySeverity = (typeof ALLERGY_SEVERITIES)[number];

export const ALLERGY_SEVERITY_LABELS: Record<AllergySeverity, string> = {
  unknown: "Aniqlanmagan",
  mild: "Yengil",
  moderate: "O‘rtacha",
  severe: "Og‘ir",
};

export const PRESCRIPTION_STATUS_LABELS: Record<string, string> = {
  draft: "Qoralama",
  signed: "Imzolangan",
  replaced: "Almashtirilgan",
  cancelled: "Bekor qilingan",
};

export const MAX_PRESCRIPTION_ITEMS = 20;

/** Times a day for a frequency chip ("3×1" → 3); null for the doctor's own wording. */
export function timesPerDay(frequency: string): number | null {
  const match = /^([1-9]\d?)\s*[×x*]\s*1$/i.exec(frequency.trim());
  if (!match) return null;
  const times = Number(match[1]);
  return times >= 1 && times <= 24 ? times : null;
}

/**
 * The quantity for the whole course: dose × times a day × days, in the dose
 * unit. Only arithmetic on what the doctor entered, shown as an editable
 * default; null when the frequency is free wording or an input is missing.
 */
export function courseQuantity(dose: number, frequency: string, days: number): number | null {
  const times = timesPerDay(frequency);
  if (times === null || !Number.isFinite(dose) || dose <= 0 || !Number.isInteger(days) || days < 1) return null;
  const quantity = Math.round(dose * times * days * 100) / 100;
  return quantity > 0 && quantity <= 100_000 ? quantity : null;
}

/** "Amoksitsillin · Amoxil · kapsula 500 mg" — INN first, the way a result is shown. */
export function drugLabel(drug: { inn: string; tradeName?: string | null; form?: string | null; strength?: string | null }): string {
  const tail = [drug.form, drug.strength].filter(Boolean).join(" ");
  return [drug.inn, drug.tradeName, tail].filter(Boolean).join(" · ");
}
