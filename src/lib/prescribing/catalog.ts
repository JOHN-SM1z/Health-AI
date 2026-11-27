import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/lib/audit";
import type { LinkedDoctor } from "@/lib/auth/guards";
import type { StaffContext } from "@/lib/auth/staff";
import type { Database } from "@/lib/supabase/database.types";

/**
 * The drug catalogue, the clinic formulary and the ICD-10 catalogue
 * (specification RX-01, RX-02, DW-02). Reference data only — no patient is
 * involved here. Search runs in the database (search_drug_catalog,
 * search_icd10): prefix and trigram match over INN, trade names and aliases in
 * Latin or Cyrillic, the clinic's formulary and the doctor's own recent
 * choices first. Nothing is generated or suggested by a model.
 */

export type DrugResult = {
  id: string;
  inn: string;
  innLatin: string | null;
  tradeName: string | null;
  form: string | null;
  strength: string | null;
  manufacturer: string | null;
  /** Prescription-only: the legal prescription is the national Elektron retsept record. */
  rxOnly: boolean;
  /** Controlled: cannot be put on a Health AI prescription at all. */
  controlled: boolean;
  /** The clinic's own entry rather than the shared catalogue. */
  clinicOwned: boolean;
  inFormulary: boolean;
  /** The doctor prescribed it in the last six months. */
  recent: boolean;
  match: "prefix" | "similar";
  source: string;
  sourceVersion: string;
};

type DrugSearchRow = Database["public"]["Functions"]["search_drug_catalog"]["Returns"][number];

const toDrugResult = (row: DrugSearchRow): DrugResult => ({
  id: row.id,
  inn: row.inn,
  innLatin: row.inn_latin,
  tradeName: row.trade_name,
  form: row.form,
  strength: row.strength,
  manufacturer: row.manufacturer,
  rxOnly: row.rx_only,
  controlled: row.controlled,
  clinicOwned: row.clinic_owned,
  inFormulary: row.in_formulary,
  recent: row.recent,
  match: row.match === "similar" ? "similar" : "prefix",
  source: row.source,
  sourceVersion: row.source_version,
});

export async function searchDrugs(doctor: LinkedDoctor, query: string): Promise<DrugResult[]> {
  const { data, error } = await createAdminClient().rpc("search_drug_catalog", {
    p_clinic_id: doctor.clinicId,
    p_doctor_id: doctor.doctorId,
    p_query: query,
    p_limit: 20,
  });
  if (error) {
    logger.error("drug search failed", { code: error.code });
    throw new ApiError(503, "Dorilar ro‘yxatini qidirib bo‘lmadi, qo‘lda yozishda davom eting", "drug_search_failed");
  }
  return (data ?? []).map(toDrugResult);
}

/** No doctor: the search is used by a manager building the formulary, so nobody's recent choices apply. */
const NO_DOCTOR = "00000000-0000-0000-0000-000000000000";

/** The same search for the owner or administrator who maintains the clinic's formulary. */
export async function searchCatalogueForFormulary(clinicId: string, query: string): Promise<DrugResult[]> {
  const { data, error } = await createAdminClient().rpc("search_drug_catalog", {
    p_clinic_id: clinicId,
    p_doctor_id: NO_DOCTOR,
    p_query: query,
    p_limit: 20,
  });
  if (error) {
    logger.error("formulary catalogue search failed", { code: error.code });
    throw new ApiError(503, "Dorilar ro‘yxatini qidirib bo‘lmadi", "drug_search_failed");
  }
  return (data ?? []).map(toDrugResult);
}

export type Icd10Result = { code: string; nameUz: string | null; nameRu: string | null };

export async function searchIcd10(query: string): Promise<Icd10Result[]> {
  const { data, error } = await createAdminClient().rpc("search_icd10", { p_query: query, p_limit: 20 });
  if (error) {
    logger.error("icd10 search failed", { code: error.code });
    throw new ApiError(503, "Tashxis kodlarini qidirib bo‘lmadi", "icd10_search_failed");
  }
  return (data ?? []).map((row) => ({ code: row.code, nameUz: row.name_uz, nameRu: row.name_ru }));
}

/**
 * Whether `code` is a diagnosis code the doctor may record: an active entry
 * of the ICD-10 catalogue. Until a catalogue is loaded there is nothing to
 * check against, and the code is accepted as typed (the behaviour before the
 * catalogue existed).
 */
export async function isAcceptableDiagnosisCode(code: string): Promise<boolean> {
  const db = createAdminClient();
  const normalized = code.trim().toUpperCase();
  const { data, error } = await db.from("icd10_codes").select("code, active").eq("code", normalized).maybeSingle();
  if (error) throw new ApiError(503, "Tashxis kodini tekshirib bo‘lmadi", "icd10_check_failed");
  if (data) return data.active;
  const { count, error: countError } = await db.from("icd10_codes").select("code", { count: "exact", head: true }).eq("active", true);
  if (countError) throw new ApiError(503, "Tashxis kodini tekshirib bo‘lmadi", "icd10_check_failed");
  return (count ?? 0) === 0;
}

export type CatalogueStatus = {
  /** The shared catalogue's sources, newest import first — shown in the screen footer (RX-02). */
  sources: Array<{ source: string; version: string; importedAt: string }>;
  /** Entries the clinic keeps itself. */
  clinicEntries: number;
  /** Whether an ICD-10 catalogue is loaded (otherwise the code is typed by hand). */
  icd10: { source: string; version: string } | null;
};

export async function catalogueStatus(clinicId: string): Promise<CatalogueStatus> {
  const db = createAdminClient();
  const [imports, own] = await Promise.all([
    db
      .from("reference_data_imports")
      .select("dataset, source, source_version, imported_at")
      .order("imported_at", { ascending: false })
      .limit(50),
    db.from("drug_catalog").select("id", { count: "exact", head: true }).eq("owner_clinic_id", clinicId).eq("active", true),
  ]);
  if (imports.error || own.error) {
    logger.error("catalogue status failed", { code: imports.error?.code ?? own.error?.code });
    throw new ApiError(503, "Dorilar ro‘yxati holatini yuklab bo‘lmadi", "catalogue_status_failed");
  }
  const seen = new Set<string>();
  const sources: CatalogueStatus["sources"] = [];
  let icd10: CatalogueStatus["icd10"] = null;
  for (const row of imports.data ?? []) {
    if (row.dataset === "icd10") {
      icd10 ??= { source: row.source, version: row.source_version };
    } else if (!seen.has(row.source)) {
      // The newest import of each source is the version in use.
      seen.add(row.source);
      sources.push({ source: row.source, version: row.source_version, importedAt: row.imported_at });
    }
  }
  return { sources, clinicEntries: own.count ?? 0, icd10 };
}

// ---------------------------------------------------------------------------
// Clinic formulary (owner / administrator)
// ---------------------------------------------------------------------------

type ClinicStaff = StaffContext & { clinicId: string };

export type FormularyEntry = {
  drugId: string;
  inn: string;
  innLatin: string | null;
  tradeName: string | null;
  form: string | null;
  strength: string | null;
  manufacturer: string | null;
  drugClass: string | null;
  aliases: string[];
  rxOnly: boolean;
  controlled: boolean;
  clinicOwned: boolean;
  /** The catalogue entry itself is still available. */
  drugActive: boolean;
  inFormulary: boolean;
  formularyActive: boolean;
  sortOrder: number;
  source: string;
  sourceVersion: string;
};

type DrugRow = {
  id: string;
  owner_clinic_id: string | null;
  inn: string;
  inn_latin: string | null;
  trade_name: string | null;
  form: string | null;
  strength: string | null;
  manufacturer: string | null;
  drug_class: string | null;
  aliases: string[];
  rx_only: boolean;
  controlled: boolean;
  active: boolean;
  source: string;
  source_version: string;
};

const DRUG_COLUMNS =
  "id, owner_clinic_id, inn, inn_latin, trade_name, form, strength, manufacturer, drug_class, aliases, rx_only, controlled, active, source, source_version";

const toEntry = (drug: DrugRow, formulary?: { sort_order: number; active: boolean }): FormularyEntry => ({
  drugId: drug.id,
  inn: drug.inn,
  innLatin: drug.inn_latin,
  tradeName: drug.trade_name,
  form: drug.form,
  strength: drug.strength,
  manufacturer: drug.manufacturer,
  drugClass: drug.drug_class,
  aliases: drug.aliases,
  rxOnly: drug.rx_only,
  controlled: drug.controlled,
  clinicOwned: drug.owner_clinic_id !== null,
  drugActive: drug.active,
  inFormulary: !!formulary,
  formularyActive: formulary?.active ?? false,
  sortOrder: formulary?.sort_order ?? 0,
  source: drug.source,
  sourceVersion: drug.source_version,
});

/** The clinic's formulary and every entry the clinic keeps itself, in formulary order. */
export async function listFormulary(clinicId: string): Promise<FormularyEntry[]> {
  const db = createAdminClient();
  const [formulary, own] = await Promise.all([
    db
      .from("clinic_formulary")
      .select(`sort_order, active, drug:drug_catalog!clinic_formulary_drug_id_fkey(${DRUG_COLUMNS})`)
      .eq("clinic_id", clinicId)
      .order("sort_order")
      .limit(2000),
    db.from("drug_catalog").select(DRUG_COLUMNS).eq("owner_clinic_id", clinicId).order("inn").limit(2000),
  ]);
  if (formulary.error || own.error) {
    logger.error("formulary load failed", { code: formulary.error?.code ?? own.error?.code });
    throw new ApiError(500, "Klinika dorilar ro‘yxatini yuklab bo‘lmadi", "formulary_load_failed");
  }
  const rows = (formulary.data ?? []) as unknown as Array<{ sort_order: number; active: boolean; drug: DrugRow | null }>;
  const listed = new Set<string>();
  const entries: FormularyEntry[] = [];
  for (const row of rows) {
    if (!row.drug) continue;
    listed.add(row.drug.id);
    entries.push(toEntry(row.drug, row));
  }
  for (const drug of (own.data ?? []) as DrugRow[]) {
    if (!listed.has(drug.id)) entries.push(toEntry(drug));
  }
  return entries;
}

export type ClinicDrugInput = {
  inn: string;
  innLatin?: string;
  tradeName?: string;
  form?: string;
  strength?: string;
  manufacturer?: string;
  drugClass?: string;
  aliases: string[];
  rxOnly: boolean;
  controlled: boolean;
  sortOrder: number;
};

/** A medicine the clinic keeps itself (RX-02, the stop-gap source), added to its formulary. */
export async function createClinicDrug(staff: ClinicStaff, input: ClinicDrugInput): Promise<{ drugId: string }> {
  const db = createAdminClient();
  const { data, error } = await db
    .from("drug_catalog")
    .insert({
      owner_clinic_id: staff.clinicId,
      inn: input.inn,
      inn_latin: input.innLatin ?? null,
      trade_name: input.tradeName ?? null,
      form: input.form ?? null,
      strength: input.strength ?? null,
      manufacturer: input.manufacturer ?? null,
      drug_class: input.drugClass ?? null,
      aliases: input.aliases,
      rx_only: input.rxOnly,
      controlled: input.controlled,
      source: "clinic_formulary",
      // The day the clinic recorded it: the "version" shown next to the source.
      source_version: new Date().toISOString().slice(0, 10),
      created_by: staff.profileId,
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") throw new ApiError(409, "Bu dori klinika ro‘yxatida allaqachon bor", "drug_exists");
    if (error.code === "23514") throw new ApiError(400, "Dori ma‘lumotlari noto‘g‘ri", "validation");
    logger.error("clinic drug create failed", { code: error.code });
    throw new ApiError(500, "Dorini saqlab bo‘lmadi", "drug_create_failed");
  }
  await addToFormulary(staff, data.id, input.sortOrder, false);
  await recordAudit({
    clinicId: staff.clinicId,
    action: "clinic_drug_created",
    entityType: "drug_catalog",
    entityId: data.id,
    actor: { actorId: staff.profileId, actorType: "staff" },
    newValues: { rx_only: input.rxOnly, controlled: input.controlled },
  });
  return { drugId: data.id };
}

/** Puts a medicine of the shared catalogue, or one of the clinic's own, on the clinic's formulary. */
export async function addToFormulary(staff: ClinicStaff, drugId: string, sortOrder: number, audit = true): Promise<void> {
  const db = createAdminClient();
  const { data: drug, error: drugError } = await db.from("drug_catalog").select("id, owner_clinic_id, active").eq("id", drugId).maybeSingle();
  if (drugError) throw new ApiError(500, "Dorini tekshirib bo‘lmadi", "drug_check_failed");
  // Another clinic's entry is simply not found.
  if (!drug || (drug.owner_clinic_id !== null && drug.owner_clinic_id !== staff.clinicId)) throw new ApiError(404, "Dori topilmadi", "drug_not_found");
  if (!drug.active) throw new ApiError(409, "Bu dori ro‘yxatdan chiqarilgan", "drug_inactive");

  const { error } = await db
    .from("clinic_formulary")
    .upsert({ clinic_id: staff.clinicId, drug_id: drugId, sort_order: sortOrder, active: true, added_by: staff.profileId }, { onConflict: "clinic_id,drug_id" });
  if (error) {
    logger.error("formulary add failed", { code: error.code });
    throw new ApiError(500, "Dorini klinika ro‘yxatiga qo‘shib bo‘lmadi", "formulary_add_failed");
  }
  if (audit) {
    await recordAudit({
      clinicId: staff.clinicId,
      action: "formulary_entry_added",
      entityType: "clinic_formulary",
      entityId: drugId,
      actor: { actorId: staff.profileId, actorType: "staff" },
    });
  }
}

export async function updateFormularyEntry(staff: ClinicStaff, drugId: string, patch: { sortOrder?: number; active?: boolean }): Promise<void> {
  const { data, error } = await createAdminClient()
    .from("clinic_formulary")
    .update({
      ...(patch.sortOrder !== undefined ? { sort_order: patch.sortOrder } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
    })
    .eq("clinic_id", staff.clinicId)
    .eq("drug_id", drugId)
    .select("drug_id");
  if (error) {
    logger.error("formulary update failed", { code: error.code });
    throw new ApiError(500, "O‘zgarishni saqlab bo‘lmadi", "formulary_update_failed");
  }
  if (!data || data.length === 0) throw new ApiError(404, "Dori klinika ro‘yxatida topilmadi", "formulary_entry_not_found");
  await recordAudit({
    clinicId: staff.clinicId,
    action: "formulary_entry_updated",
    entityType: "clinic_formulary",
    entityId: drugId,
    actor: { actorId: staff.profileId, actorType: "staff" },
    newValues: { sort_order: patch.sortOrder ?? null, active: patch.active ?? null },
  });
}

/**
 * Takes a medicine off the clinic's formulary. The clinic's own entry is also
 * retired (never deleted: signed prescriptions keep pointing at it), so it no
 * longer appears in search.
 */
export async function removeFromFormulary(staff: ClinicStaff, drugId: string): Promise<void> {
  const db = createAdminClient();
  const { data: drug, error: drugError } = await db.from("drug_catalog").select("id, owner_clinic_id").eq("id", drugId).maybeSingle();
  if (drugError) throw new ApiError(500, "Dorini tekshirib bo‘lmadi", "drug_check_failed");
  if (!drug || (drug.owner_clinic_id !== null && drug.owner_clinic_id !== staff.clinicId)) throw new ApiError(404, "Dori topilmadi", "drug_not_found");

  const { error } = await db.from("clinic_formulary").delete().eq("clinic_id", staff.clinicId).eq("drug_id", drugId);
  if (error) {
    logger.error("formulary remove failed", { code: error.code });
    throw new ApiError(500, "Dorini ro‘yxatdan olib bo‘lmadi", "formulary_remove_failed");
  }
  if (drug.owner_clinic_id === staff.clinicId) {
    const { error: retireError } = await db.from("drug_catalog").update({ active: false }).eq("id", drugId).eq("owner_clinic_id", staff.clinicId);
    if (retireError) {
      logger.error("clinic drug retire failed", { code: retireError.code });
      throw new ApiError(500, "Dorini ro‘yxatdan chiqarib bo‘lmadi", "drug_retire_failed");
    }
  }
  await recordAudit({
    clinicId: staff.clinicId,
    action: "formulary_entry_removed",
    entityType: "clinic_formulary",
    entityId: drugId,
    actor: { actorId: staff.profileId, actorType: "staff" },
    newValues: { clinic_entry_retired: drug.owner_clinic_id === staff.clinicId },
  });
}
