import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { anyColumnContains } from "@/lib/api/postgrest";
import { recordAudit } from "@/lib/audit";
import type { LinkedDoctor } from "@/lib/auth/guards";
import { canDoctorAccessPatientClinicalData } from "@/lib/clinical-access/access";
import { patientAccessDenied } from "@/lib/clinical-access/denial";
import { getLabSettings } from "@/lib/labs/catalog";
import { logger } from "@/lib/logger";

/**
 * A doctor's laboratory ordering (phase 4). Everything is derived from the server-side doctor session:
 * the clinic, the ordering doctor and their login are never taken from the request, the price is the
 * catalog's (snapshotted by the database), and a patient is reachable only through the same clinical
 * access decision as every other clinical read (doctor_patient_access). An order is written inside the
 * doctor's OWN consultation with the patient (the database enforces it with a composite key); a doctor who
 * only holds a referral starts a consultation first, as for every other clinical record.
 *
 * Nothing here diagnoses, recommends or blocks: the "similar test" notice is advisory and rule-based (same
 * test, same patient, inside the clinic's window) and never contains a result value.
 */

const MAX_ITEMS = 50;
const DAY_MS = 86_400_000;

type Db = ReturnType<typeof createAdminClient>;

const notFound = (message = "Topilmadi", code = "lab_not_found") => new ApiError(404, message, code);

// ---------------------------------------------------------------------------
// Catalog search (configuration, not clinical data)
// ---------------------------------------------------------------------------

export type CatalogTest = {
  id: string;
  code: string;
  name: string;
  category: string | null;
  price: number;
  sampleType: string | null;
  preparationText: string | null;
  turnaroundMinutes: number | null;
};
export type CatalogPanel = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  /** What the panel costs: its fixed price, or the sum of its tests. */
  price: number;
  fixedPrice: boolean;
  tests: Array<{ id: string; code: string; name: string }>;
  /** Tests of the panel that are no longer active: such a panel cannot be ordered until staff fix it. */
  unavailable: Array<{ id: string; code: string; name: string }>;
};

/** Active tests and panels matching a code, name or section — what a doctor can order. */
export async function searchLabCatalog(doctor: LinkedDoctor, query: string, limit = 30): Promise<{ tests: CatalogTest[]; panels: CatalogPanel[] }> {
  const db = createAdminClient();
  const q = query.trim().slice(0, 80);

  let testQuery = db
    .from("lab_tests")
    .select("id, code, name, price, sample_type, preparation_text, turnaround_minutes, lab_categories(name)")
    .eq("clinic_id", doctor.clinicId)
    .eq("active", true)
    .order("name")
    .limit(limit);
  let panelQuery = db
    .from("lab_panels")
    .select("id, code, name, description, price, lab_panel_tests(sort_order, lab_tests(id, code, name, price, active))")
    .eq("clinic_id", doctor.clinicId)
    .eq("active", true)
    .order("name")
    .limit(limit);

  if (q) {
    const filters = [anyColumnContains(["code", "name"], q)];
    const { data: categories } = await db.from("lab_categories").select("id").eq("clinic_id", doctor.clinicId).ilike("name", `%${q.replace(/[%_\\]/g, "\\$&")}%`).limit(20);
    if (categories?.length) filters.push(`category_id.in.(${categories.map((c) => c.id).join(",")})`);
    testQuery = testQuery.or(filters.join(","));
    panelQuery = panelQuery.or(anyColumnContains(["code", "name"], q));
  }

  const [testsRes, panelsRes] = await Promise.all([testQuery, panelQuery]);
  if (testsRes.error || panelsRes.error) throw new ApiError(500, "Tahlillarni yuklab bo‘lmadi");

  const tests: CatalogTest[] = (testsRes.data ?? []).map((t) => ({
    id: t.id,
    code: t.code,
    name: t.name,
    category: (t.lab_categories as { name: string } | null)?.name ?? null,
    price: Number(t.price),
    sampleType: t.sample_type,
    preparationText: t.preparation_text,
    turnaroundMinutes: t.turnaround_minutes,
  }));

  const panels: CatalogPanel[] = (panelsRes.data ?? []).map((p) => {
    const members = [...((p.lab_panel_tests ?? []) as Array<{ sort_order: number; lab_tests: { id: string; code: string; name: string; price: number; active: boolean } | null }>)]
      .sort((a, b) => a.sort_order - b.sort_order)
      .flatMap((m) => (m.lab_tests ? [m.lab_tests] : []));
    const fixed = p.price !== null;
    return {
      id: p.id,
      code: p.code,
      name: p.name,
      description: p.description,
      price: fixed ? Number(p.price) : members.reduce((sum, t) => sum + Number(t.price), 0),
      fixedPrice: fixed,
      tests: members.map((t) => ({ id: t.id, code: t.code, name: t.name })),
      unavailable: members.filter((t) => !t.active).map((t) => ({ id: t.id, code: t.code, name: t.name })),
    };
  });
  return { tests, panels };
}

// ---------------------------------------------------------------------------
// Resolving a selection (tests and panels) into order items
// ---------------------------------------------------------------------------

type Selection = { testIds: string[]; panelIds: string[] };

/**
 * The tests an order would contain, from explicitly chosen tests and expanded panels. A test chosen both
 * ways is one item (its provenance is the explicit choice). Unknown or other-clinic ids answer 404, an
 * inactive test or panel 409 — never silently dropped.
 */
async function resolveItems(db: Db, clinicId: string, selection: Selection, { allowInactive = false } = {}): Promise<Array<{ test_id: string; panel_id: string | null }>> {
  const items = new Map<string, string | null>();

  if (selection.testIds.length) {
    const { data, error } = await db.from("lab_tests").select("id, active").eq("clinic_id", clinicId).in("id", selection.testIds);
    if (error) throw new ApiError(500, "Tahlillarni tekshirib bo‘lmadi");
    if ((data ?? []).length !== new Set(selection.testIds).size) throw notFound();
    if (!allowInactive && (data ?? []).some((t) => !t.active)) throw new ApiError(409, "Nofaol tahlilni buyurib bo‘lmaydi", "lab_test_inactive");
    for (const id of selection.testIds) items.set(id, null);
  }

  if (selection.panelIds.length) {
    const { data, error } = await db
      .from("lab_panels")
      .select("id, active, lab_panel_tests(sort_order, lab_tests(id, active))")
      .eq("clinic_id", clinicId)
      .in("id", selection.panelIds);
    if (error) throw new ApiError(500, "Paketlarni tekshirib bo‘lmadi");
    if ((data ?? []).length !== new Set(selection.panelIds).size) throw notFound();
    for (const panel of data ?? []) {
      if (!allowInactive && !panel.active) throw new ApiError(409, "Nofaol paketni buyurib bo‘lmaydi", "lab_panel_inactive");
      const members = (panel.lab_panel_tests ?? []) as Array<{ lab_tests: { id: string; active: boolean } | null }>;
      for (const m of members) {
        if (!m.lab_tests) continue;
        if (!allowInactive && !m.lab_tests.active) throw new ApiError(409, "Paketdagi tahlillardan biri nofaol", "lab_test_inactive");
        if (!items.has(m.lab_tests.id)) items.set(m.lab_tests.id, panel.id);
      }
    }
  }

  if (items.size === 0) throw new ApiError(400, "Kamida bitta tahlil tanlang", "validation");
  if (items.size > MAX_ITEMS) throw new ApiError(400, `Bir buyurtmada ${MAX_ITEMS} tadan ko‘p tahlil bo‘lmaydi`, "validation");
  return [...items].map(([test_id, panel_id]) => ({ test_id, panel_id }));
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/** The patient's clinical history is reachable only through the one access decision; anything else is the same refusal as everywhere. */
async function assertPatientAccess(doctor: LinkedDoctor, patientId: string): Promise<void> {
  const access = await canDoctorAccessPatientClinicalData(doctor.doctorId, patientId);
  if (!access.allowed || !access.fullHistory) throw await patientAccessDenied(doctor, patientId);
}

// ---------------------------------------------------------------------------
// Creating an order
// ---------------------------------------------------------------------------

export type CreateLabOrderInput = {
  patientId: string;
  /** The doctor's own consultation; when omitted, the one in progress with this patient. */
  appointmentId?: string;
  testIds: string[];
  panelIds: string[];
  priority: "routine" | "urgent";
  notes?: string | null;
  /** A referral to this doctor the order answers (optional). */
  referralId?: string | null;
  idempotencyKey: string;
};

export type LabOrderItemSummary = { id: string; testId: string; code: string; name: string; price: number; status: string };
export type CreatedLabOrder = {
  id: string;
  status: string;
  priority: string;
  replayed: boolean;
  appointmentId: string;
  /** The sum of the items' test prices. A fixed-price panel is billed at the panel price in phase 5 — this is not an invoice. */
  total: number;
  items: LabOrderItemSummary[];
};

async function consultationFor(db: Db, doctor: LinkedDoctor, patientId: string, appointmentId: string | undefined): Promise<string> {
  if (appointmentId) {
    const { data, error } = await db
      .from("appointments")
      .select("id, status")
      .eq("id", appointmentId)
      .eq("clinic_id", doctor.clinicId)
      .eq("patient_id", patientId)
      .eq("doctor_id", doctor.doctorId)
      .maybeSingle();
    if (error) throw new ApiError(500, "Qabulni tekshirib bo‘lmadi");
    if (!data) throw notFound("Qabul topilmadi", "consultation_not_found");
    if (!["in_progress", "completed"].includes(data.status)) throw new ApiError(409, "Qabul hali boshlanmagan", "consultation_not_active");
    return data.id;
  }
  const { data } = await db
    .from("appointments")
    .select("id")
    .eq("clinic_id", doctor.clinicId)
    .eq("patient_id", patientId)
    .eq("doctor_id", doctor.doctorId)
    .eq("status", "in_progress")
    .order("start_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) throw new ApiError(409, "Tahlil buyurtma qilish uchun avval bemor bilan qabulni boshlang", "consultation_required");
  return data.id;
}

/** Maps a database refusal to an API error without echoing row data. */
function orderError(error: { code?: string; message?: string }): ApiError {
  const message = error.message ?? "";
  if (message.includes("is inactive")) return new ApiError(409, "Nofaol tahlilni buyurib bo‘lmaydi", "lab_test_inactive");
  if (message.includes("not in this clinic")) return notFound();
  if (message.includes("in progress or completed")) return new ApiError(409, "Qabul hali boshlanmagan", "consultation_not_active");
  if (message.includes("at least one test")) return new ApiError(400, "Kamida bitta tahlil tanlang", "validation");
  if (message.includes("lab order:")) return new ApiError(403, "Bu buyurtmani berishga ruxsat yo‘q", "forbidden");
  if (error.code === "23503") return notFound("Qabul topilmadi", "consultation_not_found");
  if (error.code === "23514") return new ApiError(400, "Qiymatlar noto‘g‘ri", "validation");
  logger.error("lab order failed", { code: error.code });
  return new ApiError(500, "Buyurtmani saqlab bo‘lmadi", "lab_order_failed");
}

/** Whether an existing order is what this request asks for: same patient, same consultation (when named), same set of tests. */
function isSameOrder(
  existing: { patient_id: string; appointment_id: string },
  existingItems: LabOrderItemSummary[],
  input: CreateLabOrderInput,
  asked: Array<{ test_id: string }>,
): boolean {
  const have = new Set(existingItems.map((i) => i.testId));
  const want = new Set(asked.map((i) => i.test_id));
  return (
    existing.patient_id === input.patientId &&
    (!input.appointmentId || existing.appointment_id === input.appointmentId) &&
    have.size === want.size &&
    [...want].every((t) => have.has(t))
  );
}

/**
 * Creates an order from the doctor's own consultation — all or nothing, and idempotent per
 * `idempotencyKey`: a repeat (double click, retry) returns the first order (`replayed: true`) and writes
 * nothing; the same key with different content is a 409.
 */
export async function createLabOrder(doctor: LinkedDoctor, input: CreateLabOrderInput): Promise<CreatedLabOrder> {
  await assertPatientAccess(doctor, input.patientId);
  const db = createAdminClient();

  // A retry of an order that already exists is answered from that order BEFORE anything is re-validated: a
  // test deactivated, or a consultation completed, since the first attempt must not turn the retry of a
  // lost response into an error (and a second order). Same key + different content is still a conflict.
  const { data: existing } = await db
    .from("lab_orders")
    .select("id, patient_id, appointment_id")
    .eq("clinic_id", doctor.clinicId)
    .eq("ordering_doctor_id", doctor.doctorId)
    .eq("creation_key", input.idempotencyKey)
    .maybeSingle();
  if (existing) {
    const asked = await resolveItems(db, doctor.clinicId, { testIds: input.testIds, panelIds: input.panelIds }, { allowInactive: true });
    const created = await loadOrder(db, doctor.clinicId, existing.id);
    if (!isSameOrder(existing, created.items, input, asked)) throw new ApiError(409, "Bu kalit boshqa buyurtma uchun ishlatilgan", "idempotency_conflict");
    return { ...created, replayed: true };
  }

  const appointmentId = await consultationFor(db, doctor, input.patientId, input.appointmentId);
  const items = await resolveItems(db, doctor.clinicId, { testIds: input.testIds, panelIds: input.panelIds });

  if (input.referralId) {
    const { data } = await db
      .from("referrals")
      .select("id")
      .eq("id", input.referralId)
      .eq("clinic_id", doctor.clinicId)
      .eq("patient_id", input.patientId)
      .eq("referred_to_doctor_id", doctor.doctorId)
      .in("status", ["pending", "accepted", "in_progress", "completed"])
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();
    // Only a live referral addressed to THIS doctor can be answered by their order (not a declined, revoked or expired one).
    if (!data) throw notFound("Yo‘llanma topilmadi", "referral_not_found");
  }

  const { data, error } = await db.rpc("lab_create_order", {
    p_clinic_id: doctor.clinicId,
    p_actor: doctor.profileId,
    p_patient_id: input.patientId,
    p_doctor_id: doctor.doctorId,
    p_appointment_id: appointmentId,
    p_referral_id: (input.referralId ?? null) as never,
    p_priority: input.priority,
    p_notes: (input.notes?.trim() || null) as never,
    p_creation_key: input.idempotencyKey,
    p_items: items,
  });
  if (error) throw orderError(error);
  const result = data as { order_id: string; replayed: boolean; patient_id: string; appointment_id: string };

  const created = await loadOrder(db, doctor.clinicId, result.order_id);
  if (result.replayed && !isSameOrder({ patient_id: result.patient_id, appointment_id: result.appointment_id }, created.items, input, items)) {
    throw new ApiError(409, "Bu kalit boshqa buyurtma uchun ishlatilgan", "idempotency_conflict");
  }
  return { ...created, replayed: result.replayed };
}

async function loadOrder(db: Db, clinicId: string, orderId: string): Promise<Omit<CreatedLabOrder, "replayed">> {
  const { data, error } = await db
    .from("lab_orders")
    .select("id, status, priority, appointment_id, lab_order_items(id, test_id, test_code, test_name, price_snapshot, status)")
    .eq("id", orderId)
    .eq("clinic_id", clinicId)
    .single();
  if (error || !data) throw new ApiError(500, "Buyurtmani yuklab bo‘lmadi");
  const items = ((data.lab_order_items ?? []) as Array<{ id: string; test_id: string; test_code: string; test_name: string; price_snapshot: number; status: string }>).map((i) => ({
    id: i.id,
    testId: i.test_id,
    code: i.test_code,
    name: i.test_name,
    price: Number(i.price_snapshot),
    status: i.status,
  }));
  return {
    id: data.id,
    status: data.status,
    priority: data.priority,
    appointmentId: data.appointment_id,
    total: items.filter((i) => i.status === "active").reduce((sum, i) => sum + i.price, 0),
    items,
  };
}

// ---------------------------------------------------------------------------
// A patient's orders (history) and the advisory "similar test" notice
// ---------------------------------------------------------------------------

export type PatientLabOrder = {
  id: string;
  status: string;
  priority: string;
  createdAt: string;
  orderedBy: string | null;
  isOwn: boolean;
  /** Clinical text written by the ordering doctor — readable by doctors with the history, never by staff. */
  notes: string | null;
  /**
   * "verified" once a finalised result stands, otherwise "none". A draft, a submitted-but-unverified or an abandoned result
   * is laboratory work in progress and is never shown to a doctor as a result — not even by status.
   */
  items: Array<LabOrderItemSummary & { resultStatus: "none" | "verified" }>;
};

/** The patient's laboratory orders (every doctor's, as the longitudinal record), newest first. Every read is audited. */
export async function listPatientLabOrders(doctor: LinkedDoctor, patientId: string): Promise<PatientLabOrder[]> {
  await assertPatientAccess(doctor, patientId);
  const db = createAdminClient();
  const { data, error } = await db
    .from("lab_orders")
    .select(
      "id, status, priority, notes, created_at, ordering_doctor_id, doctors(name), lab_order_items(id, test_id, test_code, test_name, price_snapshot, status), lab_results(order_item_id, status)",
    )
    .eq("clinic_id", doctor.clinicId)
    .eq("patient_id", patientId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new ApiError(500, "Buyurtmalarni yuklab bo‘lmadi");

  const orders: PatientLabOrder[] = (data ?? []).map((o) => {
    const resultByItem = new Map(((o.lab_results ?? []) as Array<{ order_item_id: string; status: string }>).map((r) => [r.order_item_id, r.status]));
    return {
      id: o.id,
      status: o.status,
      priority: o.priority,
      createdAt: o.created_at,
      orderedBy: (o.doctors as { name: string } | null)?.name ?? null,
      isOwn: o.ordering_doctor_id === doctor.doctorId,
      notes: o.notes,
      items: ((o.lab_order_items ?? []) as Array<{ id: string; test_id: string; test_code: string; test_name: string; price_snapshot: number; status: string }>).map((i) => ({
        id: i.id,
        testId: i.test_id,
        code: i.test_code,
        name: i.test_name,
        price: Number(i.price_snapshot),
        status: i.status,
        resultStatus: resultByItem.get(i.id) === "verified" ? "verified" : "none",
      })),
    };
  });

  // The orders' text is released: it is logged as read, before it is returned (the request fails if the log fails).
  await recordAudit({
    clinicId: doctor.clinicId,
    action: "lab_order_viewed",
    entityType: "patients",
    entityId: patientId,
    patientId,
    actor: { actorId: doctor.profileId, actorType: "staff" },
    metadata: { via: "list", doctor_id: doctor.doctorId, order_ids: orders.map((o) => o.id) },
    strict: true,
  });
  return orders;
}

export type SimilarTestNotice = {
  testId: string;
  code: string;
  name: string;
  orderId: string;
  orderedAt: string;
  daysAgo: number;
  orderStatus: string;
  /** Whether a verified result exists for that earlier order — its values are not part of this notice. */
  resultAvailable: boolean;
  isOwn: boolean;
};

/**
 * "Similar test found: CBC — 18 days ago": earlier, not-cancelled orders of the same test for the same
 * patient inside the clinic's window. ADVISORY — it never blocks, cancels or recommends anything, and
 * carries no result value. The window is the clinic's setting (0 turns the notice off).
 */
export async function findSimilarRecentTests(doctor: LinkedDoctor, patientId: string, selection: Selection): Promise<SimilarTestNotice[]> {
  await assertPatientAccess(doctor, patientId);
  const db = createAdminClient();
  const settings = await getLabSettings(doctor.clinicId);
  const windowDays = settings.ordering.recentTestWindowDays;
  if (windowDays === 0) return [];

  const items = await resolveItems(db, doctor.clinicId, selection);
  const since = new Date(Date.now() - windowDays * DAY_MS).toISOString();
  const { data, error } = await db
    .from("lab_order_items")
    .select("id, test_id, test_code, test_name, order_id, lab_orders!inner(id, status, created_at, ordering_doctor_id, patient_id, clinic_id)")
    .eq("clinic_id", doctor.clinicId)
    .eq("status", "active")
    .in("test_id", items.map((i) => i.test_id))
    .eq("lab_orders.patient_id", patientId)
    .eq("lab_orders.clinic_id", doctor.clinicId)
    .neq("lab_orders.status", "cancelled")
    .gte("lab_orders.created_at", since)
    .order("created_at", { referencedTable: "lab_orders", ascending: false });
  if (error) throw new ApiError(500, "Oldingi tahlillarni tekshirib bo‘lmadi");

  type Row = { id: string; test_id: string; test_code: string; test_name: string; order_id: string; lab_orders: { id: string; status: string; created_at: string; ordering_doctor_id: string } };
  const latest = new Map<string, Row>();
  for (const row of (data ?? []) as unknown as Row[]) {
    const current = latest.get(row.test_id);
    if (!current || row.lab_orders.created_at > current.lab_orders.created_at) latest.set(row.test_id, row);
  }
  const rows = [...latest.values()];
  if (rows.length === 0) return [];

  const { data: results } = await db
    .from("lab_results")
    .select("order_item_id, status")
    .eq("clinic_id", doctor.clinicId)
    .in("order_item_id", rows.map((r) => r.id));
  const verified = new Set((results ?? []).filter((r) => r.status === "verified").map((r) => r.order_item_id));

  const now = Date.now();
  const notices = rows.map((r) => ({
    testId: r.test_id,
    code: r.test_code,
    name: r.test_name,
    orderId: r.order_id,
    orderedAt: r.lab_orders.created_at,
    daysAgo: Math.max(0, Math.floor((now - Date.parse(r.lab_orders.created_at)) / DAY_MS)),
    orderStatus: r.lab_orders.status,
    resultAvailable: verified.has(r.id),
    isOwn: r.lab_orders.ordering_doctor_id === doctor.doctorId,
  }));

  await recordAudit({
    clinicId: doctor.clinicId,
    action: "lab_order_viewed",
    entityType: "patients",
    entityId: patientId,
    patientId,
    actor: { actorId: doctor.profileId, actorType: "staff" },
    metadata: { via: "similar_notice", doctor_id: doctor.doctorId, order_ids: notices.map((n) => n.orderId) },
    strict: true,
  });
  return notices;
}
