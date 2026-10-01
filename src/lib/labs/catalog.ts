import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { logger } from "@/lib/logger";
import { DEFAULT_LAB_SETTINGS, labSettingsSchema, type LabSettings } from "@/lib/labs/schemas";

/**
 * The laboratory configuration of one clinic: categories, tests, parameters, reference ranges, panels and
 * the workflow settings. Every function takes the clinic from the server-side session — never from the
 * request — scopes every query by it, and answers 404 for another clinic's id exactly as for a missing
 * one. The database refuses the same cross-clinic references again (composite foreign keys).
 *
 * Callers authorize first (src/app/api/admin/lab/*): management writes, lab staff only read.
 */

type Db = ReturnType<typeof createAdminClient>;
const notFound = () => new ApiError(404, "Topilmadi", "lab_not_found");

/** Maps a database refusal to an API error without echoing row data. */
export function labCatalogError(error: { code?: string; message?: string }, fallback = "Saqlab bo‘lmadi"): ApiError {
  const message = error.message ?? "";
  if (error.code === "23505") return new ApiError(409, "Bunday kod yoki nom allaqachon mavjud", "duplicate");
  if (error.code === "23503") return new ApiError(404, "Bog‘langan yozuv topilmadi", "lab_not_found");
  if (error.code === "23514") return new ApiError(400, "Qiymatlar noto‘g‘ri (chegaralar, tur yoki uzunlik)", "validation");
  if (message.includes("lab catalog:")) return new ApiError(409, message.replace(/^.*lab catalog:\s*/, ""), "lab_catalog_rule");
  logger.error("lab catalog write failed", { code: error.code });
  return new ApiError(500, fallback);
}

async function owned(db: Db, table: "lab_categories" | "lab_tests" | "lab_test_parameters" | "lab_reference_ranges" | "lab_panels", clinicId: string, id: string) {
  const { data, error } = await db.from(table).select("id").eq("id", id).eq("clinic_id", clinicId).maybeSingle();
  if (error) throw new ApiError(500, "Tekshirib bo‘lmadi");
  if (!data) throw notFound();
}

// ---------- categories ----------

export async function listCategories(clinicId: string) {
  const { data, error } = await createAdminClient().from("lab_categories").select("*").eq("clinic_id", clinicId).order("sort_order").order("name");
  if (error) throw new ApiError(500, "Yuklab bo‘lmadi");
  return data ?? [];
}

export async function createCategory(clinicId: string, actor: string, input: { name: string; sortOrder?: number; active?: boolean }) {
  const { data, error } = await createAdminClient()
    .from("lab_categories")
    .insert({ clinic_id: clinicId, name: input.name, sort_order: input.sortOrder ?? 0, active: input.active ?? true, updated_by: actor })
    .select("*")
    .single();
  if (error) throw labCatalogError(error);
  return data;
}

export async function updateCategory(clinicId: string, actor: string, id: string, input: { name?: string; sortOrder?: number; active?: boolean }) {
  const db = createAdminClient();
  await owned(db, "lab_categories", clinicId, id);
  const { data, error } = await db
    .from("lab_categories")
    .update({ name: input.name, sort_order: input.sortOrder, active: input.active, updated_by: actor })
    .eq("id", id)
    .eq("clinic_id", clinicId)
    .select("*")
    .single();
  if (error) throw labCatalogError(error);
  return data;
}

// ---------- tests ----------

export async function listTests(clinicId: string, opts: { includeInactive: boolean }) {
  let query = createAdminClient()
    .from("lab_tests")
    .select("*, lab_categories(id, name), lab_test_parameters(id)")
    .eq("clinic_id", clinicId)
    .order("name");
  if (!opts.includeInactive) query = query.eq("active", true);
  const { data, error } = await query;
  if (error) throw new ApiError(500, "Yuklab bo‘lmadi");
  return (data ?? []).map(({ lab_categories, lab_test_parameters, ...test }) => ({
    ...test,
    category: lab_categories ?? null,
    parameterCount: (lab_test_parameters ?? []).length,
  }));
}

/** One test with its parameters and their reference ranges. */
export async function getTest(clinicId: string, id: string) {
  const db = createAdminClient();
  const { data: test, error } = await db.from("lab_tests").select("*").eq("id", id).eq("clinic_id", clinicId).maybeSingle();
  if (error) throw new ApiError(500, "Yuklab bo‘lmadi");
  if (!test) throw notFound();
  const { data: parameters, error: pError } = await db
    .from("lab_test_parameters")
    .select("*, lab_reference_ranges(*)")
    .eq("test_id", id)
    .eq("clinic_id", clinicId)
    .order("display_order")
    .order("name");
  if (pError) throw new ApiError(500, "Yuklab bo‘lmadi");
  return {
    ...test,
    parameters: (parameters ?? []).map(({ lab_reference_ranges, ...p }) => ({ ...p, ranges: lab_reference_ranges ?? [] })),
  };
}

type TestInput = {
  code?: string;
  name?: string;
  categoryId?: string | null;
  description?: string | null;
  price?: number;
  sampleType?: string | null;
  preparationText?: string | null;
  turnaroundMinutes?: number | null;
  active?: boolean;
};

const testRow = (input: TestInput) => ({
  code: input.code,
  name: input.name,
  category_id: input.categoryId,
  description: input.description,
  price: input.price,
  sample_type: input.sampleType,
  preparation_text: input.preparationText,
  turnaround_minutes: input.turnaroundMinutes,
  active: input.active,
});

export async function createTest(clinicId: string, actor: string, input: TestInput & { code: string; name: string; price: number }) {
  const db = createAdminClient();
  if (input.categoryId) await owned(db, "lab_categories", clinicId, input.categoryId);
  const { data, error } = await db.from("lab_tests").insert({ ...testRow(input), clinic_id: clinicId, updated_by: actor } as never).select("*").single();
  if (error) throw labCatalogError(error);
  return data;
}

export async function updateTest(clinicId: string, actor: string, id: string, input: TestInput) {
  const db = createAdminClient();
  await owned(db, "lab_tests", clinicId, id);
  if (input.categoryId) await owned(db, "lab_categories", clinicId, input.categoryId);
  const { data, error } = await db.from("lab_tests").update({ ...testRow(input), updated_by: actor }).eq("id", id).eq("clinic_id", clinicId).select("*").single();
  if (error) throw labCatalogError(error);
  return data;
}

// ---------- parameters and reference ranges ----------

type ParameterInput = { code?: string; name?: string; unit?: string | null; dataType?: "numeric" | "text" | "choice"; choices?: string[] | null; displayOrder?: number; active?: boolean };
const parameterRow = (i: ParameterInput) => ({ code: i.code, name: i.name, unit: i.unit, data_type: i.dataType, choices: i.choices, display_order: i.displayOrder, active: i.active });

export async function createParameter(clinicId: string, actor: string, input: ParameterInput & { testId: string; code: string; name: string }) {
  const db = createAdminClient();
  await owned(db, "lab_tests", clinicId, input.testId);
  const { data, error } = await db
    .from("lab_test_parameters")
    .insert({ ...parameterRow(input), clinic_id: clinicId, test_id: input.testId, updated_by: actor } as never)
    .select("*")
    .single();
  if (error) throw labCatalogError(error);
  return data;
}

export async function updateParameter(clinicId: string, actor: string, id: string, input: ParameterInput) {
  const db = createAdminClient();
  await owned(db, "lab_test_parameters", clinicId, id);
  const { data, error } = await db.from("lab_test_parameters").update({ ...parameterRow(input), updated_by: actor }).eq("id", id).eq("clinic_id", clinicId).select("*").single();
  if (error) throw labCatalogError(error);
  return data;
}

type RangeInput = { ageMinYears?: number | null; ageMaxYears?: number | null; low?: number | null; high?: number | null; criticalLow?: number | null; criticalHigh?: number | null; note?: string | null; active?: boolean };
const rangeRow = (i: RangeInput) => ({
  age_min_years: i.ageMinYears, age_max_years: i.ageMaxYears, low: i.low, high: i.high,
  critical_low: i.criticalLow, critical_high: i.criticalHigh, note: i.note, active: i.active,
});

export async function createRange(clinicId: string, actor: string, input: RangeInput & { parameterId: string }) {
  const db = createAdminClient();
  await owned(db, "lab_test_parameters", clinicId, input.parameterId);
  const { data, error } = await db
    .from("lab_reference_ranges")
    .insert({ ...rangeRow(input), clinic_id: clinicId, parameter_id: input.parameterId, updated_by: actor } as never)
    .select("*")
    .single();
  if (error) throw labCatalogError(error);
  return data;
}

export async function updateRange(clinicId: string, actor: string, id: string, input: RangeInput) {
  const db = createAdminClient();
  await owned(db, "lab_reference_ranges", clinicId, id);
  const { data, error } = await db.from("lab_reference_ranges").update({ ...rangeRow(input), updated_by: actor }).eq("id", id).eq("clinic_id", clinicId).select("*").single();
  if (error) throw labCatalogError(error);
  return data;
}

// ---------- panels ----------

export async function listPanels(clinicId: string, opts: { includeInactive: boolean }) {
  let query = createAdminClient().from("lab_panels").select("*, lab_panel_tests(test_id, sort_order)").eq("clinic_id", clinicId).order("name");
  if (!opts.includeInactive) query = query.eq("active", true);
  const { data, error } = await query;
  if (error) throw new ApiError(500, "Yuklab bo‘lmadi");
  return (data ?? []).map(({ lab_panel_tests, ...panel }) => ({
    ...panel,
    testIds: [...(lab_panel_tests ?? [])].sort((a, b) => a.sort_order - b.sort_order).map((t) => t.test_id),
  }));
}

type PanelInput = { code?: string; name?: string; description?: string | null; price?: number | null; active?: boolean; testIds?: string[] };
const panelRow = (i: PanelInput) => ({ code: i.code, name: i.name, description: i.description, price: i.price, active: i.active });

/** Maps the panel functions' refusals (all raised as "lab catalog: …") to API errors. */
async function callPanelFunction<T>(run: () => PromiseLike<{ data: T | null; error: { code?: string; message?: string } | null }>): Promise<T> {
  const { data, error } = await run();
  if (error) {
    if (error.message?.includes("is not in this clinic")) throw notFound();
    throw labCatalogError(error);
  }
  return data as T;
}

export async function createPanel(clinicId: string, actor: string, input: PanelInput & { code: string; name: string; testIds: string[] }) {
  const db = createAdminClient();
  // One transaction: the panel and its tests exist together or not at all.
  const id = await callPanelFunction<string>(() =>
    db.rpc("lab_create_panel", {
      p_clinic_id: clinicId,
      p_actor: actor,
      p_code: input.code,
      p_name: input.name,
      p_description: input.description ?? (null as never),
      p_price: input.price ?? (null as never),
      p_active: input.active ?? true,
      p_test_ids: input.testIds,
    }),
  );
  const { data, error } = await db.from("lab_panels").select("*").eq("id", id).eq("clinic_id", clinicId).single();
  if (error) throw labCatalogError(error);
  return { ...data, testIds: input.testIds };
}

export async function updatePanel(clinicId: string, actor: string, id: string, input: PanelInput) {
  const db = createAdminClient();
  await owned(db, "lab_panels", clinicId, id);
  // Tests first: if they are refused (another clinic's test, none at all) nothing about the panel changes.
  if (input.testIds) {
    await callPanelFunction(() => db.rpc("lab_set_panel_tests", { p_clinic_id: clinicId, p_panel_id: id, p_test_ids: input.testIds as string[] }));
  }
  const { data, error } = await db.from("lab_panels").update({ ...panelRow(input), updated_by: actor }).eq("id", id).eq("clinic_id", clinicId).select("*").single();
  if (error) throw labCatalogError(error);
  return { ...data, testIds: input.testIds };
}

// ---------- settings (app_settings key "lab") ----------

const SETTINGS_KEY = "lab";

export async function getLabSettings(clinicId: string): Promise<LabSettings> {
  const { data, error } = await createAdminClient().from("app_settings").select("value").eq("clinic_id", clinicId).eq("key", SETTINGS_KEY).maybeSingle();
  if (error) throw new ApiError(500, "Sozlamalarni yuklab bo‘lmadi");
  const parsed = labSettingsSchema.safeParse(data?.value);
  // A missing or malformed stored value falls back to the safe defaults — never to something looser.
  return parsed.success ? parsed.data : DEFAULT_LAB_SETTINGS;
}

export async function putLabSettings(clinicId: string, actor: string, settings: LabSettings): Promise<LabSettings> {
  const { error } = await createAdminClient()
    .from("app_settings")
    .upsert({ clinic_id: clinicId, key: SETTINGS_KEY, value: settings, updated_by: actor, updated_at: new Date().toISOString() }, { onConflict: "clinic_id,key" });
  if (error) throw labCatalogError(error, "Sozlamalarni saqlab bo‘lmadi");
  return settings;
}
