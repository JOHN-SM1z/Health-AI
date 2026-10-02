import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import postgres from "postgres";
import { cleanupTestClinics } from "@/test/cleanup-clinics";
import { localDbAvailable } from "@/test/local-db";

/**
 * Laboratory Kassa and sample collection (phase 5) through the REAL routes, guards and database: the
 * existing payment engine for lab orders (who may confirm/refund, the server-set amount, a failed payment is
 * never "paid", a refund leaves the clinical record alone, the receipt), the clinic's payment-before-collection
 * policy applied by the database, the sample lifecycle, and concurrency (two staff, repeated requests,
 * collect-versus-refund).
 *
 * Mocked: only the staff session lookup (getStaffContext).
 */

const session = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/staff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/staff")>();
  return { ...actual, getStaffContext: async () => session.ctx };
});

import * as kassaList from "@/app/api/admin/lab/kassa/route";
import * as kassaPayment from "@/app/api/admin/lab/kassa/[orderId]/payment/route";
import * as kassaReceipt from "@/app/api/admin/lab/kassa/[orderId]/receipt/route";
import * as worklist from "@/app/api/lab/worklist/route";
import * as orderSamples from "@/app/api/lab/orders/[id]/samples/route";
import * as sampleStep from "@/app/api/lab/samples/[id]/route";
import * as analytics from "@/app/api/admin/analytics/route";
import * as dashboard from "@/app/api/admin/dashboard/route";

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const describeDb = describe.skipIf(!localDbAvailable());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = { ok: boolean; data?: Record<string, any>; code?: string; error?: string };
type Role = "owner" | "admin" | "manager" | "receptionist" | "lab_staff" | "doctor";

describeDb("laboratory Kassa and sample collection — real routes and database", () => {
  let sql: postgres.Sql;
  const suffix = Date.now().toString(36) + Math.floor(Math.random() * 1e4);
  const clinicA = randomUUID();
  const clinicB = randomUUID();
  const users: Record<string, string> = Object.fromEntries(["owner", "admin", "mgr", "rec", "lab", "lab2", "doc", "recB", "ownB", "labB"].map((k) => [k, randomUUID()]));
  const doc = randomUUID();
  const svc = randomUUID();
  const patient = randomUUID();
  const patientB = randomUUID();
  const T: Record<string, string> = {};
  let consult = "";
  let day = 0;
  const NOTE = `Doctor's clinical note ${suffix}`;

  const as = (user: string, role: Role, clinic = clinicA) => {
    session.ctx = { profileId: users[user], clinicId: clinic, clinicName: "Lab", clinicTimezone: "Asia/Tashkent", roles: [role], platformAdmin: false };
  };
  const read = async (res: Response): Promise<{ status: number; body: Json }> => ({ status: res.status, body: (await res.json()) as Json });
  const req = (method: string, path: string, body?: unknown) =>
    new NextRequest(`http://localhost${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const ctx = <K extends string>(key: K, id: string) => ({ params: Promise.resolve({ [key]: id } as Record<K, string>) });

  const kassa = async (filter = "all") => read(await kassaList.GET(req("GET", `/api/admin/lab/kassa?filter=${filter}`)));
  const pay = async (orderId: string, body: unknown) => read(await kassaPayment.POST(req("POST", `/api/admin/lab/kassa/${orderId}/payment`, body), ctx("orderId", orderId)));
  const confirm = (orderId: string, method = "cash") => pay(orderId, { action: "confirm", method });
  const refund = (orderId: string, reason = "patient_request") => pay(orderId, { action: "refund", reason });
  const receipt = async (orderId: string) => read(await kassaReceipt.GET(req("GET", `/api/admin/lab/kassa/${orderId}/receipt`), ctx("orderId", orderId)));
  const work = async () => read(await worklist.GET());
  const prepare = async (orderId: string) => read(await orderSamples.POST(req("POST", `/api/lab/orders/${orderId}/samples`), ctx("id", orderId)));
  const step = async (sampleId: string, body: unknown) => read(await sampleStep.POST(req("POST", `/api/lab/samples/${sampleId}`, body), ctx("id", sampleId)));

  const setPolicy = async (value: unknown) => {
    await sql`delete from public.app_settings where clinic_id = ${clinicA} and key = 'lab'`;
    if (value !== undefined) await sql`insert into public.app_settings (clinic_id, key, value) values (${clinicA}, 'lab', ${sql.json(value as never)})`;
  };
  const requirePayment = (required: boolean) => setPolicy({ verification: { required: true, separateVerifier: false }, collection: { requiresPayment: required }, ordering: { recentTestWindowDays: 30 } });

  async function newOrder(tests: string[] = [T.blood1, T.blood2, T.urine], opts: { patient?: string; priority?: "routine" | "urgent" } = {}) {
    const [row] = await sql<{ r: { order_id: string } }[]>`
      select public.lab_create_order(${clinicA}, ${users.doc}, ${opts.patient ?? patient}, ${doc}, ${consult}, null, ${opts.priority ?? "routine"}, ${NOTE}, ${randomUUID()}, ${sql.json(tests.map((test_id) => ({ test_id })))}) as r`;
    return row.r.order_id;
  }
  const payment = async (orderId: string) => (await sql<{ id: string; status: string; amount: string; metadata: Record<string, unknown> }[]>`select id, status, amount::text, metadata from public.payments where lab_order_id = ${orderId}`)[0];
  const samplesOf = (orderId: string) => sql<{ id: string; status: string; sample_type: string; sample_code: string; collected_by: string | null }[]>`select id, status, sample_type, sample_code, collected_by from public.lab_samples where order_id = ${orderId} order by sample_type`;
  const orderStatus = async (orderId: string) => (await sql<{ status: string }[]>`select status from public.lab_orders where id = ${orderId}`)[0].status;
  /** A sample ready to collect: the order, its samples prepared by the technician. */
  async function orderWithSamples(tests?: string[]) {
    const orderId = await newOrder(tests);
    as("lab", "lab_staff");
    expect((await prepare(orderId)).status).toBe(200);
    return { orderId, samples: await samplesOf(orderId) };
  }

  beforeAll(async () => {
    sql = postgres(DB_URL, { max: 12, onnotice: () => {} });
    await sql`insert into public.clinics ${sql([
      { id: clinicA, name: `Lab Kassa A ${suffix}`, slug: `lab-kassa-a-${suffix}`, timezone: "Asia/Tashkent" },
      { id: clinicB, name: `Lab Kassa B ${suffix}`, slug: `lab-kassa-b-${suffix}`, timezone: "Asia/Tashkent" },
    ])}`;
    const rows = Object.entries(users).map(([k, id]) => ({ id, email: `labkassa-${k}-${suffix}@test.local` }));
    await sql`insert into auth.users ${sql(rows)}`;
    await sql`insert into public.profiles ${sql(rows.map((x) => ({ id: x.id, full_name: x.email })))}`;
    await sql`insert into public.staff_roles ${sql([
      { clinic_id: clinicA, profile_id: users.owner, role: "owner" },
      { clinic_id: clinicA, profile_id: users.admin, role: "admin" },
      { clinic_id: clinicA, profile_id: users.mgr, role: "manager" },
      { clinic_id: clinicA, profile_id: users.rec, role: "receptionist" },
      { clinic_id: clinicA, profile_id: users.lab, role: "lab_staff" },
      { clinic_id: clinicA, profile_id: users.lab2, role: "lab_staff" },
      { clinic_id: clinicA, profile_id: users.doc, role: "doctor" },
      { clinic_id: clinicB, profile_id: users.recB, role: "receptionist" },
      { clinic_id: clinicB, profile_id: users.ownB, role: "owner" },
      { clinic_id: clinicB, profile_id: users.labB, role: "lab_staff" },
    ])}`;
    await sql`insert into public.doctors (id, clinic_id, profile_id, name, active) values (${doc}, ${clinicA}, ${users.doc}, ${`Dr Kassa ${suffix}`}, true)`;
    await sql`insert into public.services (id, clinic_id, name, duration_minutes, price) values (${svc}, ${clinicA}, ${`Kassa ${suffix}`}, 30, 1000)`;
    await sql`insert into public.doctor_working_hours ${sql([1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinic_id: clinicA, doctor_id: doc, weekday, start_time: "00:00", end_time: "23:59" })))}`;
    await sql`insert into public.patients ${sql([
      { id: patient, clinic_id: clinicA, full_name: `Kassa patient ${suffix}` },
      { id: patientB, clinic_id: clinicB, full_name: `Kassa patient B ${suffix}` },
    ])}`;
    const start = new Date(Date.UTC(2033, 2, 1 + day++, 5, 0));
    [{ id: consult }] = await sql<{ id: string }[]>`insert into public.appointments ${sql({
      clinic_id: clinicA, patient_id: patient, doctor_id: doc, service_id: svc, start_at: start,
      end_at: new Date(start.getTime() + 30 * 60_000), status: "in_progress", source: "walk_in",
    })} returning id`;
    const ins = async (row: Record<string, unknown>) => (await sql<{ id: string }[]>`insert into public.lab_tests ${sql(row as never)} returning id`)[0].id;
    T.blood1 = await ins({ clinic_id: clinicA, code: `K1-${suffix}`, name: "Blood one", price: 10000, sample_type: "blood" });
    T.blood2 = await ins({ clinic_id: clinicA, code: `K2-${suffix}`, name: "Blood two", price: 20000, sample_type: "blood" });
    T.urine = await ins({ clinic_id: clinicA, code: `K3-${suffix}`, name: "Urine one", price: 5000, sample_type: "urine" });
    T.bare = await ins({ clinic_id: clinicA, code: `K4-${suffix}`, name: "No sample type", price: 7000, sample_type: null });
  });

  afterAll(async () => {
    if (!sql) return;
    await cleanupTestClinics([clinicA, clinicB]);
    await sql`delete from auth.users where id in ${sql(Object.values(users))}`;
    await sql.end({ timeout: 5 });
  });

  // ------------------------------------------------------------------ Kassa

  it("Kassa roles: the cashier roles confirm, owner/admin refund, manager only reads, the bench and doctors have no Kassa", async () => {
    const orderId = await newOrder();
    for (const [user, role, canRead] of [["owner", "owner", true], ["admin", "admin", true], ["mgr", "manager", true], ["rec", "receptionist", true], ["lab", "lab_staff", false], ["doc", "doctor", false]] as const) {
      as(user, role);
      expect((await kassa()).status, `${role} list`).toBe(canRead ? 200 : 403);
      expect((await receipt(orderId)).status, `${role} receipt (unpaid → 409 or refused)`).toBe(canRead ? 409 : 403);
    }
    for (const [user, role] of [["mgr", "manager"], ["lab", "lab_staff"], ["doc", "doctor"]] as const) {
      as(user, role);
      expect((await confirm(orderId)).status, `${role} confirm`).toBe(403);
    }
    session.ctx = null;
    expect((await kassa()).status).toBe(401);
    expect((await confirm(orderId)).status).toBe(401);
    expect((await pay(orderId, { action: "confirm" })).status, "a bad body does not reveal anything before who is asking").toBe(401);
    expect((await payment(orderId)).status).toBe("unpaid");
    // Confirming is for owner/admin/receptionist, refunding for owner/admin.
    as("rec", "receptionist");
    expect((await confirm(orderId)).status).toBe(200);
    expect((await refund(orderId)).status, "a receptionist cannot refund").toBe(403);
    as("mgr", "manager");
    expect((await refund(orderId)).status).toBe(403);
    expect((await payment(orderId)).status).toBe("paid");
    as("admin", "admin");
    expect((await refund(orderId)).status).toBe(200);
  });

  it("confirming records the payment through the existing engine: amount from the server, audited, idempotent, nothing client-settable", async () => {
    const orderId = await newOrder([T.blood1, T.urine]); // 15000
    as("rec", "receptionist");
    const listed = (await kassa("unpaid")).body.data!.orders.find((o: { orderId: string }) => o.orderId === orderId);
    expect(listed).toMatchObject({ orderStatus: "ordered", payment: { status: "unpaid", amount: 15000, currency: "UZS" }, patient: { fullName: `Kassa patient ${suffix}` } });
    expect(JSON.stringify(listed)).not.toContain(NOTE);
    // The desk list carries a count, never the tests' names (a test name can itself be sensitive).
    expect(listed.itemCount).toBe(2);
    expect(JSON.stringify(listed)).not.toMatch(/Blood one|Urine one|Blood two/);
    expect(listed).not.toHaveProperty("items");
    // Whatever the request claims about money is refused, not ignored.
    for (const extra of [{ amount: 1 }, { status: "paid" }, { paid: true }, { currency: "USD" }, { clinicId: clinicB }, { patientId: randomUUID() }]) {
      expect((await pay(orderId, { action: "confirm", method: "cash", ...extra })).status, JSON.stringify(extra)).toBe(400);
    }
    expect((await pay(orderId, { action: "confirm" })).status).toBe(400);
    expect((await pay(orderId, { action: "confirm", method: "bitcoin" })).status).toBe(400);
    expect((await pay(orderId, { action: "mark_paid", method: "cash" })).status).toBe(400);
    expect((await payment(orderId)).status).toBe("unpaid");

    const res = await confirm(orderId, "card");
    expect(res).toMatchObject({ status: 200, body: { data: { alreadyInState: false } } });
    const p = await payment(orderId);
    expect(p).toMatchObject({ status: "paid", amount: "15000.00" });
    expect(p.metadata).toMatchObject({ manual_confirmation: true, method: "card", provider: "manual" });
    const [paidBy] = await sql<{ paid_by: string; paid_at: string }[]>`select paid_by, paid_at from public.payments where id = ${p.id}`;
    expect(paidBy.paid_by).toBe(users.rec);
    expect(paidBy.paid_at).toBeTruthy();
    // Audit: the engine's payment trail plus the order-side trail, ids and the coded method only.
    const trail = await sql<{ action: string; actor_id: string; patient_id: string | null; metadata: Record<string, unknown>; new_values: unknown }[]>`
      select action, actor_id, patient_id, metadata, new_values from public.audit_events
       where (entity_id = ${p.id} and action = 'payment_status_changed') or (entity_id = ${orderId} and action = 'lab_payment_confirmed')`;
    expect(trail.map((t) => t.action).sort()).toEqual(["lab_payment_confirmed", "payment_status_changed"]);
    expect(trail.find((t) => t.action === "lab_payment_confirmed")).toMatchObject({ actor_id: users.rec, patient_id: patient, metadata: { payment_id: p.id, method: "card" } });
    expect(JSON.stringify(trail)).not.toContain(NOTE);

    // A repeat is not an error and not a second change.
    expect(await confirm(orderId)).toMatchObject({ status: 200, body: { data: { alreadyInState: true } } });
    expect((await sql`select 1 from public.audit_events where entity_id = ${orderId} and action = 'lab_payment_confirmed'`)).toHaveLength(1);
    // Listed as paid now.
    expect((await kassa("paid")).body.data!.orders.some((o: { orderId: string }) => o.orderId === orderId)).toBe(true);
    expect((await kassa("unpaid")).body.data!.orders.some((o: { orderId: string }) => o.orderId === orderId)).toBe(false);
  });

  it("a failed or pending payment is shown as it is — never as paid — and the order carries on correctly", async () => {
    as("rec", "receptionist");
    const orderId = await newOrder();
    const p = await payment(orderId);
    await sql`update public.payments set status = 'failed' where id = ${p.id}`;
    expect((await confirm(orderId))).toMatchObject({ status: 409, body: { code: "invalid_transition" } });
    const row = (await kassa("unpaid")).body.data!.orders.find((o: { orderId: string }) => o.orderId === orderId);
    expect(row).toMatchObject({ orderStatus: "ordered", payment: { status: "failed" } });
    expect((await receipt(orderId)).status, "no receipt for a payment that did not happen").toBe(409);
    // A payment under review can be confirmed; a failed one has to be retried first (the engine's rule).
    await sql`update public.payments set status = 'manual_review' where id = ${p.id}`;
    expect((await confirm(orderId)).status).toBe(200);
  });

  it("a cancelled order takes no payment; another clinic's order is simply not found", async () => {
    as("rec", "receptionist");
    const orderId = await newOrder();
    await sql`update public.lab_orders set status = 'cancelled', cancelled_by = ${users.owner}, cancel_reason = 'test' where id = ${orderId}`;
    expect(await confirm(orderId)).toMatchObject({ status: 409, body: { code: "order_cancelled" } });
    expect((await payment(orderId)).status).toBe("unpaid");
    // Not owed, so not work to collect — but still listed, truthfully, under "all".
    expect((await kassa("unpaid")).body.data!.orders.some((o: { orderId: string }) => o.orderId === orderId)).toBe(false);
    expect((await kassa("all")).body.data!.orders.find((o: { orderId: string }) => o.orderId === orderId)).toMatchObject({ orderStatus: "cancelled", payment: { status: "unpaid" } });

    const other = await newOrder();
    as("recB", "receptionist", clinicB);
    expect((await confirm(other)).status).toBe(404);
    expect((await receipt(other)).status).toBe(404);
    as("ownB", "owner", clinicB);
    expect((await refund(other)).status).toBe(404);
    expect((await confirm(randomUUID())).status).toBe(404);
    expect((await confirm("not-a-uuid")).status).toBe(404);
    expect((await kassa()).body.data!.orders).toHaveLength(0);
    expect((await payment(other)).status).toBe("unpaid");
  });

  it("refund: paid → refunded by owner/admin, once; the order, samples and history are untouched and the payment shows the truth", async () => {
    const { orderId, samples } = await orderWithSamples();
    as("rec", "receptionist");
    expect((await refund(orderId)).status, "unpaid cannot be refunded").toBe(403); // receptionist: not allowed at all
    as("owner", "owner");
    expect((await refund(orderId))).toMatchObject({ status: 409, body: { code: "invalid_transition" } });
    as("rec", "receptionist");
    await confirm(orderId);
    // The sample is collected, THEN the payment is refunded: the record is not rewritten.
    as("lab", "lab_staff");
    expect((await step(samples[0].id, { action: "collect" })).status).toBe(200);
    as("owner", "owner");
    for (const bad of [{ action: "refund" }, { action: "refund", reason: "because" }, { action: "refund", reason: "other", amount: 5 }]) {
      expect((await pay(orderId, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(await refund(orderId, "duplicate_payment")).toMatchObject({ status: 200, body: { data: { alreadyInState: false } } });
    expect(await refund(orderId)).toMatchObject({ status: 200, body: { data: { alreadyInState: true } } });
    expect((await payment(orderId)).status).toBe("refunded");
    expect(await orderStatus(orderId)).toBe("in_progress");
    expect((await samplesOf(orderId)).map((s) => s.status).sort()).toEqual(["awaiting_collection", "collected"]);
    const r = (await receipt(orderId)).body.data!.receipt;
    expect(r).toMatchObject({ status: "refunded", refunded: true, fiscal: false });
    const trail = await sql<{ metadata: Record<string, unknown> }[]>`select metadata from public.audit_events where entity_id = ${orderId} and action = 'lab_payment_refunded'`;
    expect(trail).toHaveLength(1);
    expect(trail[0].metadata).toMatchObject({ reason: "duplicate_payment" });
    // Refunded is final: it cannot be paid again.
    as("rec", "receptionist");
    expect((await confirm(orderId)).status).toBe(409);
  });

  it("the receipt: what was bought and the server's amount, labelled as not fiscal — and never the doctor's note or a result", async () => {
    const orderId = await newOrder([T.blood1, T.blood2]);
    as("rec", "receptionist");
    expect((await receipt(orderId)).status).toBe(409);
    await confirm(orderId, "transfer");
    const res = await receipt(orderId);
    expect(res.status).toBe(200);
    const r = res.body.data!.receipt;
    expect(r).toMatchObject({
      fiscal: false,
      clinic: { name: `Lab Kassa A ${suffix}` },
      patient: { fullName: `Kassa patient ${suffix}` },
      orderId,
      amount: 30000,
      currency: "UZS",
      status: "paid",
      method: "transfer",
      refunded: false,
    });
    expect(r.disclaimer).toMatch(/Fiskal chek emas/);
    expect(r.number).toMatch(/^[0-9A-F]{8}$/);
    expect(r.items.map((i: { name: string }) => i.name).sort()).toEqual(["Blood one", "Blood two"]);
    expect(r.paidAt).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toContain(NOTE);
    // The receipt of another clinic's staff is not available either.
    as("recB", "receptionist", clinicB);
    expect((await receipt(orderId)).status).toBe(404);
  });

  it("concurrent Kassa actions resolve to one outcome: six confirms are one payment and one audit row; a confirm racing a refund ends legally", async () => {
    const orderId = await newOrder();
    as("rec", "receptionist");
    const burst = await Promise.all(Array.from({ length: 6 }, () => confirm(orderId)));
    expect(burst.every((r) => r.status === 200 || (r.status === 409 && r.body.code === "payment_changed"))).toBe(true);
    expect(burst.filter((r) => r.status === 200 && r.body.data!.alreadyInState === false)).toHaveLength(1);
    expect((await payment(orderId)).status).toBe("paid");
    expect((await sql`select 1 from public.audit_events where entity_id = ${orderId} and action = 'lab_payment_confirmed'`)).toHaveLength(1);

    // Confirm and refund together on a paid-or-not payment: whatever order they land in, the end state is legal.
    for (let i = 0; i < 4; i++) {
      const racing = await newOrder([T.urine]);
      as("owner", "owner");
      const [c, r] = await Promise.all([confirm(racing), refund(racing)]);
      const final = (await payment(racing)).status;
      expect(["paid", "refunded"]).toContain(final);
      expect([200, 409]).toContain(c.status);
      expect([200, 409]).toContain(r.status);
      if (final === "refunded") expect(r.status).toBe(200);
      if (final === "paid") expect(r.status).toBe(409);
    }
  });

  it("finance: lab money is reported beside the appointment figures, never inside them — and only to those who may see money", async () => {
    const summary = async () => {
      const res = await read(await analytics.GET(req("GET", "/api/admin/analytics?range=365")));
      expect(res.status).toBe(200);
      return res.body.data!;
    };
    as("owner", "owner");
    const before = await summary();
    expect(before.laboratory).toMatchObject({ paid: expect.any(Number), unpaid: expect.any(Number), refunded: expect.any(Number) });
    const orderId = await newOrder([T.blood1, T.blood2]); // 30000
    let after = await summary();
    expect(after.laboratory.unpaid).toBe(before.laboratory.unpaid + 30000);
    as("rec", "receptionist");
    await confirm(orderId);
    as("owner", "owner");
    // A cancelled, unpaid order is not money owed.
    const abandoned = await newOrder([T.urine]);
    await sql`update public.lab_orders set status = 'cancelled', cancelled_by = ${users.owner}, cancel_reason = 'test' where id = ${abandoned}`;
    after = await summary();
    expect(after.laboratory.paid).toBe(before.laboratory.paid + 30000);
    expect(after.laboratory.unpaid).toBe(before.laboratory.unpaid);
    // The appointment-based figures mean what they always meant.
    for (const key of ["total_revenue", "unpaid_total", "pending_total", "refunded_total", "total", "completed", "average_ticket"]) {
      expect(after[key], key).toEqual(before[key]);
    }
    expect(JSON.stringify(after.recent_payments)).not.toContain(orderId);
    await refund(orderId);
    expect((await summary()).laboratory.refunded).toBe(before.laboratory.refunded + 30000);
    // Management without money rights sees no lab money; the dashboard still works with lab payments present.
    as("mgr", "manager");
    expect((await summary()).laboratory).toBeNull();
    as("owner", "owner");
    expect((await read(await dashboard.GET())).status).toBe(200);
  });

  // ------------------------------------------------------------------ the bench

  it("the bench is for laboratory staff only: no other role reaches the worklist or any sample step", async () => {
    const { orderId, samples } = await orderWithSamples();
    for (const [user, role] of [["owner", "owner"], ["admin", "admin"], ["mgr", "manager"], ["rec", "receptionist"], ["doc", "doctor"]] as const) {
      as(user, role);
      expect((await work()).status, `${role} worklist`).toBe(403);
      expect((await prepare(orderId)).status, `${role} prepare`).toBe(403);
      expect((await step(samples[0].id, { action: "collect" })).status, `${role} collect`).toBe(403);
    }
    session.ctx = null;
    expect((await work()).status).toBe(401);
    expect((await step(samples[0].id, { action: "collect" })).status).toBe(401);
    expect((await samplesOf(orderId)).every((s) => s.status === "awaiting_collection")).toBe(true);
  });

  it("samples are prepared per sample type, once: grouped, coded, idempotent, none for a closed order, none across clinics", async () => {
    const orderId = await newOrder([T.blood1, T.blood2, T.urine, T.bare]);
    as("lab", "lab_staff");
    expect(await prepare(orderId)).toMatchObject({ status: 200, body: { data: { created: 3 } } }); // blood, urine, "boshqa"
    const samples = await samplesOf(orderId);
    expect(samples.map((s) => s.sample_type).sort()).toEqual(["blood", "boshqa", "urine"]);
    expect(new Set(samples.map((s) => s.sample_code)).size).toBe(3);
    expect(samples.every((s) => /^S\d{6}-[A-HJKMNP-Z2-9]{5}$/.test(s.sample_code) && s.status === "awaiting_collection")).toBe(true);
    const attached = await sql<{ n: number }[]>`select count(*)::int as n from public.lab_sample_items where order_id = ${orderId}`;
    expect(attached[0].n).toBe(4);
    // Twice is the same thing; nothing duplicates.
    expect(await prepare(orderId)).toMatchObject({ status: 200, body: { data: { created: 0 } } });
    expect(await samplesOf(orderId)).toHaveLength(3);
    // Concurrent preparation: still one set.
    const raced = await newOrder([T.blood1, T.urine]);
    const results = await Promise.all(Array.from({ length: 5 }, () => prepare(raced)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.reduce((n, r) => n + Number(r.body.data!.created), 0)).toBe(2);
    expect(await samplesOf(raced)).toHaveLength(2);
    // Audited by the database, ids only.
    const created = await sql<{ new_values: unknown }[]>`select new_values from public.audit_events where action = 'lab_sample_created' and entity_id in ${sql(samples.map((s) => s.id))}`;
    expect(created).toHaveLength(3);
    expect(JSON.stringify(created)).not.toContain(NOTE);

    // A cancelled order gets no sample; another clinic's order and a made-up id are not found.
    const cancelled = await newOrder();
    await sql`update public.lab_orders set status = 'cancelled', cancelled_by = ${users.owner}, cancel_reason = 'test' where id = ${cancelled}`;
    expect(await prepare(cancelled)).toMatchObject({ status: 409, body: { code: "order_closed" } });
    expect(await samplesOf(cancelled)).toHaveLength(0);
    as("labB", "lab_staff", clinicB);
    expect((await prepare(orderId)).status).toBe(404);
    expect((await prepare(randomUUID())).status).toBe(404);
    expect((await prepare("nope")).status).toBe(404);
    expect((await step(samples[0].id, { action: "collect" })).status, "another clinic's sample").toBe(404);
  });

  it("collection without a payment policy: one collector wins, a repeat is harmless, another member of staff gets a 409", async () => {
    await setPolicy(undefined);
    const { orderId, samples } = await orderWithSamples();
    as("lab", "lab_staff");
    expect(await step(samples[0].id, { action: "collect" })).toMatchObject({ status: 200, body: { data: { status: "collected", unchanged: false } } });
    expect(await orderStatus(orderId)).toBe("in_progress");
    const [s] = await sql<{ collected_by: string; collected_at: string }[]>`select collected_by, collected_at from public.lab_samples where id = ${samples[0].id}`;
    expect(s.collected_by).toBe(users.lab);
    expect(s.collected_at).toBeTruthy();
    expect(await step(samples[0].id, { action: "collect" })).toMatchObject({ status: 200, body: { data: { unchanged: true } } });
    as("lab2", "lab_staff");
    expect(await step(samples[0].id, { action: "collect" })).toMatchObject({ status: 409, body: { code: "already_collected" } });
    expect((await sql<{ collected_by: string }[]>`select collected_by from public.lab_samples where id = ${samples[0].id}`)[0].collected_by).toBe(users.lab);
    // The step names no actor, clinic or timestamp, and unknown actions are refused.
    for (const body of [{ action: "collect", collectedBy: users.lab2 }, { action: "collect", clinicId: clinicB }, { action: "done" }, {}, { action: "reject" }, { action: "reject", reason: "x" }]) {
      expect((await step(samples[1].id, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await samplesOf(orderId)).find((x) => x.id === samples[1].id)!.status).toBe("awaiting_collection");
  });

  it("two staff collecting the same sample at once, and one member repeating the request many times, end in exactly one collection", async () => {
    await setPolicy(undefined);
    const { samples } = await orderWithSamples();
    const target = samples[0].id;
    // The session is read when a route starts (synchronously), so each arm runs as its own member of staff.
    const collectAs = (user: string) => {
      as(user, "lab_staff");
      return step(target, { action: "collect" });
    };
    const [a, b] = await Promise.all([collectAs("lab"), collectAs("lab2")]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect([a, b].find((r) => r.status === 409)!.body.code).toBe("already_collected");
    const rows = await sql<{ status: string; collected_by: string }[]>`select status, collected_by from public.lab_samples where id = ${target}`;
    expect(rows[0].status).toBe("collected");
    expect([users.lab, users.lab2]).toContain(rows[0].collected_by);
    expect((await sql`select 1 from public.audit_events where action = 'lab_sample_collected' and entity_id = ${target}`)).toHaveLength(1);

    // The same member repeating: one collection, the rest report "unchanged".
    const { samples: second } = await orderWithSamples();
    as("lab", "lab_staff");
    const burst = await Promise.all(Array.from({ length: 8 }, () => step(second[0].id, { action: "collect" })));
    expect(burst.every((r) => r.status === 200)).toBe(true);
    expect(burst.filter((r) => r.body.data!.unchanged === false)).toHaveLength(1);
    expect((await sql`select 1 from public.audit_events where action = 'lab_sample_collected' and entity_id = ${second[0].id}`)).toHaveLength(1);
  });

  it("payment before collection is the clinic's setting, applied by the database against the payment's REAL status", async () => {
    await requirePayment(true);
    try {
      const { orderId, samples } = await orderWithSamples();
      as("lab", "lab_staff");
      const w = (await work()).body.data!;
      expect(w.requiresPayment).toBe(true);
      expect(w.orders.find((o: { orderId: string }) => o.orderId === orderId)).toMatchObject({ readiness: "awaiting_payment", paymentStatus: "unpaid" });
      // Unpaid, pending, failed, under review, refunded: none of them is "paid".
      for (const status of ["unpaid", "pending", "failed", "manual_review"]) {
        await sql`update public.payments set status = ${status}::public.payment_status where lab_order_id = ${orderId}`;
        expect(await step(samples[0].id, { action: "collect" }), status).toMatchObject({ status: 409, body: { code: "payment_required" } });
      }
      expect((await samplesOf(orderId)).every((s) => s.status === "awaiting_collection")).toBe(true);
      expect(await orderStatus(orderId)).toBe("ordered");
      // The cashier confirms: the worklist now says ready, and the collection goes through.
      as("rec", "receptionist");
      await sql`update public.payments set status = 'unpaid' where lab_order_id = ${orderId}`;
      expect((await confirm(orderId)).status).toBe(200);
      as("lab", "lab_staff");
      expect((await work()).body.data!.orders.find((o: { orderId: string }) => o.orderId === orderId)).toMatchObject({ readiness: "ready", paymentStatus: "paid" });
      expect((await step(samples[0].id, { action: "collect" })).status).toBe(200);
      // A refund afterwards is a money event: the collected sample stays collected.
      as("owner", "owner");
      expect((await refund(orderId)).status).toBe(200);
      expect((await samplesOf(orderId)).find((s) => s.id === samples[0].id)!.status).toBe("collected");
      // …but what is not collected yet is blocked again: payment is checked at the moment of each collection.
      as("lab", "lab_staff");
      expect(await step(samples[1].id, { action: "collect" })).toMatchObject({ status: 409, body: { code: "payment_required" } });
    } finally {
      await setPolicy(undefined);
    }
  });

  it("with the policy off (or absent, or not an explicit true) payment is not asked for — and the worklist says ready", async () => {
    for (const value of [undefined, { collection: { requiresPayment: false } }, { collection: { requiresPayment: "yes" } }, { collection: "garbage" }, "just text"]) {
      await setPolicy(value);
      const { orderId, samples } = await orderWithSamples([T.urine]);
      as("lab", "lab_staff");
      expect((await work()).body.data!.orders.find((o: { orderId: string }) => o.orderId === orderId), JSON.stringify(value)).toMatchObject({ readiness: "ready", paymentStatus: "unpaid" });
      expect((await step(samples[0].id, { action: "collect" })).status, JSON.stringify(value)).toBe(200);
    }
    await setPolicy(undefined);
  });

  it("the payment is locked while a collection runs, so a refund cannot slip between the check and the collection", async () => {
    await requirePayment(true);
    try {
      const { orderId, samples } = await orderWithSamples([T.urine]);
      as("rec", "receptionist");
      await confirm(orderId);
      let lockErr = "";
      await sql.begin(async (tx) => {
        // The collection transaction, held open.
        await tx`select public.lab_sample_transition(${clinicA}, ${users.lab}, ${samples[0].id}, 'collected', null)`;
        // A refund from another connection must WAIT for it (it would block forever; a short timeout proves the lock).
        try {
          await sql.begin(async (other) => {
            await other`set local lock_timeout = '400ms'`;
            await other`update public.payments set status = 'refunded' where lab_order_id = ${orderId}`;
          });
        } catch (e) {
          lockErr = (e as postgres.PostgresError).code ?? String(e);
        }
      });
      expect(lockErr).toBe("55P03");
      expect((await payment(orderId)).status).toBe("paid");
      expect((await samplesOf(orderId))[0].status).toBe("collected");
    } finally {
      await setPolicy(undefined);
    }
  });

  it("collection versus refund, raced: the sample is collected only if the payment was still paid when it was; otherwise it waits", async () => {
    await requirePayment(true);
    try {
      for (let i = 0; i < 6; i++) {
        const { orderId, samples } = await orderWithSamples([T.urine]);
        as("rec", "receptionist");
        await confirm(orderId);
        as("owner", "owner");
        const refunding = refund(orderId);
        as("lab", "lab_staff");
        const collecting = step(samples[0].id, { action: "collect" });
        const [r, c] = await Promise.all([refunding, collecting]);
        const sample = (await samplesOf(orderId))[0].status;
        expect(r.status).toBe(200);
        if (c.status === 200) expect(sample).toBe("collected");
        else {
          expect(c.body.code).toBe("payment_required");
          expect(sample).toBe("awaiting_collection");
          expect((await payment(orderId)).status).toBe("refunded");
        }
      }
    } finally {
      await setPolicy(undefined);
    }
  });

  it("the lifecycle: collect → process, reject needs a reason, invalid steps are refused, a rejected sample is replaced, a closed order moves nothing", async () => {
    await setPolicy(undefined);
    const { orderId, samples } = await orderWithSamples([T.blood1, T.urine]);
    as("lab", "lab_staff");
    const [blood, urine] = [samples.find((s) => s.sample_type === "blood")!, samples.find((s) => s.sample_type === "urine")!];
    // Out of order: nothing to process or reject before collection.
    expect(await step(blood.id, { action: "process" })).toMatchObject({ status: 409, body: { code: "invalid_transition" } });
    expect((await step(blood.id, { action: "reject", reason: "hemolyzed" })).status).toBe(409);
    expect((await step(blood.id, { action: "collect" })).status).toBe(200);
    expect(await step(blood.id, { action: "process" })).toMatchObject({ status: 200, body: { data: { status: "processing" } } });
    expect(await step(blood.id, { action: "process" })).toMatchObject({ status: 200, body: { data: { unchanged: true } } });
    expect((await step(blood.id, { action: "cancel" })).status, "a sample in processing is rejected, not cancelled").toBe(409);
    // Reject with a reason: the reason is recorded; the same tests can be sampled again.
    expect(await step(blood.id, { action: "reject", reason: "Hemolyzed sample" })).toMatchObject({ status: 200, body: { data: { status: "rejected" } } });
    expect((await sql<{ rejected_reason: string }[]>`select rejected_reason from public.lab_samples where id = ${blood.id}`)[0].rejected_reason).toBe("Hemolyzed sample");
    expect((await step(blood.id, { action: "collect" })).status).toBe(409);
    expect(await prepare(orderId)).toMatchObject({ status: 200, body: { data: { created: 1 } } });
    const fresh = (await samplesOf(orderId)).filter((s) => s.sample_type === "blood" && s.status === "awaiting_collection");
    expect(fresh).toHaveLength(1);
    // An unwanted label can be cancelled before collection.
    expect(await step(urine.id, { action: "cancel" })).toMatchObject({ status: 200, body: { data: { status: "cancelled" } } });
    // The audit trail has each step, ids only (the free-text reason is not in it).
    const trail = await sql<{ action: string; actor_id: string; new_values: unknown }[]>`select action, actor_id, new_values from public.audit_events where entity_id = ${blood.id}`;
    expect(trail.map((t) => t.action)).toEqual(expect.arrayContaining(["lab_sample_created", "lab_sample_collected"]));
    expect(trail.every((t) => t.actor_id === users.lab || t.actor_id === null)).toBe(true);
    expect(JSON.stringify(trail)).not.toContain("Hemolyzed");
    // A cancelled order: nothing more is collected for it.
    await sql`update public.lab_orders set status = 'cancelled', cancelled_by = ${users.owner}, cancel_reason = 'test' where id = ${orderId}`;
    expect(await step(fresh[0].id, { action: "collect" })).toMatchObject({ status: 409, body: { code: "order_closed" } });
  });

  it("the worklist: open orders of the clinic, urgent first, with what the bench needs — and not the note, an amount or another clinic's orders", async () => {
    await requirePayment(true);
    try {
      const routine = await newOrder([T.blood1]);
      const urgent = await newOrder([T.urine], { priority: "urgent" });
      const cancelled = await newOrder([T.urine]);
      await sql`update public.lab_orders set status = 'cancelled', cancelled_by = ${users.owner}, cancel_reason = 'test' where id = ${cancelled}`;
      as("lab", "lab_staff");
      await prepare(urgent);
      const res = await work();
      expect(res.status).toBe(200);
      const orders = res.body.data!.orders as Array<{ orderId: string; priority: string; patient: { fullName: string }; orderedBy: string; tests: unknown[]; samples: Array<{ code: string }>; readiness: string }>;
      const ids = orders.map((o) => o.orderId);
      expect(ids).toContain(routine);
      expect(ids).toContain(urgent);
      expect(ids).not.toContain(cancelled);
      expect(ids.indexOf(urgent)).toBeLessThan(ids.indexOf(routine));
      const row = orders.find((o) => o.orderId === urgent)!;
      expect(row).toMatchObject({ priority: "urgent", patient: { fullName: `Kassa patient ${suffix}` }, orderedBy: `Dr Kassa ${suffix}`, readiness: "awaiting_payment" });
      expect(row.samples).toHaveLength(1);
      const text = JSON.stringify(res.body);
      expect(text).not.toContain(NOTE);
      expect(text).not.toMatch(/amount|price|5000/);
      as("labB", "lab_staff", clinicB);
      expect((await work()).body.data!.orders).toHaveLength(0);
    } finally {
      await setPolicy(undefined);
    }
  });
});
