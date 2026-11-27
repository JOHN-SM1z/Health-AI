import { z } from "zod";
import { uuidSchema } from "@/lib/api/validate";
import { ALLERGY_KINDS, ALLERGY_SEVERITIES, MAX_PRESCRIPTION_ITEMS, TIMINGS } from "@/lib/prescribing/options";

/**
 * Request shapes of the prescribing API. Only the doctor's own input and ids:
 * the clinic, the author, the catalogue values of a medicine (INN, form,
 * strength, prescription-only, controlled) and every status are set by the
 * server and the database, never taken from the browser.
 */

const text = (max: number, message: string) => z.string().trim().min(1, message).max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value ? value : undefined));

/** A positive amount with at most `decimals` decimal places. */
const amount = (decimals: number, message: string) =>
  z
    .number({ message })
    .positive(message)
    .max(100_000, message)
    .refine((value) => Number.isInteger(Math.round(value * 10 ** decimals * 1e6) / 1e6), message);

export const prescriptionItemSchema = z.object({
  drugId: uuidSchema,
  dose: amount(3, "Dozani to‘g‘ri kiriting"),
  doseUnit: text(20, "Doza birligini tanlang"),
  route: text(40, "Qabul yo‘lini tanlang"),
  frequency: text(40, "Qabul tartibini tanlang"),
  timing: z.enum(TIMINGS).default("any"),
  days: z.number({ message: "Kunlar sonini kiriting" }).int("Kunlar soni butun bo‘lishi kerak").min(1, "Kunlar sonini kiriting").max(365),
  quantity: amount(2, "Umumiy miqdorni to‘g‘ri kiriting"),
  instructions: optionalText(500),
  allergyOverrideReason: optionalText(300),
});

export type PrescriptionItemInput = z.infer<typeof prescriptionItemSchema>;

export const prescriptionItemsSchema = z
  .array(prescriptionItemSchema)
  .min(1, "Kamida bitta dori qo‘shing")
  .max(MAX_PRESCRIPTION_ITEMS, `Bitta retseptda ${MAX_PRESCRIPTION_ITEMS} tadan ko‘p dori bo‘lmaydi`);

export const savePrescriptionSchema = z.object({
  idempotencyKey: uuidSchema,
  appointmentId: uuidSchema,
  /** The doctor's existing draft to overwrite; omitted for a new draft. */
  prescriptionId: uuidSchema.optional(),
  /** The signed prescription this one will replace. */
  replacesId: uuidSchema.optional(),
  items: prescriptionItemsSchema,
});

export const signPrescriptionSchema = z.object({
  /** Required when the prescription replaces a signed one. */
  replaceReason: optionalText(300),
});

export const cancelPrescriptionSchema = z.object({
  reason: z.string().trim().min(3, "Bekor qilish sababini yozing").max(300),
});

export const nationalNumberSchema = z.object({
  number: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9./-]{3,39}$/, "Milliy retsept raqami noto‘g‘ri"),
});

export const allergySchema = z.object({
  idempotencyKey: uuidSchema,
  substance: text(160, "Allergiya chaqiruvchi moddani yozing"),
  substanceKind: z.enum(ALLERGY_KINDS).default("inn"),
  /** The catalogue entry the doctor picked, if they picked one. */
  drugId: uuidSchema.optional(),
  reaction: optionalText(300),
  severity: z.enum(ALLERGY_SEVERITIES).default("unknown"),
});

export const inactivateAllergySchema = z.object({
  reason: z.string().trim().min(3, "Sababini yozing").max(300),
});

/** A template stores the doctor's own item fields; the override reason is never part of a template. */
export const templateItemSchema = prescriptionItemSchema.omit({ allergyOverrideReason: true });

export const templateSchema = z.object({
  name: text(80, "Shablon nomini yozing"),
  items: z.array(templateItemSchema).min(1, "Kamida bitta dori qo‘shing").max(MAX_PRESCRIPTION_ITEMS),
});

export const clinicDrugSchema = z.object({
  inn: text(160, "Xalqaro nomini (INN) yozing"),
  innLatin: optionalText(160),
  tradeName: optionalText(160),
  form: optionalText(80),
  strength: optionalText(80),
  manufacturer: optionalText(160),
  drugClass: optionalText(120),
  aliases: z.array(z.string().trim().min(1).max(160)).max(20).default([]),
  // Explicit on purpose: nobody gets "not prescription-only" or "not controlled" by leaving a box untouched.
  rxOnly: z.boolean({ message: "Retsept bilan beriladimi — belgilang" }),
  controlled: z.boolean({ message: "Nazoratdagi dori ekanini belgilang" }),
  sortOrder: z.number().int().min(0).max(100_000).default(0),
});

export const formularyEntrySchema = z.object({
  drugId: uuidSchema,
  sortOrder: z.number().int().min(0).max(100_000).default(0),
});

export const formularyPatchSchema = z
  .object({
    sortOrder: z.number().int().min(0).max(100_000).optional(),
    active: z.boolean().optional(),
  })
  .refine((value) => value.sortOrder !== undefined || value.active !== undefined, "O‘zgartirish kiritilmadi");

/** What the doctor typed into a search box: 2–80 characters. */
export function parseSearchQuery(raw: string | null): string | null {
  const query = (raw ?? "").trim();
  return query.length >= 2 && query.length <= 80 ? query : null;
}
