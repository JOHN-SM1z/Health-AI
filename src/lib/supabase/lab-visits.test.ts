import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

/**
 * Outpatient pilot, Phase 3 (20261008000001) against the real local
 * database: laboratory tests on the visit bill and the walk-in lab queue.
 * One bill per visit — no second lab bill; tests held until the bill is paid
 * (clinic setting "before_collection"); cancelling a test voids its line;
 * lab staff run the lab queue.
 */

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

async function probeDatabase(): Promise<string | null> {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    const [row] = await probe<{ ok: boolean }[]>`
      select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'visits' and column_name = 'kind') as ok`;
    return row.ok ? null : "lab visit migration not applied — run `npx supabase migration up --local`";
  } catch (e) {
    return `database unreachable via SUPABASE_DB_URL — ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    await probe.end({ timeout: 1 });
  }
}

const unavailable = await probeDatabase();
if (unavailable) process.stderr.write(`\n⚠️  lab visits database suite SKIPPED (${unavailable})\n\n`);
const describeDb = describe.skipIf(unavailable !== null);

type Tx = postgres.TransactionSql;
async function pgError(run: () => Promise<unknown>): Promise<postgres.PostgresError> {
  try {
    await run();
  } catch (e) {
    if (e instanceof postgres.PostgresError) return e;
    throw e;
  }
  throw new Error("expected the database to reject the statement");
}
const minutesToClinicMidnight = () => {
  const local = new Date(Date.now() + 5 * 3_600_000);
  return 24 * 60 - (local.getUTCHours() * 60 + local.getUTCMinutes());
};

describeDb("lab visits — database layer", () => {
  let sql: postgres.Sql;
  const suffix = Date.now().toString(36);
  const clinic = randomUUID();
  const service = randomUUID();
  const doctor = randomUUID();
  const tests = { cbc: randomUUID(), glucose: randomUUID() };
  const profiles = { reception: randomUUID(), cashier: randomUUID(), manager: randomUUID(), lab: randomUUID(), dr: randomUUID() };

  const asServer = async <T>(run: (tx: Tx) => Promise<T>): Promise<T> =>
    (await sql.begin(async (tx) => {
      await tx.unsafe("set local role service_role");
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ role: "service_role" })}, true)`;
      return run(tx);
    })) as T;

  const registerLab = (patient: string | null, testIds: string[], newPatient: Record<string, unknown> | null = null, key = randomUUID()) =>
    asServer(async (tx) => {
      const [row] = await tx<{ r: { visit_id: string; lab_order_id: string; replayed: boolean } }[]>`
        select public.register_lab_arrival(${clinic}, ${profiles.reception}, ${key}, ${patient},
          ${newPatient ? tx.json(newPatient as postgres.JSONValue) : null}, ${testIds}::uuid[], ${[]}::uuid[]) as r`;
      return row.r;
    });
  const pay = (visit: string, amount: number) =>
    asServer(async (tx) => {
      const [row] = await tx<{ r: { queue_number: number | null } }[]>`
        select public.record_visit_payment(${clinic}, ${profiles.cashier}, ${visit}, ${randomUUID()}, ${tx.json([{ method: "cash", amount }])}, ${amount}) as r`;
      return row.r;
    });
  const balance = async (visit: string) => {
    const [b] = await asServer((tx) => tx<{ charged: string; collected: string; refunded: string; outstanding: string }[]>`select * from public.visit_balance(${visit})`);
    return { charged: Number(b.charged), collected: Number(b.collected), refunded: Number(b.refunded), outstanding: Number(b.outstanding) };
  };
  const items = (order: string) => sql<{ id: string; status: string; test_id: string }[]>`select id, status, test_id from public.lab_order_items where order_id = ${order} order by test_name_snapshot`;
  const newPatient = async () =>
    (await sql<{ id: string }[]>`insert into public.patients ${sql({ clinic_id: clinic, full_name: `Lab bemor ${randomUUID().slice(0, 6)}`, date_of_birth: "1985-02-03" })} returning id`)[0].id;

  beforeAll(async () => {
    sql = postgres(DB_URL, { max: 6, onnotice: () => {} });
    await sql`insert into public.clinics ${sql({ id: clinic, name: `Lab visits ${suffix}`, slug: `lab-visits-${suffix}`, timezone: "Asia/Tashkent" })}`;
    const users = Object.entries(profiles).map(([name, id]) => ({ id, email: `labvisit-${name}-${suffix}@test.local` }));
    await sql`insert into auth.users ${sql(users)}`;
    await sql`insert into public.profiles ${sql(users.map((u) => ({ id: u.id, full_name: u.email })))}`;
    await sql`insert into public.staff_roles ${sql([
      { clinic_id: clinic, profile_id: profiles.reception, role: "receptionist" },
      { clinic_id: clinic, profile_id: profiles.cashier, role: "cashier" },
      { clinic_id: clinic, profile_id: profiles.manager, role: "manager" },
      { clinic_id: clinic, profile_id: profiles.lab, role: "lab" },
      { clinic_id: clinic, profile_id: profiles.dr, role: "doctor" },
    ])}`;
    await sql`insert into public.doctors ${sql({ id: doctor, clinic_id: clinic, profile_id: profiles.dr, name: `Dr Lab ${suffix}`, active: true })}`;
    await sql`insert into public.services ${sql({ id: service, clinic_id: clinic, name: `Ko‘rik ${suffix}`, duration_minutes: 5, price: 100000 })}`;
    await sql`insert into public.doctor_working_hours ${sql([1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinic_id: clinic, doctor_id: doctor, weekday, start_time: "00:00", end_time: "23:59" })))}`;
    await sql`insert into public.lab_tests ${sql([
      { id: tests.cbc, clinic_id: clinic, code: `CBC${suffix}`.slice(0, 30), name: "Umumiy qon tahlili", sample_type: "Qon", price: 45000 },
      { id: tests.glucose, clinic_id: clinic, code: `GLU${suffix}`.slice(0, 30), name: "Glyukoza", sample_type: "Qon", price: 25000 },
    ])}`;
    // The owner's rule: tests are paid before the sample is taken.
    await sql`insert into public.app_settings (clinic_id, key, value) values (${clinic}, 'lab', ${sql.json({ paymentPolicy: "before_collection" })})`;
  }, 60_000);

  afterAll(async () => {
    if (!sql) return;
    await sql.begin(async (tx) => {
      await tx.unsafe("set local session_replication_role = replica");
      await tx`delete from public.visit_transactions where clinic_id = ${clinic}`;
      await tx`delete from public.visit_charges where clinic_id = ${clinic}`;
      await tx`delete from public.notification_jobs where clinic_id = ${clinic}`;
      await tx`update public.lab_orders set visit_id = null where clinic_id = ${clinic}`;
      await tx`delete from public.visits where clinic_id = ${clinic}`;
    });
    await sql`delete from public.clinics where id = ${clinic}`;
    await sql`delete from auth.users where id in ${sql(Object.values(profiles))}`;
    await sql.end({ timeout: 5 });
  });

  it("a lab walk-in: one visit, one bill of the tests' prices, no second lab bill, tests held until paid", async () => {
    const r = await registerLab(null, [tests.cbc, tests.glucose], { full_name: "Toshmatova Gulnora", date_of_birth: "1979-11-02", pinfl: "31102790123456" });
    const [visit] = await sql<{ kind: string; status: string; doctor_id: string | null; lab_order_id: string; queue_number: number | null }[]>`
      select kind, status, doctor_id, lab_order_id, queue_number from public.visits where id = ${r.visit_id}`;
    expect(visit).toEqual({ kind: "lab", status: "awaiting_payment", doctor_id: null, lab_order_id: r.lab_order_id, queue_number: null });
    const charges = await sql<{ service_name: string; amount: string; lab_order_item_id: string | null }[]>`
      select service_name, amount, lab_order_item_id from public.visit_charges where visit_id = ${r.visit_id} order by service_name`;
    expect(charges.map((c) => [c.service_name, Number(c.amount)])).toEqual([["Glyukoza", 25000], ["Umumiy qon tahlili", 45000]]);
    expect(charges.every((c) => c.lab_order_item_id !== null)).toBe(true);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from public.payments where lab_order_id = ${r.lab_order_id}`;
    expect(n).toBe(0);
    expect((await items(r.lab_order_id)).map((i) => i.status)).toEqual(["ordered", "ordered"]);

    // Paid in full: queue number, and the tests can be collected.
    const paid = await pay(r.visit_id, 70000);
    expect(paid.queue_number).toBeGreaterThan(0);
    expect((await items(r.lab_order_id)).map((i) => i.status)).toEqual(["ready_for_collection", "ready_for_collection"]);
    expect(await balance(r.visit_id)).toMatchObject({ charged: 70000, collected: 70000, outstanding: 0 });

    // Registered once for the lab while unfinished.
    const [{ patient_id }] = await sql<{ patient_id: string }[]>`select patient_id from public.visits where id = ${r.visit_id}`;
    expect((await pgError(() => registerLab(patient_id, [tests.cbc]))).hint).toBe("already_registered_lab");
  });

  it("lab staff run the lab queue; a doctor cannot", async () => {
    const r = await registerLab(await newPatient(), [tests.cbc]);
    await pay(r.visit_id, 45000);
    const move = (actor: string, expected: string, status: string) =>
      asServer((tx) => tx`select public.transition_visit(${clinic}, ${actor}, ${r.visit_id}, ${expected}, ${status}, null)`);
    expect((await pgError(() => move(profiles.dr, "waiting", "called"))).code).toBe("42501");
    await move(profiles.lab, "waiting", "called");
    await move(profiles.lab, "called", "in_progress");
    await move(profiles.lab, "in_progress", "completed");
    const [v] = await sql<{ status: string }[]>`select status from public.visits where id = ${r.visit_id}`;
    expect(v.status).toBe("completed");
  });

  it("cancelling a lab walk-in at the desk cancels its tests in the lab; not once a sample is taken", async () => {
    const cancel = (visit: string, expected: string) =>
      asServer((tx) => tx`select public.transition_visit(${clinic}, ${profiles.reception}, ${visit}, ${expected}, 'cancelled', 'Bemor ketib qoldi')`);
    const orderStatus = async (order: string) => (await sql<{ status: string }[]>`select status from public.lab_orders where id = ${order}`)[0].status;

    const unpaid = await registerLab(await newPatient(), [tests.cbc, tests.glucose]);
    await cancel(unpaid.visit_id, "awaiting_payment");
    expect(await orderStatus(unpaid.lab_order_id)).toBe("cancelled");
    expect((await items(unpaid.lab_order_id)).map((i) => i.status)).toEqual(["cancelled", "cancelled"]);
    expect(await balance(unpaid.visit_id)).toMatchObject({ charged: 0, outstanding: 0 });

    // Paid, sample taken, money returned: the lab now owns the sample.
    const taken = await registerLab(await newPatient(), [tests.cbc]);
    await pay(taken.visit_id, 45000);
    const [cbc] = await items(taken.lab_order_id);
    await asServer((tx) => tx`select * from public.collect_lab_sample(${clinic}, ${taken.lab_order_id}, ${[cbc.id]}::uuid[], ${profiles.lab}, null, null)`);
    await asServer((tx) => tx`select public.refund_visit_payment(${clinic}, ${profiles.manager}, ${taken.visit_id}, ${randomUUID()}, 'cash', 45000, 'Bemor rad etdi')`);
    expect((await pgError(() => cancel(taken.visit_id, "waiting"))).hint).toBe("lab_sample_taken");
    expect(await orderStatus(taken.lab_order_id)).toBe("active");
  });

  it("a test cancelled in the lab leaves the bill; paid money for it shows as due back; a lab line cannot be voided at the desk", async () => {
    const r = await registerLab(await newPatient(), [tests.cbc, tests.glucose]);
    const [glucose, cbc] = await items(r.lab_order_id);
    void cbc;
    const [line] = await sql<{ id: string }[]>`select id from public.visit_charges where lab_order_item_id = ${glucose.id}`;
    expect(
      (await pgError(() => asServer((tx) => tx`select public.void_visit_charge(${clinic}, ${profiles.reception}, ${line.id}, 'Noto‘g‘ri tahlil')`))).hint,
    ).toBe("cancel_lab_test");

    // Unpaid: cancelling the test removes it from the bill.
    await sql`update public.lab_order_items set status = 'cancelled', status_changed_by = ${profiles.lab} where id = ${glucose.id}`;
    expect(await balance(r.visit_id)).toMatchObject({ charged: 45000, outstanding: 45000 });

    // Paid, then cancelled: the money is due back (negative), refunded at the kassa.
    await pay(r.visit_id, 45000);
    const [left] = await items(r.lab_order_id).then((rows) => rows.filter((i) => i.status !== "cancelled"));
    await sql`update public.lab_order_items set status = 'cancelled', status_changed_by = ${profiles.lab} where id = ${left.id}`;
    expect(await balance(r.visit_id)).toMatchObject({ charged: 0, collected: 45000, outstanding: -45000 });
    await asServer((tx) => tx`select public.refund_visit_payment(${clinic}, ${profiles.manager}, ${r.visit_id}, ${randomUUID()}, 'cash', 45000, 'Tahlil bekor qilindi')`);
    expect(await balance(r.visit_id)).toMatchObject({ outstanding: 0 });
  });

  it("tests a doctor orders in a walk-in consultation go on that visit's bill — no second bill", async () => {
    if (minutesToClinicMidnight() < 8) return;
    const patient = await newPatient();
    const reg = await asServer(async (tx) => {
      const [row] = await tx<{ r: { visit_id: string } }[]>`select public.register_arrival(${clinic}, ${profiles.reception}, ${randomUUID()}, ${patient}, null, ${doctor}, ${[service]}::uuid[]) as r`;
      return row.r;
    });
    await pay(reg.visit_id, 100000);
    const [{ r: started }] = await asServer((tx) => tx<{ r: { appointment_id: string } }[]>`
      select public.start_visit_consultation(${clinic}, ${profiles.dr}, ${reg.visit_id}, 'waiting') as r`);
    const [order] = await asServer((tx) => tx<{ lab_order_id: string }[]>`
      select * from public.create_lab_order(${clinic}, ${patient}, ${profiles.dr}, 'consultation', ${[tests.cbc]}::uuid[], ${[]}::uuid[], ${randomUUID()}, ${doctor}, ${started.appointment_id})`);
    const [o] = await sql<{ visit_id: string }[]>`select visit_id from public.lab_orders where id = ${order.lab_order_id}`;
    expect(o.visit_id).toBe(reg.visit_id);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from public.payments where lab_order_id = ${order.lab_order_id}`;
    expect(n).toBe(0);
    expect(await balance(reg.visit_id)).toMatchObject({ charged: 145000, collected: 100000, outstanding: 45000 });
    await pay(reg.visit_id, 45000);
    expect((await items(order.lab_order_id)).map((i) => i.status)).toEqual(["ready_for_collection"]);
  });

  it("a lab order outside any visit keeps its own lab bill (no regression)", async () => {
    const patient = await newPatient();
    const [order] = await asServer((tx) => tx<{ lab_order_id: string }[]>`
      select * from public.create_lab_order(${clinic}, ${patient}, ${profiles.reception}, 'walk_in', ${[tests.glucose]}::uuid[], ${[]}::uuid[], ${randomUUID()}, null, null)`);
    const [p] = await sql<{ amount: string; status: string }[]>`select amount, status from public.payments where lab_order_id = ${order.lab_order_id}`;
    expect(p).toEqual({ amount: "25000.00", status: "unpaid" });
    const [o] = await sql<{ visit_id: string | null }[]>`select visit_id from public.lab_orders where id = ${order.lab_order_id}`;
    expect(o.visit_id).toBeNull();
  });

  it("reception and management only; the lab test must be orderable (date of birth required)", async () => {
    const patient = await newPatient();
    for (const actor of [profiles.cashier, profiles.lab, profiles.dr]) {
      const e = await pgError(() =>
        asServer((tx) => tx`select public.register_lab_arrival(${clinic}, ${actor}, ${randomUUID()}, ${patient}, null, ${[tests.cbc]}::uuid[], ${[]}::uuid[])`),
      );
      expect(e.code).toBe("42501");
    }
    const [noDob] = await sql<{ id: string }[]>`insert into public.patients ${sql({ clinic_id: clinic, full_name: "DOB yo‘q" })} returning id`;
    expect((await pgError(() => registerLab(noDob.id, [tests.cbc]))).message).toMatch(/date of birth/);
  });
});
