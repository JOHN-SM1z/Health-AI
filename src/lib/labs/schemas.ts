import { z } from "zod";
import { uuidSchema } from "@/lib/api/validate";

/**
 * Request schemas of the laboratory configuration. All of them are .strict(): a request that names a
 * clinic, an author or any other column that is not the client's to set is refused, never silently
 * ignored — the clinic and the actor always come from the server-side session.
 */

const code = z.string().trim().regex(/^[A-Za-z0-9._-]{1,32}$/, "Kod 1–32 belgi: harf, raqam, nuqta, chiziq");
const money = z.number().min(0, "Narx manfiy bo‘lmaydi").max(1_000_000_000).multipleOf(0.01, "Narx tiyingacha");
const text = (max: number) => z.string().trim().max(max);

export const categoryCreateSchema = z
  .object({ name: text(80).min(1, "Nomini kiriting"), sortOrder: z.number().int().min(0).max(10_000).optional(), active: z.boolean().optional() })
  .strict();
export const categoryUpdateSchema = categoryCreateSchema.partial();

export const testCreateSchema = z
  .object({
    code,
    name: text(160).min(1, "Nomini kiriting"),
    categoryId: uuidSchema.nullable().optional(),
    description: text(1000).nullable().optional(),
    price: money,
    sampleType: text(60).min(1).nullable().optional(),
    preparationText: text(2000).nullable().optional(),
    turnaroundMinutes: z.number().int().min(1).max(525_600).nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict();
export const testUpdateSchema = testCreateSchema.partial();

export const parameterCreateSchema = z
  .object({
    testId: uuidSchema,
    code,
    name: text(120).min(1, "Nomini kiriting"),
    unit: text(32).nullable().optional(),
    dataType: z.enum(["numeric", "text", "choice"]).optional(),
    choices: z.array(text(80).min(1)).min(1).max(50).nullable().optional(),
    displayOrder: z.number().int().min(0).max(10_000).optional(),
    active: z.boolean().optional(),
  })
  .strict();
export const parameterUpdateSchema = parameterCreateSchema.omit({ testId: true }).partial();

const bound = z.number().finite().nullable().optional();
export const rangeCreateSchema = z
  .object({
    parameterId: uuidSchema,
    ageMinYears: z.number().int().min(0).max(150).nullable().optional(),
    ageMaxYears: z.number().int().min(0).max(150).nullable().optional(),
    low: bound,
    high: bound,
    criticalLow: bound,
    criticalHigh: bound,
    note: text(200).nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict();
export const rangeUpdateSchema = rangeCreateSchema.omit({ parameterId: true }).partial();

export const panelCreateSchema = z
  .object({
    code,
    name: text(160).min(1, "Nomini kiriting"),
    description: text(1000).nullable().optional(),
    // null: the panel costs the sum of its tests (a fixed price is applied at billing).
    price: money.nullable().optional(),
    active: z.boolean().optional(),
    testIds: z.array(uuidSchema).min(1, "Kamida bitta tahlil").max(200).refine((ids) => new Set(ids).size === ids.length, "Tahlil takrorlanmasin"),
  })
  .strict();
export const panelUpdateSchema = panelCreateSchema.partial();

/** Per-clinic laboratory policy (app_settings key "lab"). Defaults are the safest choice. */
export const labSettingsSchema = z
  .object({
    verification: z
      .object({
        /** Results need a verification step before they are final and visible beyond the lab. */
        required: z.boolean(),
        /** The verifier must be a different person from whoever entered the result. */
        separateVerifier: z.boolean(),
      })
      .strict(),
    collection: z.object({ requiresPayment: z.boolean() }).strict(),
    ordering: z
      .object({
        /**
         * A doctor ordering a test the patient already had within this many days sees an advisory notice
         * ("similar test N days ago"). 0 turns the notice off. Advisory only: it never blocks an order.
         */
        recentTestWindowDays: z.number().int().min(0).max(365),
      })
      .strict()
      .default({ recentTestWindowDays: 30 }),
  })
  .strict();
export type LabSettings = z.infer<typeof labSettingsSchema>;

export const DEFAULT_LAB_SETTINGS: LabSettings = {
  verification: { required: true, separateVerifier: false },
  collection: { requiresPayment: false },
  ordering: { recentTestWindowDays: 30 },
};
