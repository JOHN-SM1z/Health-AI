import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { cleanupTestClinics } from "@/test/cleanup-clinics";
import { localDbAvailable } from "@/test/local-db";

/**
 * Laboratory orders as a second billable entity of the EXISTING payments table (20261003000005), at the
 * database layer: one payment per order written with the order and priced by the database, a payment owned
 * by exactly one of an appointment / a lab order, same-clinic and same-patient integrity, an immutable
 * amount, manual provider only, who can read what — and that appointment payments are untouched.
 */

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const describeDb = describe.skipIf(!localDbAvailable());

async function pgError(run: () => Promise<unknown>): Promise<postgres.PostgresError> {
  try {
    await run();
  } catch (e) {
    if (e instanceof postgres.PostgresError) return e;
    throw e;
  }
  throw new Error("expected the database to reject the statement");
}

describeDb("laboratory payments — one payments table, one owner per payment, server-priced", () => {
  let sql: postgres.Sql;
  const suffix = Date.now().toString(36) + Math.floor(Math.random() * 1e4);
  const clinicA = randomUUID();
  const clinicB = randomUUID();
  const u = { doc: randomUUID(), rec: randomUUID(), lab: randomUUID(), mgr: randomUUID() };
  const doc = randomUUID();
  const svc = randomUUID();
  const patientX = randomUUID();
  const patientY = randomUUID();
  const patientB = randomUUID();
  const T: Record<string, string> = {};
  let panelFixed = "";
  let panelSum = "";
  let consult = "";
  let apptPayment = "";
  let day = 0;

  const asUser = <R>(sub: string, run: (tx: postgres.TransactionSql) => Promise<R>) =>
    sql.begin(async (tx) => {
      await tx.unsafe("set local role authenticated");
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub, role: "authenticated" })}, true)`;
      return run(tx);
    }) as Promise<R>;

  async function createOrder(items: Array<{ test_id: string; panel_id?: string | null }>, key: string | null = randomUUID(), patient = patientX) {
    const [row] = await sql<{ r: { order_id: string; replayed: boolean } }[]>`
      select public.lab_create_order(${clinicA}, ${u.doc}, ${patient}, ${doc}, ${consult}, null, 'routine', null, ${key}, ${sql.json(items)}) as r`;
    return row.r;
  }
  const paymentOf = async (orderId: string) =>
    (await sql<{ id: string; status: string; amount: string; currency: string; provider: string; patient_id: string; appointment_id: string | null }[]>`
      select id, status, amount::text, currency, provider, patient_id, appointment_id from public.payments where lab_order_id = ${orderId}`);

  beforeAll(async () => {
    sql = postgres(DB_URL, { max: 6, onnotice: () => {} });
    await sql`insert into public.clinics ${sql([
      { id: clinicA, name: `Lab Pay A ${suffix}`, slug: `lab-pay-a-${suffix}`, timezone: "Asia/Tashkent" },
      { id: clinicB, name: `Lab Pay B ${suffix}`, slug: `lab-pay-b-${suffix}`, timezone: "Asia/Tashkent" },
    ])}`;
    const users = Object.entries(u).map(([k, id]) => ({ id, email: `labpay-${k}-${suffix}@test.local` }));
    await sql`insert into auth.users ${sql(users)}`;
    await sql`insert into public.profiles ${sql(users.map((x) => ({ id: x.id, full_name: x.email })))}`;
    await sql`insert into public.staff_roles ${sql([
      { clinic_id: clinicA, profile_id: u.doc, role: "doctor" },
      { clinic_id: clinicA, profile_id: u.rec, role: "receptionist" },
      { clinic_id: clinicA, profile_id: u.lab, role: "lab_staff" },
      { clinic_id: clinicA, profile_id: u.mgr, role: "manager" },
    ])}`;
    await sql`insert into public.doctors (id, clinic_id, profile_id, name, active) values (${doc}, ${clinicA}, ${u.doc}, ${`Dr Pay ${suffix}`}, true)`;
    await sql`insert into public.services (id, clinic_id, name, duration_minutes, price) values (${svc}, ${clinicA}, ${`Pay ${suffix}`}, 30, 1000)`;
    await sql`insert into public.doctor_working_hours ${sql([1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinic_id: clinicA, doctor_id: doc, weekday, start_time: "00:00", end_time: "23:59" })))}`;
    await sql`insert into public.patients ${sql([
      { id: patientX, clinic_id: clinicA, full_name: `Pay X ${suffix}` },
      { id: patientY, clinic_id: clinicA, full_name: `Pay Y ${suffix}` },
      { id: patientB, clinic_id: clinicB, full_name: `Pay B ${suffix}` },
    ])}`;
    const start = new Date(Date.UTC(2032, 8, 1 + day++, 5, 0));
    [{ id: consult }] = await sql<{ id: string }[]>`insert into public.appointments ${sql({
      clinic_id: clinicA, patient_id: patientX, doctor_id: doc, service_id: svc, start_at: start,
      end_at: new Date(start.getTime() + 30 * 60_000), status: "in_progress", source: "walk_in",
    })} returning id`;
    [{ id: apptPayment }] = await sql<{ id: string }[]>`insert into public.payments (clinic_id, appointment_id, patient_id, amount, status) values (${clinicA}, ${consult}, ${patientX}, 1000, 'paid') returning id`;

    const ins = async (table: string, row: Record<string, unknown>) =>
      (await sql<{ id: string }[]>`insert into ${sql(`public.${table}`)} ${sql(row as never)} returning id`)[0].id;
    T.a = await ins("lab_tests", { clinic_id: clinicA, code: `A-${suffix}`, name: "Test A", price: 10000, sample_type: "blood" });
    T.b = await ins("lab_tests", { clinic_id: clinicA, code: `B-${suffix}`, name: "Test B", price: 20000, sample_type: "blood" });
    T.c = await ins("lab_tests", { clinic_id: clinicA, code: `C-${suffix}`, name: "Test C", price: 5000, sample_type: "urine" });
    T.x = await ins("lab_tests", { clinic_id: clinicB, code: `X-${suffix}`, name: "Test X", price: 1 });
    panelFixed = await ins("lab_panels", { clinic_id: clinicA, code: `PF-${suffix}`, name: "Fixed", price: 25000 });
    panelSum = await ins("lab_panels", { clinic_id: clinicA, code: `PS-${suffix}`, name: "Summed", price: null });
    await sql`insert into public.lab_panel_tests ${sql([
      { panel_id: panelFixed, test_id: T.a, clinic_id: clinicA, sort_order: 0 },
      { panel_id: panelFixed, test_id: T.b, clinic_id: clinicA, sort_order: 1 },
      { panel_id: panelSum, test_id: T.a, clinic_id: clinicA, sort_order: 0 },
      { panel_id: panelSum, test_id: T.c, clinic_id: clinicA, sort_order: 1 },
    ])}`;
  });

  afterAll(async () => {
    if (!sql) return;
    await cleanupTestClinics([clinicA, clinicB]);
    await sql`delete from auth.users where id in ${sql(Object.values(u))}`;
    await sql.end({ timeout: 5 });
  });

  it("an order is written with its payment, in the same transaction: unpaid, manual, the clinic's currency, priced from the snapshots", async () => {
    const o = await createOrder([{ test_id: T.a }, { test_id: T.c }]);
    const [p] = await paymentOf(o.order_id);
    expect(p).toMatchObject({ status: "unpaid", provider: "manual", currency: "UZS", patient_id: patientX, appointment_id: null });
    expect(p.amount).toBe("15000.00"); // 10000 + 5000: the catalog's prices, not anything sent
    // The currency is the clinic's.
    await sql`update public.clinics set currency = 'USD' where id = ${clinicA}`;
    try {
      const o2 = await createOrder([{ test_id: T.b }]);
      expect((await paymentOf(o2.order_id))[0].currency).toBe("USD");
    } finally {
      await sql`update public.clinics set currency = 'UZS' where id = ${clinicA}`;
    }
  });

  it("a fixed-price panel is billed at the panel price only when the WHOLE panel is on the order; otherwise test by test", async () => {
    // Whole fixed panel (A + B, 30000 by tests) → 25000.
    const whole = await createOrder([{ test_id: T.a, panel_id: panelFixed }, { test_id: T.b, panel_id: panelFixed }]);
    expect((await paymentOf(whole.order_id))[0].amount).toBe("25000.00");
    // The same panel but test A was also chosen on its own (no panel_id): the order is not "the panel" → 10000 + 20000.
    const partial = await createOrder([{ test_id: T.a }, { test_id: T.b, panel_id: panelFixed }]);
    expect((await paymentOf(partial.order_id))[0].amount).toBe("30000.00");
    // A panel without a fixed price: the sum of its tests.
    const summed = await createOrder([{ test_id: T.a, panel_id: panelSum }, { test_id: T.c, panel_id: panelSum }]);
    expect((await paymentOf(summed.order_id))[0].amount).toBe("15000.00");
    // The price of the panel changing afterwards changes nothing already billed.
    await sql`update public.lab_panels set price = 1 where id = ${panelFixed}`;
    try {
      expect((await paymentOf(whole.order_id))[0].amount).toBe("25000.00");
    } finally {
      await sql`update public.lab_panels set price = 25000 where id = ${panelFixed}`;
    }
  });

  it("a repeated submission creates no second payment; an order the database refuses leaves neither order nor payment", async () => {
    const key = randomUUID();
    const first = await createOrder([{ test_id: T.a }], key);
    const again = await createOrder([{ test_id: T.a }], key);
    expect(again).toMatchObject({ order_id: first.order_id, replayed: true });
    expect(await paymentOf(first.order_id)).toHaveLength(1);
    const burstKey = randomUUID();
    const burst = await Promise.all(Array.from({ length: 6 }, () => createOrder([{ test_id: T.c }], burstKey)));
    expect(new Set(burst.map((r) => r.order_id)).size).toBe(1);
    expect(await paymentOf(burst[0].order_id)).toHaveLength(1);

    const before = (await sql<{ n: number }[]>`select count(*)::int as n from public.payments where clinic_id = ${clinicA} and lab_order_id is not null`)[0].n;
    const ordersBefore = (await sql<{ n: number }[]>`select count(*)::int as n from public.lab_orders where clinic_id = ${clinicA}`)[0].n;
    await sql`update public.lab_tests set active = false where id = ${T.b}`;
    try {
      const err = await pgError(() => createOrder([{ test_id: T.a }, { test_id: T.b }]));
      expect(err.message).toContain("inactive");
    } finally {
      await sql`update public.lab_tests set active = true where id = ${T.b}`;
    }
    expect((await sql<{ n: number }[]>`select count(*)::int as n from public.payments where clinic_id = ${clinicA} and lab_order_id is not null`)[0].n).toBe(before);
    expect((await sql<{ n: number }[]>`select count(*)::int as n from public.lab_orders where clinic_id = ${clinicA}`)[0].n).toBe(ordersBefore);
  });

  it("a payment has exactly one owner, an order has at most one payment, and the payment can't point across clinics or patients", async () => {
    const o = await createOrder([{ test_id: T.a }]);
    const orderOnly = { clinic_id: clinicA, patient_id: patientX, amount: 1, currency: "UZS", provider: "manual" as const };
    // Neither / both owners.
    expect((await pgError(() => sql`insert into public.payments ${sql({ ...orderOnly })}`)).code).toBe("23514");
    expect((await pgError(() => sql`insert into public.payments ${sql({ ...orderOnly, appointment_id: consult, lab_order_id: o.order_id })}`)).code).toBe("23514");
    // A second payment for the same order.
    expect((await pgError(() => sql`insert into public.payments ${sql({ ...orderOnly, lab_order_id: o.order_id })}`)).code).toBe("23505");
    // Another patient, another clinic.
    const o2 = await createOrder([{ test_id: T.c }]);
    await sql`delete from public.payments where lab_order_id = ${o2.order_id}`;
    expect((await pgError(() => sql`insert into public.payments ${sql({ ...orderOnly, patient_id: patientY, lab_order_id: o2.order_id })}`)).code).toBe("23503");
    expect((await pgError(() => sql`insert into public.payments ${sql({ ...orderOnly, clinic_id: clinicB, patient_id: patientB, lab_order_id: o2.order_id })}`)).code).toBe("23503");
    // Only the manual provider settles a lab order.
    for (const provider of ["click", "payme"]) {
      expect((await pgError(() => sql`insert into public.payments ${sql({ ...orderOnly, provider: provider as "click", lab_order_id: o2.order_id })}`)).code, provider).toBe("23514");
    }
    // The order cannot be deleted from under its payment (restrict).
    expect((await pgError(() => sql`delete from public.lab_orders where id = ${o.order_id}`)).code).toBe("23503");
  });

  it("what a lab payment is cannot be rewritten: only its status moves; an appointment payment cannot become a lab payment", async () => {
    const o = await createOrder([{ test_id: T.a }]);
    const [p] = await paymentOf(o.order_id);
    for (const change of [{ amount: 1 }, { currency: "USD" }, { patient_id: patientY }, { lab_order_id: null, appointment_id: consult }]) {
      const err = await pgError(() => sql`update public.payments set ${sql(change as never)} where id = ${p.id}`);
      expect(err.message.length, JSON.stringify(change)).toBeGreaterThan(0);
    }
    expect((await paymentOf(o.order_id))[0].amount).toBe("10000.00");
    // The engine's own kind of update is allowed.
    await sql`update public.payments set status = 'paid', paid_at = now() where id = ${p.id}`;
    expect((await paymentOf(o.order_id))[0].status).toBe("paid");
    // An existing appointment payment can't be turned into a lab payment (or the other way round).
    const err = await pgError(() => sql`update public.payments set lab_order_id = ${o.order_id} where id = ${apptPayment}`);
    expect(err.message).toMatch(/billable entity|23514|violates/);
  });

  it("appointment payments are untouched: still one per appointment, still read through the appointment", async () => {
    expect((await pgError(() => sql`insert into public.payments (clinic_id, appointment_id, patient_id, amount) values (${clinicA}, ${consult}, ${patientX}, 5)`)).code).toBe("23505");
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from public.payments where appointment_id = ${consult}`;
    expect(row.n).toBe(1);
    // A lab payment is never reachable as an appointment's payment.
    expect((await sql`select 1 from public.payments where appointment_id is null and lab_order_id is not null and appointment_id = ${consult}`)).toHaveLength(0);
  });

  it("who reads lab payments directly: reception and management only; technicians and doctors see none, and nobody writes through a token", async () => {
    const readable = (sub: string) => asUser(sub, async (tx) => (await tx`select count(*)::int as n from public.payments where lab_order_id is not null`)[0].n as number);
    expect(await readable(u.rec)).toBeGreaterThan(0);
    expect(await readable(u.mgr)).toBeGreaterThan(0);
    expect(await readable(u.lab)).toBe(0);
    expect(await readable(u.doc)).toBe(0);
    const [p] = await sql<{ id: string }[]>`select id from public.payments where lab_order_id is not null limit 1`;
    for (const sub of [u.rec, u.mgr, u.lab, u.doc]) {
      const err = await pgError(() => asUser(sub, async (tx) => tx`update public.payments set status = 'paid' where id = ${p.id}`));
      expect(err.message, sub).toMatch(/server-managed|permission denied/);
      const ins = await pgError(() => asUser(sub, async (tx) => tx`insert into public.payments (clinic_id, patient_id, amount, lab_order_id) values (${clinicA}, ${patientX}, 1, ${randomUUID()})`));
      expect(ins.code, sub).toMatch(/42501|23503|23514/);
    }
  });

  it("the new functions are for the server only", async () => {
    const o = await createOrder([{ test_id: T.a }]);
    for (const call of [
      (tx: postgres.TransactionSql) => tx`select public.lab_order_amount(${o.order_id})`,
      (tx: postgres.TransactionSql) => tx`select public.lab_collection_requires_payment(${clinicA})`,
      (tx: postgres.TransactionSql) => tx`select public.lab_create_samples(${clinicA}, ${u.lab}, ${o.order_id})`,
      (tx: postgres.TransactionSql) => tx`select public.lab_sample_transition(${clinicA}, ${u.lab}, ${randomUUID()}, 'collected', null)`,
    ]) {
      const err = await pgError(() => asUser(u.lab, async (tx) => call(tx)));
      expect(err.code).toBe("42501");
    }
  });
});
