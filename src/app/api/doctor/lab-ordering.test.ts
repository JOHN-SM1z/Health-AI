import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { localDbAvailable } from "@/test/local-db";
import { findRecentSimilar } from "@/lib/labs/recent";

/**
 * Doctor lab ordering (Phase 5) against the real database: the real guards
 * (requireLinkedDoctor, doctor_patient_access) run with only the session
 * stubbed. Covers a valid order from the doctor's own consultation and
 * without one, idempotent resubmission, an unauthorized and a cross-clinic
 * patient, an inactive test, the wrong doctor's and the wrong patient's
 * consultation, a missing date of birth, the recent-similar-test data and
 * the audited verified-result view.
 */

const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const session = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/staff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/staff")>();
  return { ...actual, getStaffContext: async () => session.ctx };
});

import { GET as getCatalog } from "./lab/catalog/route";
import { GET as getOrders, POST as postOrder } from "./patients/[id]/lab-orders/route";
import { GET as getResult } from "./patients/[id]/lab-results/[itemId]/route";

const describeDb = describe.skipIf(!localDbAvailable());

type Body = { ok: boolean; data?: Record<string, unknown>; code?: string; error?: string };

describeDb("doctor lab ordering (real database)", () => {
  let admin: SupabaseClient;
  const suffix = Date.now().toString(36);
  const clinicA = randomUUID();
  const clinicB = randomUUID();
  const service = randomUUID();
  const people = { drA: randomUUID(), drC: randomUUID(), drK: randomUUID(), reception: randomUUID(), lab: randomUUID() };
  const doctors = { a: randomUUID(), c: randomUUID(), k: randomUUID() };
  let day = 0;
  let cbc = "";
  let glucose = "";
  let inactive = "";
  let hgb = "";

  const as = (profileId: string, role: string, clinicId = clinicA) => {
    session.ctx = { profileId, clinicId, clinicName: "Lab", clinicTimezone: "Asia/Tashkent", roles: [role], platformAdmin: false };
  };
  const asDrA = () => as(people.drA, "doctor");

  async function call<P extends Record<string, string>>(handler: (r: NextRequest, c: { params: Promise<P> }) => Promise<Response>, params: P, body?: unknown) {
    const res = await handler(
      new NextRequest("http://localhost/api/doctor/x", {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      { params: Promise.resolve(params) },
    );
    return { status: res.status, body: (await res.json()) as Body };
  }

  async function patient(clinicId = clinicA, extra: Record<string, unknown> = {}) {
    const { data, error } = await admin
      .from("patients")
      .insert({ clinic_id: clinicId, full_name: `Lab order patient ${suffix}`, date_of_birth: "1985-03-01", sex: "female", ...extra })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return data.id as string;
  }

  async function visit(patientId: string, doctorId: string, status = "in_progress", clinicId = clinicA) {
    const start = new Date(Date.UTC(2026, 4, 4, 5, 0) + day++ * 86_400_000);
    const { data, error } = await admin
      .from("appointments")
      .insert({
        clinic_id: clinicId, patient_id: patientId, doctor_id: doctorId, service_id: service,
        start_at: start.toISOString(), end_at: new Date(start.getTime() + 30 * 60_000).toISOString(), status, source: "walk_in",
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return data.id as string;
  }

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    await admin.from("clinics").insert([
      { id: clinicA, name: `Lab order A ${suffix}`, slug: `lab-order-a-${suffix}`, timezone: "Asia/Tashkent" },
      { id: clinicB, name: `Lab order B ${suffix}`, slug: `lab-order-b-${suffix}`, timezone: "Asia/Tashkent" },
    ]);
    for (const [name, id] of Object.entries(people)) {
      const { error } = await admin.auth.admin.createUser({ id, email: `lab-order-${name}-${suffix}@test.local`, email_confirm: true, password: `Pw-${randomUUID()}` });
      if (error) throw new Error(error.message);
      await admin.from("profiles").insert({ id, full_name: name });
    }
    await admin.from("staff_roles").insert([
      { clinic_id: clinicA, profile_id: people.drA, role: "doctor" },
      { clinic_id: clinicA, profile_id: people.drC, role: "doctor" },
      { clinic_id: clinicB, profile_id: people.drK, role: "doctor" },
      { clinic_id: clinicA, profile_id: people.reception, role: "receptionist" },
      { clinic_id: clinicA, profile_id: people.lab, role: "lab" },
    ]);
    await admin.from("doctors").insert([
      { id: doctors.a, clinic_id: clinicA, profile_id: people.drA, name: `Dr A ${suffix}`, active: true },
      { id: doctors.c, clinic_id: clinicA, profile_id: people.drC, name: `Dr C ${suffix}`, active: true },
      { id: doctors.k, clinic_id: clinicB, profile_id: people.drK, name: `Dr K ${suffix}`, active: true },
    ]);
    await admin.from("services").insert([{ id: service, clinic_id: clinicA, name: `Lab order consult ${suffix}`, duration_minutes: 30, price: 1 }]);
    await admin.from("doctor_working_hours").insert(
      [doctors.a, doctors.c].flatMap((doctor_id) =>
        [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinic_id: clinicA, doctor_id, weekday, start_time: "00:00", end_time: "23:59" })),
      ),
    );
    const tests = await admin
      .from("lab_tests")
      .insert([
        { clinic_id: clinicA, code: `CBC${suffix}`, name: `Umumiy qon tahlili ${suffix}`, sample_type: "Qon", price: 100000, preparation_text: "Och qoringa" },
        { clinic_id: clinicA, code: `GLU${suffix}`, name: `Glyukoza ${suffix}`, sample_type: "Qon", price: 50000 },
        { clinic_id: clinicA, code: `OLD${suffix}`, name: `Eski tahlil ${suffix}`, sample_type: "Qon", price: 1000, active: false },
      ], { defaultToNull: false })
      .select("id, code");
    if (tests.error) throw new Error(tests.error.message);
    const byCode = Object.fromEntries(tests.data.map((t) => [t.code, t.id]));
    cbc = byCode[`CBC${suffix}`];
    glucose = byCode[`GLU${suffix}`];
    inactive = byCode[`OLD${suffix}`];
    const param = await admin.from("lab_test_parameters").insert({ clinic_id: clinicA, test_id: cbc, code: "HGB", name: "Gemoglobin", value_type: "numeric", unit: "g/L" }).select("id").single();
    hgb = param.data!.id;
    await admin.from("lab_reference_ranges").insert({ clinic_id: clinicA, parameter_id: hgb, sex: "female", low: 120, high: 150 });
  });

  afterAll(async () => {
    if (!admin) return;
    await admin.from("clinics").delete().in("id", [clinicA, clinicB]);
    for (const id of Object.values(people)) await admin.auth.admin.deleteUser(id);
  });

  beforeEach(asDrA);

  it("shows only orderable tests, with preparation and price", async () => {
    const res = await getCatalog();
    const body = (await res.json()) as { data: { tests: Array<{ id: string; preparationText: string | null; price: number }> } };
    expect(res.status).toBe(200);
    const ids = body.data.tests.map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining([cbc, glucose]));
    expect(ids).not.toContain(inactive);
    expect(body.data.tests.find((t) => t.id === cbc)).toMatchObject({ preparationText: "Och qoringa", price: 100000 });
  });

  it("orders from the doctor's own consultation: clinic, patient, doctor and prices set by the server; resubmission replays", async () => {
    const p = await patient();
    const consultation = await visit(p, doctors.a);
    const key = randomUUID();
    const body = { idempotencyKey: key, appointmentId: consultation, testIds: [cbc, glucose], price: 1, clinicId: clinicB, orderedBy: people.drC };
    const first = await call(postOrder, { id: p }, body);
    expect(first.status).toBe(201);
    const orderId = (first.body.data as { orderId: string }).orderId;
    const { data: order } = await admin.from("lab_orders").select("clinic_id, patient_id, source, ordered_by, ordering_doctor_id, appointment_id").eq("id", orderId).single();
    expect(order).toEqual({ clinic_id: clinicA, patient_id: p, source: "consultation", ordered_by: people.drA, ordering_doctor_id: doctors.a, appointment_id: consultation });
    const { data: items } = await admin.from("lab_order_items").select("test_id, price_snapshot, status").eq("order_id", orderId);
    expect(items?.map((i) => [i.test_id === cbc ? "cbc" : "glu", Number(i.price_snapshot), i.status]).sort()).toEqual([
      ["cbc", 100000, "ready_for_collection"],
      ["glu", 50000, "ready_for_collection"],
    ]);

    const again = await call(postOrder, { id: p }, body);
    expect(again.status).toBe(200);
    expect(again.body.data).toEqual({ orderId, replayed: true });
    const reused = await call(postOrder, { id: p }, { ...body, testIds: [cbc] });
    expect(reused.status).toBe(409);
    const { count } = await admin.from("lab_orders").select("id", { count: "exact", head: true }).eq("patient_id", p);
    expect(count).toBe(1);
  });

  it("orders outside a consultation (direct order) for the doctor's own patient", async () => {
    const p = await patient();
    await visit(p, doctors.a, "completed");
    const res = await call(postOrder, { id: p }, { idempotencyKey: randomUUID(), testIds: [glucose] });
    expect(res.status).toBe(201);
    const { data } = await admin.from("lab_orders").select("source, appointment_id").eq("id", (res.body.data as { orderId: string }).orderId).single();
    expect(data).toEqual({ source: "walk_in", appointment_id: null });
  });

  it("refuses an inactive test, an empty order and a patient without a date of birth", async () => {
    const p = await patient();
    await visit(p, doctors.a, "completed");
    const stale = await call(postOrder, { id: p }, { idempotencyKey: randomUUID(), testIds: [inactive] });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("inactive_test");
    expect((await call(postOrder, { id: p }, { idempotencyKey: randomUUID(), testIds: [] })).status).toBe(400);

    const noDob = await patient(clinicA, { date_of_birth: null });
    await visit(noDob, doctors.a, "completed");
    const dob = await call(postOrder, { id: noDob }, { idempotencyKey: randomUUID(), testIds: [cbc] });
    expect(dob.status).toBe(422);
    expect(dob.body.code).toBe("dob_required");
  });

  it("refuses a patient the doctor has no access to, and another clinic's patient — nothing is created", async () => {
    const unrelated = await patient();
    await visit(unrelated, doctors.c, "completed");
    for (const res of [
      await call(getOrders, { id: unrelated }),
      await call(postOrder, { id: unrelated }, { idempotencyKey: randomUUID(), testIds: [cbc] }),
    ]) {
      expect(res.status).toBe(404);
    }
    const foreign = await patient(clinicB);
    expect((await call(postOrder, { id: foreign }, { idempotencyKey: randomUUID(), testIds: [cbc] })).status).toBe(404);
    const { count } = await admin.from("lab_orders").select("id", { count: "exact", head: true }).in("patient_id", [unrelated, foreign]);
    expect(count).toBe(0);
  });

  it("refuses another doctor's consultation, another patient's consultation and one that has not started", async () => {
    const p = await patient();
    await visit(p, doctors.a, "completed");
    const drCVisit = await visit(p, doctors.c, "in_progress");
    const wrongDoctor = await call(postOrder, { id: p }, { idempotencyKey: randomUUID(), appointmentId: drCVisit, testIds: [cbc] });
    expect(wrongDoctor.status).toBe(404);
    expect(wrongDoctor.body.code).toBe("consultation_not_found");

    const other = await patient();
    const otherVisit = await visit(other, doctors.a, "in_progress");
    expect((await call(postOrder, { id: p }, { idempotencyKey: randomUUID(), appointmentId: otherVisit, testIds: [cbc] })).status).toBe(404);

    const booked = await visit(p, doctors.a, "confirmed");
    const notStarted = await call(postOrder, { id: p }, { idempotencyKey: randomUUID(), appointmentId: booked, testIds: [cbc] });
    expect(notStarted.status).toBe(409);
    expect(notStarted.body.code).toBe("consultation_not_started");
  });

  it("is a doctor-only workflow: reception, lab staff and other clinics' doctors are refused", async () => {
    const p = await patient();
    as(people.reception, "receptionist");
    expect((await call(postOrder, { id: p }, { idempotencyKey: randomUUID(), testIds: [cbc] })).status).toBe(403);
    as(people.lab, "lab");
    expect((await call(getOrders, { id: p })).status).toBe(403);
    as(people.drK, "doctor", clinicB);
    expect((await call(postOrder, { id: p }, { idempotencyKey: randomUUID(), testIds: [cbc] })).status).toBe(404);
  });

  it("lists earlier orders so the recent-similar-test warning can be shown (and never blocks)", async () => {
    const p = await patient();
    await visit(p, doctors.a, "completed");
    await call(postOrder, { id: p }, { idempotencyKey: randomUUID(), testIds: [cbc] });
    const list = await call(getOrders, { id: p });
    expect(list.status).toBe(200);
    const { orders, recentTestDays } = list.body.data as { orders: Array<{ createdAt: string; items: Array<{ id: string; testId: string; status: string }> }>; recentTestDays: number };
    const warning = findRecentSimilar([cbc], orders, recentTestDays, Date.now());
    expect(warning).toEqual([expect.objectContaining({ testId: cbc, daysAgo: 0, status: "ready_for_collection" })]);
    // Ordering the same test again is still allowed.
    expect((await call(postOrder, { id: p }, { idempotencyKey: randomUUID(), testIds: [cbc] })).status).toBe(201);
  });

  it("shows a verified result to an authorized doctor (audited), never an unverified one, never to an unrelated doctor", async () => {
    const p = await patient();
    await visit(p, doctors.a, "completed");
    const created = await call(postOrder, { id: p }, { idempotencyKey: randomUUID(), testIds: [cbc] });
    const orderId = (created.body.data as { orderId: string }).orderId;
    const { data: item } = await admin.from("lab_order_items").select("id").eq("order_id", orderId).single();
    const itemId = item!.id;

    expect((await call(getResult, { id: p, itemId })).body.code).toBe("result_not_verified");

    // The lab collects, enters (reception enters here) and a second person verifies.
    const { data: sample } = await admin
      .from("lab_samples")
      .insert({ clinic_id: clinicA, patient_id: p, order_id: orderId, sample_code: `S-${suffix}-${day++}`, sample_type: "Qon", collected_by: people.lab })
      .select("id")
      .single();
    await admin.from("lab_sample_items").insert({ sample_id: sample!.id, order_item_id: itemId, clinic_id: clinicA });
    await admin.from("lab_order_items").update({ status: "collected", status_changed_by: people.lab }).eq("id", itemId);
    const { data: result } = await admin.from("lab_results").insert({ clinic_id: clinicA, patient_id: p, order_item_id: itemId, entered_by: people.lab }).select("id").single();
    await admin.from("lab_result_values").insert({ clinic_id: clinicA, result_id: result!.id, parameter_id: hgb, value_numeric: 118 });
    await admin.from("lab_results").update({ status: "submitted", submitted_by: people.lab }).eq("id", result!.id);
    const verified = await admin.from("lab_results").update({ status: "verified", verified_by: people.drC }).eq("id", result!.id);
    expect(verified.error).toBeNull();

    const view = await call(getResult, { id: p, itemId });
    expect(view.status).toBe(200);
    const shown = (view.body.data as { result: { values: Array<{ parameter: string; value: string; unit: string; flag: string; rangeLabel: string }> } }).result;
    expect(shown.values).toEqual([{ parameter: "Gemoglobin", value: "118", unit: "g/L", rangeLabel: "120–150", flag: "low" }]);
    const { data: audit } = await admin.from("audit_events").select("actor_id, patient_id").eq("action", "lab_result_viewed").eq("entity_id", result!.id);
    expect(audit).toEqual([{ actor_id: people.drA, patient_id: p }]);
    expect(JSON.stringify(audit)).not.toContain("118");

    // Dr C verified it but has no relationship with the patient: no access.
    as(people.drC, "doctor");
    expect((await call(getResult, { id: p, itemId })).status).toBe(404);
  });
});
