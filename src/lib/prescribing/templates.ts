import "server-only";
import type { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { logger } from "@/lib/logger";
import type { LinkedDoctor } from "@/lib/auth/guards";
import type { Json } from "@/lib/supabase/database.types";
import { templateItemSchema } from "@/lib/prescribing/schemas";

/**
 * Prescription templates (specification §9.3, step 4): a doctor's own saved
 * set of items, e.g. "Angina — kattalar". Never generated, never shared: every
 * read and write is the calling doctor's own rows. A template is only a
 * starting point — its items go through the same draft and signing checks as
 * anything typed by hand, and a medicine that has since left the catalogue or
 * become controlled is marked so it cannot be reused silently.
 */

export type TemplateItem = z.infer<typeof templateItemSchema>;

export type TemplateItemView = TemplateItem & {
  inn: string | null;
  tradeName: string | null;
  form: string | null;
  strength: string | null;
  rxOnly: boolean;
  /** Still in the catalogue this clinic sees, and not controlled. */
  available: boolean;
};

export type TemplateView = { id: string; name: string; updatedAt: string; items: TemplateItemView[] };

type DrugInfo = {
  id: string;
  owner_clinic_id: string | null;
  inn: string;
  trade_name: string | null;
  form: string | null;
  strength: string | null;
  rx_only: boolean;
  controlled: boolean;
  active: boolean;
};

async function drugsById(clinicId: string, ids: string[]): Promise<Map<string, DrugInfo>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await createAdminClient()
    .from("drug_catalog")
    .select("id, owner_clinic_id, inn, trade_name, form, strength, rx_only, controlled, active")
    .in("id", ids);
  if (error) {
    logger.error("template drugs load failed", { code: error.code });
    throw new ApiError(500, "Shablonlarni yuklab bo‘lmadi", "templates_load_failed");
  }
  // Another clinic's own entry is treated as not existing.
  return new Map(((data ?? []) as DrugInfo[]).filter((d) => d.owner_clinic_id === null || d.owner_clinic_id === clinicId).map((d) => [d.id, d]));
}

/** Stored items are re-parsed on the way out: a row that no longer fits the item shape is dropped, not trusted. */
function storedItems(value: Json): TemplateItem[] {
  if (!Array.isArray(value)) return [];
  const items: TemplateItem[] = [];
  for (const entry of value) {
    const parsed = templateItemSchema.safeParse(entry);
    if (parsed.success) items.push(parsed.data);
  }
  return items;
}

export async function listTemplates(doctor: LinkedDoctor): Promise<TemplateView[]> {
  const { data, error } = await createAdminClient()
    .from("prescription_templates")
    .select("id, name, items, updated_at")
    .eq("clinic_id", doctor.clinicId)
    .eq("doctor_id", doctor.doctorId)
    .order("name")
    .limit(100);
  if (error) {
    logger.error("templates load failed", { code: error.code });
    throw new ApiError(500, "Shablonlarni yuklab bo‘lmadi", "templates_load_failed");
  }
  const rows = (data ?? []).map((row) => ({ ...row, parsed: storedItems(row.items) }));
  const drugs = await drugsById(doctor.clinicId, [...new Set(rows.flatMap((r) => r.parsed.map((i) => i.drugId)))]);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    updatedAt: row.updated_at,
    items: row.parsed.map((item) => {
      const drug = drugs.get(item.drugId);
      return {
        ...item,
        inn: drug?.inn ?? null,
        tradeName: drug?.trade_name ?? null,
        form: drug?.form ?? null,
        strength: drug?.strength ?? null,
        rxOnly: drug?.rx_only ?? false,
        available: !!drug && drug.active && !drug.controlled,
      };
    }),
  }));
}

/** Saves the doctor's current items under a name; an existing template of that name is replaced. */
export async function saveTemplate(doctor: LinkedDoctor, name: string, items: TemplateItem[]): Promise<{ id: string }> {
  const drugs = await drugsById(doctor.clinicId, [...new Set(items.map((i) => i.drugId))]);
  for (const item of items) {
    const drug = drugs.get(item.drugId);
    if (!drug || !drug.active) throw new ApiError(404, "Shablondagi dori ro‘yxatda topilmadi", "drug_not_found");
    if (drug.controlled) throw new ApiError(409, "Nazoratdagi dori shablonga qo‘shilmaydi", "controlled_not_allowed");
  }

  const db = createAdminClient();
  const { data: existing, error: findError } = await db
    .from("prescription_templates")
    .select("id")
    .eq("clinic_id", doctor.clinicId)
    .eq("doctor_id", doctor.doctorId)
    .ilike("name", name.replace(/[\\%_]/g, "\\$&"))
    .maybeSingle();
  if (findError) throw new ApiError(500, "Shablonni tekshirib bo‘lmadi", "template_check_failed");

  const stored = items as unknown as Json;
  if (existing) {
    const { error } = await db
      .from("prescription_templates")
      .update({ name, items: stored })
      .eq("id", existing.id)
      .eq("clinic_id", doctor.clinicId)
      .eq("doctor_id", doctor.doctorId);
    if (error) {
      logger.error("template update failed", { code: error.code });
      throw new ApiError(500, "Shablonni saqlab bo‘lmadi", "template_write_failed");
    }
    return { id: existing.id };
  }

  const { data, error } = await db
    .from("prescription_templates")
    .insert({ clinic_id: doctor.clinicId, doctor_id: doctor.doctorId, name, items: stored, created_by: doctor.profileId })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") throw new ApiError(409, "Bu nomli shablon allaqachon bor", "template_exists");
    logger.error("template create failed", { code: error.code });
    throw new ApiError(500, "Shablonni saqlab bo‘lmadi", "template_write_failed");
  }
  return { id: data.id };
}

export async function deleteTemplate(doctor: LinkedDoctor, templateId: string): Promise<void> {
  const { data, error } = await createAdminClient()
    .from("prescription_templates")
    .delete()
    .eq("id", templateId)
    .eq("clinic_id", doctor.clinicId)
    .eq("doctor_id", doctor.doctorId)
    .select("id");
  if (error) {
    logger.error("template delete failed", { code: error.code });
    throw new ApiError(500, "Shablonni o‘chirib bo‘lmadi", "template_write_failed");
  }
  if (!data || data.length === 0) throw new ApiError(404, "Shablon topilmadi", "template_not_found");
}
