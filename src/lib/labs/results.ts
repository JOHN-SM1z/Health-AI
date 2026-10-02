import "server-only";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { uuidSchema } from "@/lib/api/validate";
import { recordAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Laboratory result entry, verification and correction (phase 6), for laboratory staff of the clinic.
 *
 * Every step is one database function (supabase/migrations/20261003000007) that locks what it changes; this
 * module authorises nothing by itself (the routes require `lab_staff`), scopes every read by the session's
 * clinic, validates the SHAPE of what was typed against the configured parameters, and shapes what comes back.
 *
 * What is never taken from a request: the clinic, the author, the verifier, the reference bounds, the flag, the
 * status. The database computes the flag from the configured range; a flag is a comparison with that range
 * ("outside the configured reference range") — never an interpretation, never a diagnosis.
 *
 * Doctors, reception and management have no route here: results are clinical, and a doctor who reads one (phase 7)
 * cannot change it — a different interpretation is the doctor's own clinical record.
 */

type Flag = Database["public"]["Enums"]["lab_flag"];
export type ResultState = "none" | "draft" | "pending_verification" | "verified";

type Staff = { clinicId: string; profileId: string };
const notFound = () => new ApiError(404, "Topilmadi", "lab_not_found");

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function resultError(error: { code?: string; message?: string }): ApiError {
  const m = error.message ?? "";
  if (m.includes("sample has not been collected")) return new ApiError(409, "Namuna hali olinmagan", "sample_not_collected");
  if (m.includes("already verified by another")) return new ApiError(409, "Natija boshqa xodim tomonidan tasdiqlangan", "already_verified");
  if (m.includes("already verified; start a correction")) return new ApiError(409, "Natija tasdiqlangan — o‘zgartirish uchun tuzatish kiriting", "already_verified");
  if (m.includes("awaiting verification")) return new ApiError(409, "Natija tasdiq kutmoqda — avval qoralamaga qaytaring", "awaiting_verification");
  if (m.includes("not orphaned")) return new ApiError(409, "Qoralama egasi hali faol — uni olib bo‘lmaydi", "not_orphaned");
  if (m.includes("only the holder abandons")) return new ApiError(403, "Faol xodimning qoralamasini faqat o‘zi bekor qiladi", "not_holder");
  if (m.includes("abandonment needs a reason")) return new ApiError(400, "Bekor qilish sababini yozing", "validation");
  if (m.includes("only a draft is")) return new ApiError(409, "Faqat qoralama bilan bu amalni bajarish mumkin", "invalid_transition");
  if (m.includes("belongs to another") || m.includes("only the author")) return new ApiError(403, "Bu qoralama boshqa xodimniki", "not_author");
  if (m.includes("verifier must be a different person")) return new ApiError(403, "Tasdiqlovchi natijani kiritgan xodimdan boshqa bo‘lishi kerak", "separate_verifier_required");
  if (m.includes("every active parameter")) return new ApiError(400, "Barcha ko‘rsatkichlar uchun qiymat kiriting", "incomplete");
  if (m.includes("stale version")) return new ApiError(409, "Natija boshqa xodim tomonidan o‘zgartirilgan, sahifani yangilang", "stale_version");
  if (m.includes("correction is already in progress")) return new ApiError(409, "Tuzatish allaqachon boshlangan", "correction_in_progress");
  if (m.includes("only a verified result is corrected")) return new ApiError(409, "Faqat tasdiqlangan natija tuzatiladi", "not_verified");
  if (m.includes("needs a reason")) return new ApiError(400, "Tuzatish sababini yozing", "validation");
  if (m.includes("only a submitted version")) return new ApiError(409, "Natijaning joriy holatida bu amalni bajarib bo‘lmaydi", "invalid_transition");
  if (m.includes("invalid version transition")) return new ApiError(409, "Natijaning joriy holatida bu amalni bajarib bo‘lmaydi", "invalid_transition");
  if (m.includes("order or the test is cancelled") || m.includes("no result for an order that is") || m.includes("no result for a cancelled test"))
    return new ApiError(409, "Buyurtma yoki tahlil bekor qilingan", "order_closed");
  if (m.includes("only lab staff")) return new ApiError(403, "Bu amal uchun ruxsat yo‘q", "forbidden");
  if (m.includes("not found")) return notFound();
  if (m.includes("lab_result_values_version_parameter_key")) return new ApiError(400, "Bir ko‘rsatkich ikki marta kiritilgan", "validation");
  if (m.includes("lab_result_versions_one_open")) return new ApiError(409, "Bu natija ustida boshqa qoralama bor", "correction_in_progress");
  if (m.startsWith("lab result:") || error.code === "22P02" || error.code === "23514") return new ApiError(400, "Kiritilgan qiymatlar noto‘g‘ri", "validation");
  logger.error("lab result step failed", { code: error.code });
  return new ApiError(500, "Amalni bajarib bo‘lmadi", "lab_result_failed");
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export type ResultListItem = {
  itemId: string;
  orderId: string;
  createdAt: string;
  priority: string;
  patientName: string | null;
  testCode: string;
  testName: string;
  state: ResultState;
  /** The sample of this test is collected (or processing): a result can be entered. */
  sampleCollected: boolean;
  /** Who holds the open draft / the submitted result (the author, or whoever took an orphaned draft over). */
  enteredBy: string | null;
  /** The open draft's holder is no longer an active laboratory user: another member of staff may take it over. */
  orphaned: boolean;
};

export type ResultListFilter = "todo" | "review" | "verified" | "all";

export async function listResultItems(staff: Staff, filter: ResultListFilter, limit = 300): Promise<ResultListItem[]> {
  const db = createAdminClient();
  const { data, error } = await db
    .from("lab_order_items")
    .select(
      "id, order_id, test_code, test_name, created_at, lab_orders!inner(status, priority, patients(full_name)), lab_sample_items(lab_samples(status)), lab_results(status, lab_result_versions(id, version, status, working_by))",
    )
    .eq("clinic_id", staff.clinicId)
    .eq("status", "active")
    .in("lab_orders.status", ["ordered", "in_progress", "completed"])
    .order("created_at", { ascending: false })
    .limit(Math.min(limit, 500));
  if (error) {
    logger.error("result list failed", { code: error.code });
    throw new ApiError(500, "Natijalar ro‘yxatini yuklab bo‘lmadi");
  }
  type Row = {
    id: string;
    order_id: string;
    test_code: string;
    test_name: string;
    created_at: string;
    lab_orders: { status: string; priority: string; patients: { full_name: string | null } | null };
    lab_sample_items: Array<{ lab_samples: { status: string } | null }>;
    lab_results: Array<{ status: ResultState; lab_result_versions: Array<{ id: string; version: number; status: string; working_by: string }> }>;
  };
  const rows = (data ?? []) as unknown as Row[];
  const authors = [...new Set(rows.flatMap((r) => r.lab_results.flatMap((x) => x.lab_result_versions.filter((v) => v.status === "draft" || v.status === "pending_verification").map((v) => v.working_by))))];
  const names = new Map<string, string | null>();
  if (authors.length) {
    const { data: profiles } = await db.from("profiles").select("id, full_name").in("id", authors);
    for (const p of profiles ?? []) names.set(p.id, p.full_name);
  }

  const { data: orphanRows } = await db.rpc("lab_orphaned_drafts", { p_clinic: staff.clinicId });
  const orphaned = new Set((orphanRows ?? []).map((o) => o.version_id));

  const items = rows.map((r): ResultListItem => {
    const result = r.lab_results[0];
    const open = result?.lab_result_versions.find((v) => v.status === "draft" || v.status === "pending_verification");
    // The state comes from the versions: an abandoned draft is not a result, and a standing verified version is.
    const state: ResultState = open ? (open.status as ResultState) : result?.lab_result_versions.some((v) => v.status === "verified") ? "verified" : "none";
    return {
      itemId: r.id,
      orderId: r.order_id,
      createdAt: r.created_at,
      priority: r.lab_orders.priority,
      patientName: r.lab_orders.patients?.full_name ?? null,
      testCode: r.test_code,
      testName: r.test_name,
      state,
      sampleCollected: r.lab_sample_items.some((s) => s.lab_samples && ["collected", "processing"].includes(s.lab_samples.status)),
      enteredBy: open ? names.get(open.working_by) ?? null : null,
      orphaned: !!open && orphaned.has(open.id),
    };
  });
  const wanted = items.filter((i) => {
    if (filter === "todo") return (i.state === "none" && i.sampleCollected) || i.state === "draft";
    if (filter === "review") return i.state === "pending_verification";
    if (filter === "verified") return i.state === "verified";
    return i.sampleCollected || i.state !== "none";
  });
  return wanted.sort((a, b) => Number(b.priority === "urgent") - Number(a.priority === "urgent") || a.createdAt.localeCompare(b.createdAt));
}

// ---------------------------------------------------------------------------
// The detail
// ---------------------------------------------------------------------------

export type ParameterView = {
  id: string;
  code: string;
  name: string;
  unit: string | null;
  dataType: "numeric" | "text" | "choice";
  choices: string[] | null;
  /** The generic configured range, shown beside the field while typing; null when none (or several) is configured. */
  range: { low: number | null; high: number | null; criticalLow: number | null; criticalHigh: number | null } | null;
};

export type ValueView = {
  parameterId: string;
  code: string;
  name: string;
  unit: string | null;
  value: string | number;
  /** "<", "<=", ">" or ">=" when the value is a bound ("<0.5"): such a value is never compared with the range. */
  comparator: string | null;
  /** A comparison with the configured range — not an interpretation. */
  flag: Flag;
  refLow: number | null;
  refHigh: number | null;
  criticalLow: number | null;
  criticalHigh: number | null;
};

export type VersionView = {
  id: string;
  version: number;
  status: "draft" | "pending_verification" | "verified" | "superseded" | "cancelled";
  enteredBy: { id: string; name: string | null };
  enteredAt: string;
  verifiedBy: { id: string; name: string | null } | null;
  verifiedAt: string | null;
  correctsVersion: number | null;
  correctionReason: string | null;
  /** Who holds the version now (the author until a draft is taken over). */
  heldBy: { id: string; name: string | null };
  cancelledBy: { id: string; name: string | null } | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
};

export type DraftEvent = { kind: "takeover" | "abandon"; at: string; by: { id: string; name: string | null }; from: { id: string; name: string | null } | null; reason: string | null; version: number };

export type ResultDetail = {
  item: { id: string; orderId: string; testCode: string; testName: string; patientName: string | null };
  parameters: ParameterView[];
  settings: { verificationRequired: boolean; separateVerifier: boolean };
  /** The draft/awaiting-verification version being worked on, if any. */
  working: (VersionView & { values: ValueView[]; mine: boolean; orphaned: boolean; canSubmit: boolean; canVerify: boolean; canReturn: boolean; canTakeOver: boolean; canAbandon: boolean }) | null;
  /** The current verified version, if any (kept and shown while a correction is being prepared). */
  verified: (VersionView & { values: ValueView[] }) | null;
  history: VersionView[];
  /** Takeovers and abandonments of drafts, oldest first. */
  events: DraftEvent[];
  canCorrect: boolean;
  canEnter: boolean;
  /** Documents attached to this result (work in progress included) - for laboratory staff. */
  documents: Array<{ id: string; kind: string; contentType: string; sizeBytes: number; addedAt: string; uploadedBy: string | null }>;
  /** A document can be added while the result is in work or under correction; a finalised one needs a correction first. */
  canAttach: boolean;
};

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** Everything the result screen needs for one ordered test. Opening it is audited (ids only). */
export async function getResultDetail(staff: Staff, itemId: string): Promise<ResultDetail> {
  const db = createAdminClient();
  const { data: item } = await db
    .from("lab_order_items")
    .select("id, order_id, test_id, test_code, test_name, status, lab_orders!inner(status, patient_id, patients(full_name)), lab_sample_items(lab_samples(status))")
    .eq("id", itemId)
    .eq("clinic_id", staff.clinicId)
    .maybeSingle();
  if (!item) throw notFound();
  const order = item.lab_orders as unknown as { status: string; patient_id: string; patients: { full_name: string | null } | null };
  const sampleCollected = (item.lab_sample_items as unknown as Array<{ lab_samples: { status: string } | null }>).some(
    (s) => s.lab_samples && ["collected", "processing"].includes(s.lab_samples.status),
  );

  const [{ data: params }, { data: ranges }, { data: resultRow }, settings] = await Promise.all([
    db.from("lab_test_parameters").select("id, code, name, unit, data_type, choices, display_order").eq("clinic_id", staff.clinicId).eq("test_id", item.test_id).eq("active", true).order("display_order").order("code"),
    db
      .from("lab_reference_ranges")
      .select("parameter_id, low, high, critical_low, critical_high, age_min_years, age_max_years")
      .eq("clinic_id", staff.clinicId)
      .eq("active", true)
      .is("age_min_years", null)
      .is("age_max_years", null),
    db.from("lab_results").select("id").eq("clinic_id", staff.clinicId).eq("order_item_id", itemId).maybeSingle(),
    readSettings(staff.clinicId),
  ]);

  const rangeCount = new Map<string, number>();
  for (const r of ranges ?? []) rangeCount.set(r.parameter_id, (rangeCount.get(r.parameter_id) ?? 0) + 1);
  const parameters: ParameterView[] = (params ?? []).map((p) => {
    const r = rangeCount.get(p.id) === 1 ? (ranges ?? []).find((x) => x.parameter_id === p.id) : undefined;
    return {
      id: p.id,
      code: p.code,
      name: p.name,
      unit: p.unit,
      dataType: p.data_type,
      choices: p.choices,
      range: r ? { low: num(r.low), high: num(r.high), criticalLow: num(r.critical_low), criticalHigh: num(r.critical_high) } : null,
    };
  });

  let versions: Array<Database["public"]["Tables"]["lab_result_versions"]["Row"]> = [];
  let values: Array<Database["public"]["Tables"]["lab_result_values"]["Row"]> = [];
  if (resultRow) {
    const { data: vs } = await db.from("lab_result_versions").select("*").eq("clinic_id", staff.clinicId).eq("result_id", resultRow.id).order("version");
    versions = vs ?? [];
    if (versions.length) {
      const { data: vals } = await db.from("lab_result_values").select("*").eq("clinic_id", staff.clinicId).in("version_id", versions.map((v) => v.id));
      values = vals ?? [];
    }
  }
  let attachments: Array<{ id: string; kind: string; content_type: string; size_bytes: number; created_at: string; uploaded_by: string }> = [];
  if (resultRow) {
    const { data: att } = await db.from("lab_result_attachments").select("id, kind, content_type, size_bytes, created_at, uploaded_by").eq("clinic_id", staff.clinicId).eq("result_id", resultRow.id).order("created_at");
    attachments = (att ?? []) as typeof attachments;
  }
  let events: Array<Database["public"]["Tables"]["lab_result_version_events"]["Row"]> = [];
  if (versions.length) {
    const { data: ev } = await db.from("lab_result_version_events").select("*").eq("clinic_id", staff.clinicId).in("version_id", versions.map((v) => v.id)).order("created_at");
    events = ev ?? [];
  }
  const people = [...new Set([...versions.flatMap((v) => [v.entered_by, v.working_by, v.verified_by, v.cancelled_by].filter((x): x is string => !!x)), ...events.flatMap((e) => [e.actor_id, e.previous_holder].filter((x): x is string => !!x)), ...attachments.map((a) => a.uploaded_by)])];
  const names = new Map<string, string | null>();
  if (people.length) {
    const { data: profiles } = await db.from("profiles").select("id, full_name").in("id", people);
    for (const p of profiles ?? []) names.set(p.id, p.full_name);
  }
  const who = (id: string) => ({ id, name: names.get(id) ?? null });
  const versionNumber = new Map(versions.map((v) => [v.id, v.version]));
  const toVersion = (v: (typeof versions)[number]): VersionView => ({
    id: v.id,
    version: v.version,
    status: v.status,
    enteredBy: who(v.entered_by),
    enteredAt: v.entered_at,
    verifiedBy: v.verified_by ? who(v.verified_by) : null,
    verifiedAt: v.verified_at,
    correctsVersion: v.corrects_version_id ? versionNumber.get(v.corrects_version_id) ?? null : null,
    correctionReason: v.correction_reason,
    heldBy: who(v.working_by),
    cancelledBy: v.cancelled_by ? who(v.cancelled_by) : null,
    cancelledAt: v.cancelled_at,
    cancellationReason: v.cancellation_reason,
  });
  const valuesOf = (versionId: string): ValueView[] =>
    values
      .filter((x) => x.version_id === versionId)
      .map((x) => ({
        parameterId: x.parameter_id,
        code: x.parameter_code,
        name: x.parameter_name,
        unit: x.unit,
        value: x.value_numeric !== null ? Number(x.value_numeric) : x.value_text ?? "",
        comparator: x.comparator,
        flag: x.flag,
        refLow: num(x.ref_low),
        refHigh: num(x.ref_high),
        criticalLow: num(x.critical_low),
        criticalHigh: num(x.critical_high),
      }))
      .sort((a, b) => parameters.findIndex((p) => p.id === a.parameterId) - parameters.findIndex((p) => p.id === b.parameterId));

  const open = versions.find((v) => v.status === "draft" || v.status === "pending_verification");
  const verified = versions.find((v) => v.status === "verified");
  const closed = order.status === "cancelled" || item.status !== "active";
  const mine = !!open && open.working_by === staff.profileId;
  const orphaned = !!open && open.status === "draft" && (await db.rpc("lab_staff_is_active", { p_profile: open.working_by, p_clinic: staff.clinicId })).data === false;

  await recordAudit({
    clinicId: staff.clinicId,
    action: "lab_result_viewed",
    entityType: "lab_order_items",
    entityId: itemId,
    patientId: order.patient_id,
    actor: { actorId: staff.profileId, actorType: "staff" },
    metadata: { item_id: itemId, result_id: resultRow?.id ?? null, versions: versions.length },
    strict: true,
  });

  return {
    item: { id: item.id, orderId: item.order_id, testCode: item.test_code, testName: item.test_name, patientName: order.patients?.full_name ?? null },
    parameters,
    settings,
    working: open
      ? {
          ...toVersion(open),
          values: valuesOf(open.id),
          mine,
          orphaned,
          canSubmit: !closed && open.status === "draft" && mine,
          canVerify: !closed && open.status === "pending_verification" && !(settings.separateVerifier && open.entered_by === staff.profileId),
          canReturn: !closed && open.status === "pending_verification",
          canTakeOver: !closed && orphaned && !mine,
          canAbandon: open.status === "draft" && (mine || orphaned),
        }
      : null,
    verified: verified ? { ...toVersion(verified), values: valuesOf(verified.id) } : null,
    history: versions.map(toVersion),
    events: events.map((e) => ({
      kind: e.kind as "takeover" | "abandon",
      at: e.created_at,
      by: who(e.actor_id),
      from: e.previous_holder ? who(e.previous_holder) : null,
      reason: e.reason,
      version: versions.find((v) => v.id === e.version_id)?.version ?? 0,
    })),
    documents: attachments.map((a) => ({ id: a.id, kind: a.kind, contentType: a.content_type, sizeBytes: Number(a.size_bytes), addedAt: a.created_at, uploadedBy: names.get(a.uploaded_by) ?? null })),
    canAttach: !closed && !!resultRow && (!!open || !verified),
    canCorrect: !closed && !!verified && !open,
    // The author's own draft (a first entry or a correction) can be edited; with nothing open, only a result that was never verified is entered.
    canEnter: !closed && sampleCollected && (open ? open.status === "draft" && mine : !verified),
  };
}

async function readSettings(clinicId: string): Promise<{ verificationRequired: boolean; separateVerifier: boolean }> {
  const db = createAdminClient();
  const [required, separate] = await Promise.all([
    db.rpc("lab_setting_bool", { p_clinic: clinicId, p_path: ["verification", "required"], p_default: true }),
    db.rpc("lab_setting_bool", { p_clinic: clinicId, p_path: ["verification", "separateVerifier"], p_default: false }),
  ]);
  return { verificationRequired: required.data !== false, separateVerifier: separate.data === true };
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export const saveResultSchema = z
  .object({
    values: z
      .array(z.object({ parameterId: uuidSchema, value: z.union([z.string().trim().min(1).max(500), z.number().finite()]) }).strict())
      .min(1)
      .max(200),
  })
  .strict();
export type SaveResultInput = z.infer<typeof saveResultSchema>;

export const versionActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("submit") }).strict(),
  z.object({ action: z.literal("verify") }).strict(),
  z.object({ action: z.literal("return") }).strict(),
  z.object({ action: z.literal("take_over") }).strict(),
  z.object({ action: z.literal("abandon"), reason: z.string().trim().min(3).max(300) }).strict(),
]);
export type VersionAction = z.infer<typeof versionActionSchema>;
export const correctionSchema = z.object({ expectedVersion: z.number().int().min(1), reason: z.string().trim().min(3).max(300) }).strict();

// A number, optionally with a comparator ("<0.5", ">= 200"): zero and negative numbers are values like any other.
const NUMBER = /^\s*(<=|>=|<|>|≤|≥)?\s*(-?\d+(?:[.,]\d+)?)\s*$/;
const COMPARATOR: Record<string, string> = { "<": "<", "<=": "<=", ">": ">", ">=": ">=", "≤": "<=", "≥": ">=" };

/** Saves the author's draft: the values typed, checked against the configured parameters of THIS test. */
export async function saveResultDraft(staff: Staff, itemId: string, input: SaveResultInput) {
  const db = createAdminClient();
  const { data: item } = await db.from("lab_order_items").select("id, test_id").eq("id", itemId).eq("clinic_id", staff.clinicId).maybeSingle();
  if (!item) throw notFound();
  const { data: params } = await db
    .from("lab_test_parameters")
    .select("id, code, data_type, choices")
    .eq("clinic_id", staff.clinicId)
    .eq("test_id", item.test_id)
    .eq("active", true);
  const byId = new Map((params ?? []).map((p) => [p.id, p]));

  const seen = new Set<string>();
  const values = input.values.map((v) => {
    const p = byId.get(v.parameterId);
    if (!p) throw new ApiError(400, "Ko‘rsatkich bu tahlilga tegishli emas", "validation");
    if (seen.has(p.id)) throw new ApiError(400, "Bir ko‘rsatkich ikki marta kiritilgan", "validation");
    seen.add(p.id);
    if (p.data_type === "numeric") {
      const raw = typeof v.value === "number" ? String(v.value) : v.value;
      const m = NUMBER.exec(raw);
      if (!m) throw new ApiError(400, `${p.code}: son kiriting`, "validation");
      return { parameter_id: p.id, value_numeric: Number(m[2].replace(",", ".")), ...(m[1] ? { comparator: COMPARATOR[m[1]] } : {}) };
    }
    if (typeof v.value !== "string") throw new ApiError(400, `${p.code}: matn kiriting`, "validation");
    if (p.data_type === "choice" && !(p.choices ?? []).includes(v.value)) throw new ApiError(400, `${p.code}: ro‘yxatdagi qiymatlardan birini tanlang`, "validation");
    return { parameter_id: p.id, value_text: v.value };
  });

  const { data, error } = await db.rpc("lab_result_save", { p_clinic: staff.clinicId, p_actor: staff.profileId, p_item: itemId, p_values: values as never });
  if (error) throw resultError(error);
  const r = data as { result_id: string; version_id: string; version: number };
  return { resultId: r.result_id, versionId: r.version_id, version: r.version };
}

/** submit / verify / return-to-draft / take over an orphaned draft / abandon a draft. Repeating a step is not an error (`unchanged`). */
export async function moveResultVersion(staff: Staff, versionId: string, input: VersionAction) {
  const db = createAdminClient();
  const base = { p_clinic: staff.clinicId, p_actor: staff.profileId, p_version: versionId };
  const { data, error } =
    input.action === "submit"
      ? await db.rpc("lab_result_submit", base)
      : input.action === "verify"
        ? await db.rpc("lab_result_verify", base)
        : input.action === "return"
          ? await db.rpc("lab_result_return", base)
          : input.action === "take_over"
            ? await db.rpc("lab_result_take_over", base)
            : await db.rpc("lab_result_abandon", { ...base, p_reason: input.reason });
  if (error) throw resultError(error);
  const r = data as { status?: string; holder?: string; unchanged: boolean };
  return { status: r.status ?? "draft", unchanged: r.unchanged };
}

// ---------------------------------------------------------------------------
// Orphaned drafts for management (no patient, no value)
// ---------------------------------------------------------------------------

export type OrphanedDraft = { versionId: string; testCode: string; testName: string; version: number; holder: string | null; enteredAt: string };

/** Drafts whose holder is no longer an active laboratory user — what owner/admin/manager need to unblock work. */
export async function listOrphanedDrafts(clinicId: string): Promise<OrphanedDraft[]> {
  const { data, error } = await createAdminClient().rpc("lab_orphaned_drafts", { p_clinic: clinicId });
  if (error) throw new ApiError(500, "Qoralamalarni yuklab bo‘lmadi");
  return (data ?? []).map((d) => ({ versionId: d.version_id, testCode: d.test_code, testName: d.test_name, version: d.version, holder: d.holder_name, enteredAt: d.entered_at }));
}

/** Starts a correction of the current verified version: a new draft that keeps the old version intact. */
export async function startCorrection(staff: Staff, itemId: string, input: z.infer<typeof correctionSchema>) {
  const db = createAdminClient();
  const { data: result } = await db.from("lab_results").select("id").eq("clinic_id", staff.clinicId).eq("order_item_id", itemId).maybeSingle();
  if (!result) throw notFound();
  const { data, error } = await db.rpc("lab_result_correct", {
    p_clinic: staff.clinicId,
    p_actor: staff.profileId,
    p_result: result.id,
    p_expected_version: input.expectedVersion,
    p_reason: input.reason,
  });
  if (error) throw resultError(error);
  const r = data as { version_id: string; version: number; corrects_version: number };
  return { versionId: r.version_id, version: r.version, correctsVersion: r.corrects_version };
}
