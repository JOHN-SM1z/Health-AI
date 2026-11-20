import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { localDbAvailable } from "@/test/local-db";

/**
 * Laboratory security review (Phase 19) — the HTTP layer, attacked through
 * the real route handlers and the real database:
 *
 *  * cross-site writes (F3: a foreign Origin is refused on every JSON write);
 *  * no session: every lab route refuses;
 *  * clinic A's staff with clinic B's ids (orders, items, results, samples,
 *    documents, imports, send-outs, payments, patients): 404, nothing changed;
 *  * modified bodies: a clinic id, price or amount in the request is ignored;
 *    another clinic's patient is refused;
 *  * roles confined to their purpose (reception: no values; lab: no money or
 *    administration; doctors: no clinic-wide queue);
 *  * forged and repeated payments: refused for non-payment roles; the amount
 *    is never taken from the request; concurrent payments transition once.
 */

const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const session = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/staff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/staff")>();
  return { ...actual, getStaffContext: async () => session.ctx };
});

import { GET as queue } from "../lab/queue/route";
import { POST as createOrder } from "../lab/orders/route";
import { GET as resultEntry, PUT as saveResult } from "../lab/items/[id]/result/route";
import { POST as resultAction } from "../lab/results/[id]/route";
import { POST as sampleAction } from "../lab/samples/[id]/route";
import { POST as collect } from "../lab/orders/[id]/samples/route";
import { GET as document } from "../lab/documents/[id]/route";
import { GET as importBatch } from "../lab/imports/[id]/route";
import { POST as sendOut } from "../lab/items/[id]/send-out/route";
import { GET as labDashboard } from "../lab/dashboard/route";
import { GET as payments } from "../admin/lab/payments/route";
import { POST as pay } from "../admin/lab/orders/[id]/payment/route";
import { GET as settingsGet, PUT as settingsPut } from "../admin/lab/settings/route";
import { GET as providers } from "../admin/lab/providers/route";
import { GET as labAnalytics } from "../admin/analytics/lab/route";
import { GET as labHistory } from "../doctor/patients/[id]/lab-history/route";
import { GET as labSummary } from "../doctor/patients/[id]/lab-summary/route";
import { GET as doctorResult } from "../doctor/patients/[id]/lab-results/[itemId]/route";
import { POST as notificationsAction } from "../staff/notifications/route";

const describeDb = describe.skipIf(!localDbAvailable());
const BASE = "http://localhost:3000";
const EVIL = "https://evil.example";

type Body = { ok: boolean; data?: Record<string, unknown>; code?: string };
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Body });
const get = (path: string) => new NextRequest(`${BASE}${path}`);
const send = (path: string, method: string, body: unknown, origin?: string) =>
  new NextRequest(`${BASE}${path}`, {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", host: "localhost:3000", ...(origin ? { origin } : {}) },
  });
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

describeDb("lab red team — HTTP layer", () => {
  let admin: SupabaseClient;
  const suffix = Date.now().toString(36);
  const clinicA: string = randomUUID();
  const clinicB: string = randomUUID();
  const people = { owner: randomUUID(), manager: randomUUID(), reception: randomUUID(), lab1: randomUUID(), lab2: randomUUID(), drA: randomUUID(), labB: randomUUID(), labB2: randomUUID(), ownerB: randomUUID() };
  const doctorA = randomUUID();
  const service = randomUUID();
  const A = { test: "", param: "", patient: "", order: "", item: "", result: "", sample: "" };
  const B = { test: "", param: "", patient: "", order: "", item: "", result: "", sample: "", document: "", batch: "" };

  const as = (profileId: string, role: string, clinicId = clinicA) => {
    session.ctx = { profileId, clinicId, clinicName: "Red", clinicTimezone: "Asia/Tashkent", roles: [role], platformAdmin: false };
  };
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await admin.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  };

  async function chain(clinic: string, patient: string, test: string, param: string, staff: { order: string; enter: string; verify: string }, opts: { verify?: boolean } = {}) {
    const o = (await rpc("create_lab_order", { p_clinic_id: clinic, p_patient_id: patient, p_ordered_by: staff.order, p_source: "walk_in", p_test_ids: [test], p_panel_ids: [] })) as Array<{ lab_order_id: string }>;
    const { data: item } = await admin.from("lab_order_items").select("id").eq("order_id", o[0].lab_order_id).single();
    const s = (await rpc("collect_lab_sample", { p_clinic_id: clinic, p_order_id: o[0].lab_order_id, p_item_ids: [item!.id], p_collected_by: staff.enter })) as Array<{ lab_sample_id: string }>;
    await rpc("receive_lab_sample", { p_clinic_id: clinic, p_sample_id: s[0].lab_sample_id, p_received_by: staff.enter });
    const r = (await rpc("save_lab_result_draft", { p_clinic_id: clinic, p_order_item_id: item!.id, p_entered_by: staff.enter, p_values: [{ parameter_id: param, value_numeric: 140 }] })) as Array<{ lab_result_id: string }>;
    await rpc("submit_lab_result", { p_clinic_id: clinic, p_result_id: r[0].lab_result_id, p_submitted_by: staff.enter });
    if (opts.verify !== false) await rpc("verify_lab_result", { p_clinic_id: clinic, p_result_id: r[0].lab_result_id, p_verified_by: staff.verify });
    return { order: o[0].lab_order_id, item: item!.id as string, result: r[0].lab_result_id, sample: s[0].lab_sample_id };
  }

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    await admin.from("clinics").insert([
      { id: clinicA, name: `Red A ${suffix}`, slug: `red-a-${suffix}`, timezone: "Asia/Tashkent" },
      { id: clinicB, name: `Red B ${suffix}`, slug: `red-b-${suffix}`, timezone: "Asia/Tashkent" },
    ]);
    for (const [name, id] of Object.entries(people)) {
      const { error } = await admin.auth.admin.createUser({ id, email: `red-${name}-${suffix}@test.local`, email_confirm: true, password: `Pw-${randomUUID()}` });
      if (error) throw new Error(error.message);
      await admin.from("profiles").insert({ id, full_name: name });
    }
    await admin.from("staff_roles").insert([
      { clinic_id: clinicA, profile_id: people.owner, role: "owner" },
      { clinic_id: clinicA, profile_id: people.manager, role: "manager" },
      { clinic_id: clinicA, profile_id: people.reception, role: "receptionist" },
      { clinic_id: clinicA, profile_id: people.lab1, role: "lab" },
      { clinic_id: clinicA, profile_id: people.lab2, role: "lab" },
      { clinic_id: clinicA, profile_id: people.drA, role: "doctor" },
      { clinic_id: clinicB, profile_id: people.labB, role: "lab" },
      { clinic_id: clinicB, profile_id: people.labB2, role: "lab" },
      { clinic_id: clinicB, profile_id: people.ownerB, role: "owner" },
    ]);
    await admin.from("doctors").insert({ id: doctorA, clinic_id: clinicA, profile_id: people.drA, name: `Dr A ${suffix}`, active: true });
    await admin.from("services").insert({ id: service, clinic_id: clinicA, name: `Red consult ${suffix}`, duration_minutes: 30, price: 1 });

    const { data: tA } = await admin.from("lab_tests").insert({ clinic_id: clinicA, code: `REDA${suffix}`, name: "Red test A", sample_type: "Qon", price: 50000 }).select("id").single();
    const { data: pA } = await admin.from("lab_test_parameters").insert({ clinic_id: clinicA, test_id: tA!.id, code: "HGB", name: "Gemoglobin", value_type: "numeric", unit: "g/L" }).select("id").single();
    const { data: tB } = await admin.from("lab_tests").insert({ clinic_id: clinicB, code: `REDB${suffix}`, name: "Red test B", sample_type: "Qon", price: 70000 }).select("id").single();
    const { data: pB } = await admin.from("lab_test_parameters").insert({ clinic_id: clinicB, test_id: tB!.id, code: "HGB", name: "Gemoglobin", value_type: "numeric", unit: "g/L" }).select("id").single();
    Object.assign(A, { test: tA!.id, param: pA!.id });
    Object.assign(B, { test: tB!.id, param: pB!.id });
    const { data: xa } = await admin.from("patients").insert({ clinic_id: clinicA, full_name: `Red X ${suffix}`, date_of_birth: "1980-01-01" }).select("id").single();
    const { data: yb } = await admin.from("patients").insert({ clinic_id: clinicB, full_name: `Red Y ${suffix}`, date_of_birth: "1981-01-01" }).select("id").single();
    A.patient = xa!.id;
    B.patient = yb!.id;
    const start = new Date(Date.UTC(2023, 0, 3, 5, 0));
    await admin.from("appointments").insert({ clinic_id: clinicA, patient_id: A.patient, doctor_id: doctorA, service_id: service, start_at: start.toISOString(), end_at: new Date(start.getTime() + 1_800_000).toISOString(), status: "completed", source: "walk_in" });

    Object.assign(A, await chain(clinicA, A.patient, A.test, A.param, { order: people.reception, enter: people.lab1, verify: people.lab2 }));
    Object.assign(B, await chain(clinicB, B.patient, B.test, B.param, { order: people.labB, enter: people.labB, verify: people.labB2 }));
    // Clinic B's document row and import batch, targets for guessed ids.
    const { data: doc } = await admin.from("lab_documents").insert({ clinic_id: clinicB, patient_id: B.patient, result_id: B.result, kind: "report", storage_path: `${clinicB}/${randomUUID()}`, mime_type: "application/pdf", size_bytes: 10, sha256: "b".repeat(64), uploaded_by: people.labB }).select("id").single();
    B.document = doc?.id ?? randomUUID();
    const { data: batch } = await admin.from("lab_import_batches").insert({ clinic_id: clinicB, source_system: "old", file_name: "b.csv", file_sha256: "c".repeat(64), status: "uploaded", headers: ["patient"], row_count: 1, summary: {}, created_by: people.labB }).select("id").single();
    B.batch = batch?.id ?? randomUUID();
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin.from("clinics").delete().in("id", [clinicA, clinicB]);
    for (const id of Object.values(people)) await admin.auth.admin.deleteUser(id);
  });

  it("F3: a cross-site JSON write is refused on every lab write route — before anything is read or changed", async () => {
    as(people.lab1, "lab");
    const attempts: Array<[string, Promise<Response>]> = [
      ["create order", createOrder(send("/api/lab/orders", "POST", { idempotencyKey: randomUUID(), patientId: A.patient, testIds: [A.test] }, EVIL))],
      ["save result", saveResult(send(`/api/lab/items/${A.item}/result`, "PUT", { values: [] }, EVIL), params({ id: A.item }))],
      ["verify result", resultAction(send(`/api/lab/results/${A.result}`, "POST", { action: "verify" }, EVIL), params({ id: A.result }))],
      ["receive sample", sampleAction(send(`/api/lab/samples/${A.sample}`, "POST", { action: "receive" }, EVIL), params({ id: A.sample }))],
      ["mark notifications read", notificationsAction(send("/api/staff/notifications", "POST", { action: "read" }, EVIL))],
    ];
    for (const [label, attempt] of attempts) {
      const { status, body } = await read(await attempt);
      expect([status, body.code], label).toEqual([403, "cross_site_request"]);
    }
    as(people.owner, "owner");
    for (const [label, attempt] of [
      ["record payment", pay(send(`/api/admin/lab/orders/${A.order}/payment`, "POST", { status: "paid", method: "cash" }, EVIL), params({ id: A.order }))],
      ["change settings", settingsPut(send("/api/admin/lab/settings", "PUT", { paymentPolicy: "not_required", releaseToPatient: true, verifiers: "lab_and_doctor" }, EVIL))],
    ] as const) {
      const { status, body } = await read(await attempt);
      expect([status, body.code], label).toEqual([403, "cross_site_request"]);
    }
    const { data: payment } = await admin.from("payments").select("status").eq("lab_order_id", A.order).single();
    expect(payment!.status).toBe("unpaid");
    // The same request from the site itself gets past the origin check.
    as(people.owner, "owner");
    const same = await read(await settingsGet());
    expect(same.status).toBe(200);
  });

  it("8: without a session every lab route refuses", async () => {
    session.ctx = null;
    const calls: Array<Promise<Response>> = [
      queue(),
      labDashboard(),
      resultEntry(get(`/api/lab/items/${A.item}/result`), params({ id: A.item })),
      document(get(`/api/lab/documents/${B.document}`), params({ id: B.document })),
      importBatch(get(`/api/lab/imports/${B.batch}`), params({ id: B.batch })),
      payments(get("/api/admin/lab/payments")),
      settingsGet(),
      providers(),
      labAnalytics(get("/api/admin/analytics/lab")),
      labHistory(get(`/api/doctor/patients/${A.patient}/lab-history`), params({ id: A.patient })),
      labSummary(get(`/api/doctor/patients/${A.patient}/lab-summary`), params({ id: A.patient })),
      doctorResult(get(`/api/doctor/patients/${A.patient}/lab-results/${A.item}`), params({ id: A.patient, itemId: A.item })),
      createOrder(send("/api/lab/orders", "POST", { idempotencyKey: randomUUID(), patientId: A.patient, testIds: [A.test] })),
      resultAction(send(`/api/lab/results/${A.result}`, "POST", { action: "verify" }), params({ id: A.result })),
      pay(send(`/api/admin/lab/orders/${A.order}/payment`, "POST", { status: "paid", method: "cash" }), params({ id: A.order })),
    ];
    for (const res of await Promise.all(calls)) expect(res.status).toBe(401);
  });

  it("1 / 2: clinic A's staff with clinic B's ids get 404 everywhere, and nothing of clinic B changes", async () => {
    as(people.lab1, "lab");
    const labAttempts = await Promise.all([
      resultEntry(get(`/api/lab/items/${B.item}/result`), params({ id: B.item })),
      saveResult(send(`/api/lab/items/${B.item}/result`, "PUT", { values: [{ parameterId: B.param, value: "1" }] }), params({ id: B.item })),
      resultAction(send(`/api/lab/results/${B.result}`, "POST", { action: "correct", reason: "x" }), params({ id: B.result })),
      sampleAction(send(`/api/lab/samples/${B.sample}`, "POST", { action: "reject", reason: "x" }), params({ id: B.sample })),
      collect(send(`/api/lab/orders/${B.order}/samples`, "POST", { itemIds: [B.item], idempotencyKey: randomUUID() }), params({ id: B.order })),
      document(get(`/api/lab/documents/${B.document}`), params({ id: B.document })),
      importBatch(get(`/api/lab/imports/${B.batch}`), params({ id: B.batch })),
      sendOut(send(`/api/lab/items/${B.item}/send-out`, "POST", { providerId: randomUUID() }), params({ id: B.item })),
    ]);
    for (const res of labAttempts) expect([403, 404]).toContain(res.status);
    as(people.owner, "owner");
    expect((await pay(send(`/api/admin/lab/orders/${B.order}/payment`, "POST", { status: "paid", method: "cash" }), params({ id: B.order }))).status).toBe(404);
    as(people.drA, "doctor");
    expect((await labHistory(get(`/api/doctor/patients/${B.patient}/lab-history`), params({ id: B.patient }))).status).toBe(404);
    expect((await labSummary(get(`/api/doctor/patients/${B.patient}/lab-summary`), params({ id: B.patient }))).status).toBe(404);
    expect((await doctorResult(get(`/api/doctor/patients/${A.patient}/lab-results/${B.item}`), params({ id: A.patient, itemId: B.item }))).status).toBe(404);
    // Clinic B is untouched.
    const { data: rB } = await admin.from("lab_results").select("status").eq("order_item_id", B.item);
    expect(rB!.map((r) => r.status)).toEqual(["verified"]);
    const { data: pB } = await admin.from("payments").select("status").eq("lab_order_id", B.order).single();
    expect(pB!.status).toBe("unpaid");
    const { data: sB } = await admin.from("lab_samples").select("status").eq("id", B.sample).single();
    expect(sB!.status).toBe("received");
    // And the queue / dashboard of A never lists B's work.
    as(people.lab1, "lab");
    expect(JSON.stringify((await read(await queue())).body)).not.toContain(B.order);
  });

  it("modified bodies: a clinic id, price or amount in the request is ignored; another clinic's patient or test is refused", async () => {
    as(people.reception, "receptionist");
    const forged = await read(await createOrder(send("/api/lab/orders", "POST", { idempotencyKey: randomUUID(), patientId: A.patient, testIds: [A.test], clinicId: clinicB, price: 1, prices: { [A.test]: 1 }, orderedBy: people.owner })));
    expect(forged.status).toBe(201);
    const orderId = (forged.body.data as { orderId?: string; order_id?: string; lab_order_id?: string }).orderId ?? (forged.body.data as { lab_order_id?: string }).lab_order_id;
    const { data: order } = await admin.from("lab_orders").select("clinic_id, ordered_by").eq("id", orderId!).single();
    expect(order).toEqual({ clinic_id: clinicA, ordered_by: people.reception });
    const { data: item } = await admin.from("lab_order_items").select("price_snapshot").eq("order_id", orderId!).single();
    expect(Number(item!.price_snapshot)).toBe(50000);
    expect((await createOrder(send("/api/lab/orders", "POST", { idempotencyKey: randomUUID(), patientId: B.patient, testIds: [A.test] }))).status).toBe(404);
    expect([400, 404]).toContain((await createOrder(send("/api/lab/orders", "POST", { idempotencyKey: randomUUID(), patientId: A.patient, testIds: [B.test] }))).status);
    // A payment with a forged amount: the stored amount stays.
    as(people.owner, "owner");
    const paid = await pay(send(`/api/admin/lab/orders/${orderId}/payment`, "POST", { status: "paid", method: "cash", amount: 1, currency: "USD" }), params({ id: orderId! }));
    expect(paid.status).toBe(200);
    const { data: payment } = await admin.from("payments").select("status, amount, currency").eq("lab_order_id", orderId!).single();
    expect(payment).toMatchObject({ status: "paid", amount: 50000, currency: "UZS" });
  });

  it("9: payment state cannot be forged by other roles; repeated and concurrent payments transition once", async () => {
    for (const [id, role] of [[people.reception, "receptionist"], [people.manager, "manager"], [people.lab1, "lab"], [people.drA, "doctor"]] as const) {
      as(id, role);
      expect((await pay(send(`/api/admin/lab/orders/${A.order}/payment`, "POST", { status: "paid", method: "cash" }), params({ id: A.order }))).status).toBe(403);
    }
    as(people.owner, "owner");
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => pay(send(`/api/admin/lab/orders/${A.order}/payment`, "POST", { status: "paid", method: "cash" }), params({ id: A.order }))));
    expect(results.every((r) => r.status === 200 || r.status === 409)).toBe(true);
    const { data: audits } = await admin.from("audit_events").select("id").eq("clinic_id", clinicA).eq("action", "payment_status_changed").eq("entity_type", "payments").filter("metadata->>to", "eq", "paid");
    const { data: payment } = await admin.from("payments").select("id, status").eq("lab_order_id", A.order).single();
    expect(payment!.status).toBe("paid");
    const { data: mine } = await admin.from("audit_events").select("id").eq("entity_id", payment!.id).eq("action", "payment_status_changed");
    expect(mine).toHaveLength(1);
    void audits;
  });

  it("5 / 6: roles stay within their purpose", async () => {
    // Reception: status, never values or documents.
    as(people.reception, "receptionist");
    expect((await resultEntry(get(`/api/lab/items/${A.item}/result`), params({ id: A.item }))).status).toBe(403);
    expect((await document(get(`/api/lab/documents/${randomUUID()}`), params({ id: randomUUID() }))).status).toBe(403);
    expect((await labHistory(get(`/api/doctor/patients/${A.patient}/lab-history`), params({ id: A.patient }))).status).toBe(403);
    const q = await read(await queue());
    expect(q.status).toBe(200);
    expect(JSON.stringify(q.body)).not.toMatch(/value_numeric|"140"|Gemoglobin/);
    // Lab staff: no money, no administration, no analytics.
    as(people.lab1, "lab");
    for (const res of await Promise.all([payments(get("/api/admin/lab/payments")), settingsGet(), providers(), labAnalytics(get("/api/admin/analytics/lab"))])) {
      expect(res.status).toBe(403);
    }
    expect((await pay(send(`/api/admin/lab/orders/${A.order}/payment`, "POST", { status: "refunded" }), params({ id: A.order }))).status).toBe(403);
    // Doctors: no clinic-wide queue or dashboard, no Kassa.
    as(people.drA, "doctor");
    for (const res of await Promise.all([queue(), labDashboard(), payments(get("/api/admin/lab/payments"))])) expect(res.status).toBe(403);
    // Manager: analytics without money (F2's server side).
    as(people.manager, "manager");
    const m = await read(await labAnalytics(get("/api/admin/analytics/lab")));
    expect(m.body.data!.finance).toBeNull();
  });
});
