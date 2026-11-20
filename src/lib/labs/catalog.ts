import "server-only";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { recordAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { uuidSchema } from "@/lib/api/validate";
import type { ClinicStaff } from "@/lib/labs/guards";

/**
 * Clinic laboratory configuration (Phase 4): categories, tests, parameters,
 * reference ranges and panels. Configuration only — nothing here interprets
 * a value clinically. Every write is scoped to the session's clinic; every
 * cross-reference must be the clinic's own (the database's composite keys
 * refuse anything else, and the errors are mapped to plain messages here).
 * Rows are never deleted: tests, parameters, ranges and panels are
 * deactivated, so ordered history keeps working (items hold snapshots).
 */

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const code = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._-]{1,32}$/, "Kod faqat lotin harflari, raqamlar va . _ - belgilaridan iborat bo‘lishi kerak");
const money = z.number().min(0).max(1_000_000_000).multipleOf(0.01);

export const categorySchema = z.object({
  name: text(120),
  sortOrder: z.number().int().optional(),
  active: z.boolean().optional(),
});

export const testSchema = z.object({
  categoryId: uuidSchema.nullable().optional(),
  code,
  name: text(200),
  sampleType: text(80),
  preparationText: optionalText(2000),
  turnaroundHours: z.number().int().min(1).max(8760).nullable().optional(),
  price: money,
  sortOrder: z.number().int().optional(),
  active: z.boolean().optional(),
});

const VALUE_TYPES = ["numeric", "text", "boolean", "choice"] as const;

export const parameterSchema = z
  .object({
    testId: uuidSchema,
    code,
    name: text(200),
    valueType: z.enum(VALUE_TYPES),
    unit: optionalText(40),
    decimals: z.number().int().min(0).max(6).nullable().optional(),
    choices: z.array(text(100)).min(2).max(50).nullable().optional(),
    sortOrder: z.number().int().optional(),
    active: z.boolean().optional(),
  })
  .superRefine((p, ctx) => {
    if (p.valueType !== "numeric" && (p.unit || p.decimals != null)) {
      ctx.addIssue({ code: "custom", message: "O‘lchov birligi faqat sonli ko‘rsatkich uchun" });
    }
    if ((p.valueType === "choice") !== Boolean(p.choices?.length)) {
      ctx.addIssue({ code: "custom", message: "Variantlar faqat tanlov turidagi ko‘rsatkich uchun va kamida 2 ta" });
    }
    if (p.choices && new Set(p.choices).size !== p.choices.length) {
      ctx.addIssue({ code: "custom", message: "Variantlar takrorlanmasligi kerak" });
    }
  });

/** Editable parameter fields; test, code and value type are fixed once created. */
export const parameterUpdateSchema = z.object({
  name: text(200).optional(),
  unit: optionalText(40),
  decimals: z.number().int().min(0).max(6).nullable().optional(),
  choices: z.array(text(100)).min(2).max(50).optional(),
  sortOrder: z.number().int().optional(),
  active: z.boolean().optional(),
});

const bound = z.number().finite().nullable().optional();

export const rangeSchema = z
  .object({
    parameterId: uuidSchema,
    sex: z.enum(["female", "male"]).nullable().optional(),
    ageMinDays: z.number().int().min(0).max(54750).nullable().optional(),
    ageMaxDays: z.number().int().min(0).max(54750).nullable().optional(),
    low: bound,
    high: bound,
    criticalLow: bound,
    criticalHigh: bound,
    normalText: optionalText(200),
    methodLabel: optionalText(120),
    active: z.boolean().optional(),
  })
  .superRefine((r, ctx) => {
    if (r.ageMinDays != null && r.ageMaxDays != null && r.ageMinDays > r.ageMaxDays) {
      ctx.addIssue({ code: "custom", message: "Yosh oralig‘i noto‘g‘ri" });
    }
    if (r.low != null && r.high != null && r.low > r.high) {
      ctx.addIssue({ code: "custom", message: "Pastki chegara yuqori chegaradan katta bo‘lmasligi kerak" });
    }
    if (r.criticalLow != null && r.low != null && r.criticalLow > r.low) {
      ctx.addIssue({ code: "custom", message: "Kritik pastki chegara me’yordan past bo‘lishi kerak" });
    }
    if (r.criticalHigh != null && r.high != null && r.criticalHigh < r.high) {
      ctx.addIssue({ code: "custom", message: "Kritik yuqori chegara me’yordan yuqori bo‘lishi kerak" });
    }
    if (r.low == null && r.high == null && !r.normalText) {
      ctx.addIssue({ code: "custom", message: "Chegaralar yoki kutilgan qiymat kiritilishi kerak" });
    }
  });

export const rangeUpdateSchema = z.object({ active: z.boolean() });

export const panelSchema = z.object({
  code,
  name: text(200),
  price: money,
  testIds: z.array(uuidSchema).min(2, "Panelda kamida 2 ta tahlil bo‘lishi kerak").max(100),
  sortOrder: z.number().int().optional(),
  active: z.boolean().optional(),
});

type Db = ReturnType<typeof createAdminClient>;
type PgError = { code?: string; message?: string } | null;

/** Database refusals as plain, data-free messages. */
function dbError(error: PgError, what: string): ApiError {
  const code = error?.code;
  const message = error?.message ?? "";
  if (code === "23505") return new ApiError(409, `Bunday ${what} allaqachon mavjud (kod yoki nom band)`, "duplicate");
  if (code === "23503") return new ApiError(400, "Bog‘langan yozuv bu klinikada topilmadi", "not_in_clinic");
  if (code === "23514") return new ApiError(400, "Ma’lumot cheklovlarga mos emas", "validation");
  if (code === "P0001") {
    if (/overlaps/.test(message)) return new ApiError(409, "Shu jins va yosh oralig‘i uchun faol me’yor allaqachon bor", "range_overlap");
    if (/true or false/.test(message)) return new ApiError(400, "Ha/yo‘q ko‘rsatkich uchun kutilgan qiymat true yoki false", "validation");
    if (/choices/.test(message)) return new ApiError(400, "Kutilgan qiymat variantlardan biri bo‘lishi kerak", "validation");
    if (/numeric parameters|normal_text only/.test(message)) return new ApiError(400, "Me’yor turi ko‘rsatkich turiga mos emas", "validation");
    if (/cannot change/.test(message)) return new ApiError(400, "Bu maydonni o‘zgartirib bo‘lmaydi", "immutable");
  }
  logger.error("lab catalog write failed", { code });
  return new ApiError(500, `${what[0].toUpperCase()}${what.slice(1)}ni saqlab bo‘lmadi`, "save_failed");
}

async function audit(staff: ClinicStaff, action: string, entityType: string, entityId: string, fields: string[]) {
  await recordAudit({
    clinicId: staff.clinicId,
    action,
    entityType,
    entityId,
    actor: { actorId: staff.profileId, actorType: "staff" },
    metadata: { fields },
  });
}

const changed = (body: Record<string, unknown>) => Object.keys(body).filter((k) => body[k] !== undefined);

/** Fails unless every id is a row of `table` in the clinic. */
async function assertInClinic(db: Db, table: "lab_tests" | "lab_test_categories" | "lab_test_parameters", ids: string[], clinicId: string) {
  if (ids.length === 0) return;
  const { data, error } = await db.from(table).select("id").eq("clinic_id", clinicId).in("id", ids);
  if (error) throw dbError(error, "yozuv");
  const found = new Set((data ?? []).map((r) => r.id));
  if (ids.some((id) => !found.has(id))) throw new ApiError(400, "Bog‘langan yozuv bu klinikada topilmadi", "not_in_clinic");
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function getLabCatalog(clinicId: string) {
  const db = createAdminClient();
  const [categories, tests, parameters, ranges, panels, panelTests] = await Promise.all([
    db.from("lab_test_categories").select("id, name, sort_order, active").eq("clinic_id", clinicId).order("sort_order").order("name"),
    db
      .from("lab_tests")
      .select("id, category_id, code, name, sample_type, preparation_text, turnaround_hours, price, sort_order, active")
      .eq("clinic_id", clinicId)
      .order("sort_order")
      .order("name"),
    db
      .from("lab_test_parameters")
      .select("id, test_id, code, name, value_type, unit, decimals, choices, sort_order, active")
      .eq("clinic_id", clinicId)
      .order("sort_order")
      .order("name"),
    db
      .from("lab_reference_ranges")
      .select("id, parameter_id, sex, age_min_days, age_max_days, low, high, critical_low, critical_high, normal_text, method_label, active")
      .eq("clinic_id", clinicId)
      .order("created_at"),
    db.from("lab_panels").select("id, code, name, price, sort_order, active").eq("clinic_id", clinicId).order("sort_order").order("name"),
    db.from("lab_panel_tests").select("panel_id, test_id, sort_order").eq("clinic_id", clinicId).order("sort_order"),
  ]);
  for (const r of [categories, tests, parameters, ranges, panels, panelTests]) {
    if (r.error) {
      logger.error("lab catalog read failed", { code: r.error.code });
      throw new ApiError(500, "Laboratoriya katalogini yuklab bo‘lmadi", "load_failed");
    }
  }
  return {
    categories: categories.data ?? [],
    tests: tests.data ?? [],
    parameters: parameters.data ?? [],
    ranges: ranges.data ?? [],
    panels: (panels.data ?? []).map((p) => ({
      ...p,
      test_ids: (panelTests.data ?? []).filter((pt) => pt.panel_id === p.id).map((pt) => pt.test_id),
    })),
  };
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export async function saveCategory(staff: ClinicStaff, id: string | null, body: z.infer<typeof categorySchema> | Partial<z.infer<typeof categorySchema>>) {
  const db = createAdminClient();
  const row = { name: body.name, sort_order: body.sortOrder, active: body.active };
  const query = id
    ? db.from("lab_test_categories").update(row).eq("id", id).eq("clinic_id", staff.clinicId)
    : db.from("lab_test_categories").insert({ ...row, name: body.name!, clinic_id: staff.clinicId });
  const { data, error } = await query.select("id").maybeSingle();
  if (error) throw dbError(error, "bo‘lim");
  if (!data) throw new ApiError(404, "Bo‘lim topilmadi", "not_found");
  await audit(staff, id ? "lab_category_updated" : "lab_category_created", "lab_test_categories", data.id, changed(body));
  return data;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

export async function saveTest(staff: ClinicStaff, id: string | null, body: Partial<z.infer<typeof testSchema>>) {
  const db = createAdminClient();
  if (body.categoryId) await assertInClinic(db, "lab_test_categories", [body.categoryId], staff.clinicId);
  const row = {
    category_id: body.categoryId,
    code: body.code,
    name: body.name,
    sample_type: body.sampleType,
    preparation_text: body.preparationText === "" ? null : body.preparationText,
    turnaround_hours: body.turnaroundHours,
    price: body.price,
    sort_order: body.sortOrder,
    active: body.active,
  };
  const query = id
    ? db.from("lab_tests").update(row).eq("id", id).eq("clinic_id", staff.clinicId)
    : db.from("lab_tests").insert({ ...row, code: body.code!, name: body.name!, sample_type: body.sampleType!, clinic_id: staff.clinicId });
  const { data, error } = await query.select("id").maybeSingle();
  if (error) throw dbError(error, "tahlil");
  if (!data) throw new ApiError(404, "Tahlil topilmadi", "not_found");
  await audit(staff, id ? "lab_test_updated" : "lab_test_created", "lab_tests", data.id, changed(body));
  return data;
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

export async function createParameter(staff: ClinicStaff, body: z.infer<typeof parameterSchema>) {
  const db = createAdminClient();
  await assertInClinic(db, "lab_tests", [body.testId], staff.clinicId);
  const { data, error } = await db
    .from("lab_test_parameters")
    .insert({
      clinic_id: staff.clinicId,
      test_id: body.testId,
      code: body.code,
      name: body.name,
      value_type: body.valueType,
      unit: body.valueType === "numeric" ? body.unit || null : null,
      decimals: body.valueType === "numeric" ? (body.decimals ?? null) : null,
      choices: body.valueType === "choice" ? body.choices! : null,
      sort_order: body.sortOrder ?? 0,
      active: body.active ?? true,
    })
    .select("id")
    .single();
  if (error) throw dbError(error, "ko‘rsatkich");
  await audit(staff, "lab_parameter_created", "lab_test_parameters", data.id, changed(body));
  return data;
}

export async function updateParameter(staff: ClinicStaff, id: string, body: z.infer<typeof parameterUpdateSchema>) {
  const db = createAdminClient();
  const { data: current, error: readError } = await db
    .from("lab_test_parameters")
    .select("id, value_type")
    .eq("id", id)
    .eq("clinic_id", staff.clinicId)
    .maybeSingle();
  if (readError) throw dbError(readError, "ko‘rsatkich");
  if (!current) throw new ApiError(404, "Ko‘rsatkich topilmadi", "not_found");
  if (current.value_type !== "numeric" && (body.unit || body.decimals != null)) {
    throw new ApiError(400, "O‘lchov birligi faqat sonli ko‘rsatkich uchun", "validation");
  }
  if (body.choices) {
    if (current.value_type !== "choice") throw new ApiError(400, "Variantlar faqat tanlov turidagi ko‘rsatkich uchun", "validation");
    if (new Set(body.choices).size !== body.choices.length) throw new ApiError(400, "Variantlar takrorlanmasligi kerak", "validation");
    // An active range must keep expecting one of the choices.
    const { data: ranges, error } = await db
      .from("lab_reference_ranges")
      .select("normal_text")
      .eq("parameter_id", id)
      .eq("active", true);
    if (error) throw dbError(error, "ko‘rsatkich");
    if ((ranges ?? []).some((r) => r.normal_text && !body.choices!.includes(r.normal_text))) {
      throw new ApiError(409, "Faol me’yor olib tashlanayotgan variantga tayanadi — avval me’yorni o‘chiring", "choice_in_use");
    }
  }
  const { data, error } = await db
    .from("lab_test_parameters")
    .update({ name: body.name, unit: body.unit, decimals: body.decimals, choices: body.choices, sort_order: body.sortOrder, active: body.active })
    .eq("id", id)
    .eq("clinic_id", staff.clinicId)
    .select("id")
    .maybeSingle();
  if (error) throw dbError(error, "ko‘rsatkich");
  if (!data) throw new ApiError(404, "Ko‘rsatkich topilmadi", "not_found");
  await audit(staff, "lab_parameter_updated", "lab_test_parameters", id, changed(body));
  return data;
}

// ---------------------------------------------------------------------------
// Reference ranges: created, then only (de)activated — a changed range is a
// new range, so results keep pointing at the range they were evaluated with.
// ---------------------------------------------------------------------------

export async function createRange(staff: ClinicStaff, body: z.infer<typeof rangeSchema>) {
  const db = createAdminClient();
  await assertInClinic(db, "lab_test_parameters", [body.parameterId], staff.clinicId);
  const { data, error } = await db
    .from("lab_reference_ranges")
    .insert({
      clinic_id: staff.clinicId,
      parameter_id: body.parameterId,
      sex: body.sex ?? null,
      age_min_days: body.ageMinDays ?? null,
      age_max_days: body.ageMaxDays ?? null,
      low: body.low ?? null,
      high: body.high ?? null,
      critical_low: body.criticalLow ?? null,
      critical_high: body.criticalHigh ?? null,
      normal_text: body.normalText || null,
      method_label: body.methodLabel || null,
      active: body.active ?? true,
    })
    .select("id")
    .single();
  if (error) throw dbError(error, "me’yor");
  await audit(staff, "lab_range_created", "lab_reference_ranges", data.id, changed(body));
  return data;
}

export async function setRangeActive(staff: ClinicStaff, id: string, active: boolean) {
  const db = createAdminClient();
  const { data, error } = await db
    .from("lab_reference_ranges")
    .update({ active })
    .eq("id", id)
    .eq("clinic_id", staff.clinicId)
    .select("id")
    .maybeSingle();
  if (error) throw dbError(error, "me’yor");
  if (!data) throw new ApiError(404, "Me’yor topilmadi", "not_found");
  await audit(staff, active ? "lab_range_activated" : "lab_range_deactivated", "lab_reference_ranges", id, ["active"]);
  return data;
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

export async function savePanel(staff: ClinicStaff, id: string | null, body: Partial<z.infer<typeof panelSchema>>) {
  const db = createAdminClient();
  if (body.testIds) {
    if (new Set(body.testIds).size !== body.testIds.length) throw new ApiError(400, "Tahlillar takrorlanmasligi kerak", "validation");
    await assertInClinic(db, "lab_tests", body.testIds, staff.clinicId);
  }
  const row = { code: body.code, name: body.name, price: body.price, sort_order: body.sortOrder, active: body.active };
  const query = id
    ? db.from("lab_panels").update(row).eq("id", id).eq("clinic_id", staff.clinicId)
    : db.from("lab_panels").insert({ ...row, code: body.code!, name: body.name!, clinic_id: staff.clinicId });
  const { data, error } = await query.select("id").maybeSingle();
  if (error) throw dbError(error, "panel");
  if (!data) throw new ApiError(404, "Panel topilmadi", "not_found");

  if (body.testIds) {
    // Membership is configuration: ordered items keep their own panel and
    // price snapshots, so replacing it never rewrites history.
    const { error: deleteError } = await db.from("lab_panel_tests").delete().eq("panel_id", data.id).eq("clinic_id", staff.clinicId);
    if (deleteError) throw dbError(deleteError, "panel");
    const { error: insertError } = await db
      .from("lab_panel_tests")
      .insert(body.testIds.map((testId, i) => ({ panel_id: data.id, test_id: testId, clinic_id: staff.clinicId, sort_order: i })));
    if (insertError) throw dbError(insertError, "panel");
  }
  await audit(staff, id ? "lab_panel_updated" : "lab_panel_created", "lab_panels", data.id, changed(body));
  return data;
}
