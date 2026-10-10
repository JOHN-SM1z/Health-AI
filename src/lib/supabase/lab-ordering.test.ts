import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

/**
 * create_lab_order() (supabase/migrations/20261005000007): atomic order
 * creation, proportional panel price allocation (O2), idempotent replay,
 * payment-policy-driven readiness (O6), and refusals — all at the database.
 */

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

async function probe(): Promise<string | null> {
  const p = postgres(DB_URL, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    const [row] = await p<{ ok: boolean }[]>`select to_regprocedure('public.create_lab_order(uuid,uuid,uuid,public.lab_order_source,uuid[],uuid[],uuid,uuid,uuid)') is not null as ok`;
    return row.ok ? null : "lab order migration not applied";
  } catch (e) {
    return `database unreachable — ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    await p.end({ timeout: 1 });
  }
}

const unavailable = await probe();
if (unavailable) process.stderr.write(`\n⚠️  lab ordering database suite SKIPPED (${unavailable})\n\n`);

async function pgError(run: () => Promise<unknown>): Promise<postgres.PostgresError> {
  try {
    await run();
  } catch (e) {
    if (e instanceof postgres.PostgresError) return e;
    throw e;
  }
  throw new Error("expected the database to reject the statement");
}

describe.skipIf(unavailable !== null)("create_lab_order — database", () => {
  let sql: postgres.Sql;
  const suffix = Date.now().toString(36);
  const clinic = randomUUID();
  const otherClinic = randomUUID();
  const staff = randomUUID();
  const doctorProfile = randomUUID();
  const doctor = randomUUID();
  const service = randomUUID();
  let seq = 0;

  type OrderArgs = {
    patient: string;
    tests?: string[];
    panels?: string[];
    key?: string | null;
    source?: string;
    orderedBy?: string;
    doctorId?: string | null;
    appointment?: string | null;
    clinicId?: string;
  };

  const order = (a: OrderArgs) =>
    sql.begin(async (tx) => {
      await tx.unsafe("set local role service_role");
      const [row] = await tx<{ lab_order_id: string; replayed: boolean }[]>`
        select * from public.create_lab_order(
          ${a.clinicId ?? clinic}, ${a.patient}, ${a.orderedBy ?? staff}, ${a.source ?? "walk_in"},
          ${a.tests ?? []}::uuid[], ${a.panels ?? []}::uuid[], ${a.key ?? null}, ${a.doctorId ?? null}, ${a.appointment ?? null})`;
      return row;
    });

  const items = (orderId: string) =>
    sql<{ test_id: string; panel_id: string | null; price_snapshot: string; list_price_snapshot: string; status: string }[]>`
      select test_id, panel_id, price_snapshot, list_price_snapshot, status from public.lab_order_items where order_id = ${orderId}`;

  async function patient(clinicId = clinic) {
    const id = randomUUID();
    await sql`insert into public.patients ${sql({ id, clinic_id: clinicId, full_name: `Order patient ${suffix}`, date_of_birth: "1990-01-01" })}`;
    return id;
  }
  async function test(price: number, extra: Record<string, unknown> = {}, clinicId = clinic) {
    const code = `O${suffix}${seq++}`;
    const [row] = await sql<{ id: string }[]>`insert into public.lab_tests ${sql({ clinic_id: clinicId, code, name: `Test ${code}`, sample_type: "Qon", price, ...extra })} returning id`;
    return row.id;
  }
  async function panel(price: number, tests: string[], extra: Record<string, unknown> = {}) {
    const code = `P${suffix}${seq++}`;
    const [row] = await sql<{ id: string }[]>`insert into public.lab_panels ${sql({ clinic_id: clinic, code, name: `Panel ${code}`, price, ...extra })} returning id`;
    await sql`insert into public.lab_panel_tests ${sql(tests.map((test_id, i) => ({ panel_id: row.id, test_id, clinic_id: clinic, sort_order: i })))}`;
    return row.id;
  }

  beforeAll(async () => {
    sql = postgres(DB_URL, { max: 6, onnotice: () => {} });
    await sql`insert into public.clinics ${sql([
      { id: clinic, name: `Order clinic ${suffix}`, slug: `order-${suffix}`, timezone: "Asia/Tashkent" },
      { id: otherClinic, name: `Order other ${suffix}`, slug: `order-other-${suffix}`, timezone: "Asia/Tashkent" },
    ])}`;
    await sql`insert into auth.users ${sql([{ id: staff, email: `order-staff-${suffix}@test.local` }, { id: doctorProfile, email: `order-dr-${suffix}@test.local` }])}`;
    await sql`insert into public.profiles ${sql([{ id: staff, full_name: "Reception" }, { id: doctorProfile, full_name: "Dr" }])}`;
    await sql`insert into public.staff_roles ${sql([
      { clinic_id: clinic, profile_id: staff, role: "receptionist" },
      { clinic_id: clinic, profile_id: doctorProfile, role: "doctor" },
    ])}`;
    await sql`insert into public.doctors ${sql({ id: doctor, clinic_id: clinic, profile_id: doctorProfile, name: `Dr ${suffix}`, active: true })}`;
    await sql`insert into public.services ${sql({ id: service, clinic_id: clinic, name: `Order consult ${suffix}`, duration_minutes: 30, price: 1 })}`;
    await sql`insert into public.doctor_working_hours ${sql([1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinic_id: clinic, doctor_id: doctor, weekday, start_time: "00:00", end_time: "23:59" })))}`;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from public.clinics where id in ${sql([clinic, otherClinic])}`;
    await sql`delete from auth.users where id in ${sql([staff, doctorProfile])}`;
    await sql.end({ timeout: 5 });
  });

  it("splits a panel price in proportion to the tests' prices (240,000 → 80,000 / 40,000 / 120,000)", async () => {
    const cbc = await test(100000);
    const glucose = await test(50000);
    const liver = await test(150000);
    const p = await panel(240000, [cbc, glucose, liver]);
    const { lab_order_id: order_id } = await order({ patient: await patient(), panels: [p] });
    const byTest = Object.fromEntries((await items(order_id)).map((i) => [i.test_id, Number(i.price_snapshot)]));
    expect(byTest).toEqual({ [cbc]: 80000, [glucose]: 40000, [liver]: 120000 });
  });

  it("keeps the full price when the panel is not discounted, and always sums exactly", async () => {
    const a = await test(100000);
    const b = await test(50000);
    const c = await test(150000);
    const full = await order({ patient: await patient(), panels: [await panel(300000, [a, b, c])] });
    expect((await items(full.lab_order_id)).map((i) => Number(i.price_snapshot)).sort()).toEqual([100000, 150000, 50000].sort());

    // 100,000 across three equally priced tests: whole so'm, remainder to the first (largest, then sort order).
    const x = await test(30000);
    const y = await test(30000);
    const z = await test(30000);
    const split = await order({ patient: await patient(), panels: [await panel(100000, [x, y, z])] });
    const rows = await items(split.lab_order_id);
    expect(rows.reduce((s, r) => s + Number(r.price_snapshot), 0)).toBe(100000);
    expect(Number(rows.find((r) => r.test_id === x)!.price_snapshot)).toBe(33334);
    expect(Number(rows.find((r) => r.test_id === y)!.price_snapshot)).toBe(33333);

    // Fractional panel price: split in 0.01, still exact.
    const odd = await order({ patient: await patient(), panels: [await panel(1000.5, [await test(1), await test(2)])] });
    expect((await items(odd.lab_order_id)).reduce((s, r) => s + Math.round(Number(r.price_snapshot) * 100), 0)).toBe(100050);

    // All member tests free: equal split.
    const free = await order({ patient: await patient(), panels: [await panel(1000, [await test(0), await test(0)])] });
    expect((await items(free.lab_order_id)).map((i) => Number(i.price_snapshot)).sort()).toEqual([500, 500]);
  });

  it("stores standalone prices from the catalog and keeps them when the catalog changes", async () => {
    const t = await test(85000);
    const { lab_order_id: order_id } = await order({ patient: await patient(), tests: [t] });
    await sql`update public.lab_tests set price = 99000 where id = ${t}`;
    const [row] = await items(order_id);
    expect(Number(row.price_snapshot)).toBe(85000);
    expect(Number(row.list_price_snapshot)).toBe(85000);
  });

  it("makes items ready for collection unless the clinic requires payment first (O6)", async () => {
    const t = await test(1000);
    const first = await order({ patient: await patient(), tests: [t] });
    expect((await items(first.lab_order_id))[0].status).toBe("ready_for_collection");

    await sql`insert into public.app_settings ${sql({ clinic_id: clinic, key: "lab", value: { paymentPolicy: "before_collection", releaseToPatient: true } })}
              on conflict (clinic_id, key) do update set value = excluded.value`;
    const gated = await order({ patient: await patient(), tests: [t] });
    expect((await items(gated.lab_order_id))[0].status).toBe("ordered");
    await sql`delete from public.app_settings where clinic_id = ${clinic} and key = 'lab'`;
  });

  it("replays a repeated submission and refuses the same key for a different order", async () => {
    const p = await patient();
    const t = await test(1000);
    const u = await test(2000);
    const key = randomUUID();
    const first = await order({ patient: p, tests: [t, u], key });
    const again = await order({ patient: p, tests: [u, t], key });
    expect(again).toEqual({ lab_order_id: first.lab_order_id, replayed: true });
    expect((await pgError(() => order({ patient: p, tests: [t], key }))).message).toMatch(/lab_order_key_reused/);
    const otherPatient = await patient();
    expect((await pgError(() => order({ patient: otherPatient, tests: [t, u], key }))).message).toMatch(/lab_order_key_reused/);
  });

  it("creates one order when the same request arrives twice at once", async () => {
    const p = await patient();
    const t = await test(1000);
    const key = randomUUID();
    const results = await Promise.all([order({ patient: p, tests: [t], key }), order({ patient: p, tests: [t], key })]);
    expect(new Set(results.map((r) => r.lab_order_id)).size).toBe(1);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from public.lab_orders where creation_key = ${key}`;
    expect(n).toBe(1);
  });

  it("refuses empty orders, a test chosen twice, inactive tests and panels, and foreign catalog rows", async () => {
    const p = await patient();
    const t = await test(1000);
    expect((await pgError(() => order({ patient: p }))).message).toMatch(/lab_order_empty/);
    expect((await pgError(() => order({ patient: p, tests: [t, t] }))).message).toMatch(/lab_order_duplicate_test/);
    const overlapping = await panel(1000, [t, await test(1)]);
    expect((await pgError(() => order({ patient: p, tests: [t], panels: [overlapping] }))).message).toMatch(/lab_order_duplicate_test/);
    const inactive = await test(1000, { active: false });
    expect((await pgError(() => order({ patient: p, tests: [inactive] }))).message).toMatch(/inactive/);
    const inactivePanel = await panel(1000, [await test(1), await test(2)], { active: false });
    expect((await pgError(() => order({ patient: p, panels: [inactivePanel] }))).message).toMatch(/lab_order_inactive_panel/);
    const foreign = await test(1000, {}, otherClinic);
    expect((await pgError(() => order({ patient: p, tests: [foreign] }))).message).toMatch(/unknown test/);
    // Nothing half-created: the failed calls left no orders behind.
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from public.lab_orders where patient_id = ${p}`;
    expect(n).toBe(0);
  });

  it("pins a consultation order to the ordering doctor's own consultation", async () => {
    const p = await patient();
    const t = await test(1000);
    const start = new Date(Date.UTC(2026, 2, 3, 6, 0) + seq++ * 86_400_000);
    const [visit] = await sql<{ id: string }[]>`insert into public.appointments ${sql({
      clinic_id: clinic, patient_id: p, doctor_id: doctor, service_id: service, start_at: start,
      end_at: new Date(start.getTime() + 30 * 60_000), status: "in_progress", source: "walk_in",
    })} returning id`;
    const ok = await order({ patient: p, tests: [t], source: "consultation", orderedBy: doctorProfile, doctorId: doctor, appointment: visit.id });
    expect(ok.replayed).toBe(false);
    const otherPatient = await patient();
    expect(
      (await pgError(() => order({ patient: otherPatient, tests: [t], source: "consultation", orderedBy: doctorProfile, doctorId: doctor, appointment: visit.id }))).code,
    ).toBe("23503");
    // The receptionist cannot order "as" the doctor.
    expect(
      (await pgError(() => order({ patient: p, tests: [t], source: "consultation", orderedBy: staff, doctorId: doctor, appointment: visit.id }))).message,
    ).toMatch(/own active doctor account/);
  });

  it("is not callable by signed-in or anonymous roles", async () => {
    for (const role of ["authenticated", "anon"]) {
      const err = await pgError(() =>
        sql.begin(async (tx) => {
          await tx.unsafe(`set local role ${role}`);
          await tx`select * from public.create_lab_order(${clinic}, ${randomUUID()}, ${staff}, 'walk_in', '{}'::uuid[], '{}'::uuid[])`;
        }),
      );
      expect(err.code).toBe("42501");
    }
  });

  // ---------- Phase 6: the order's bill in the existing payment engine ----------

  const bill = async (orderId: string) =>
    (await sql<{ id: string; amount: string; status: string; provider: string; appointment_id: string | null }[]>`
      select id, amount, status, provider, appointment_id from public.payments where lab_order_id = ${orderId}`)[0];

  it("bills every order once, at the stored item prices, as an unpaid manual payment", async () => {
    const p = await patient();
    const a = await test(100000);
    const b = await test(50000);
    const pnl = await panel(120000, [await test(80000), await test(60000)]);
    const { lab_order_id } = await order({ patient: p, tests: [a, b], panels: [pnl] });
    expect(await bill(lab_order_id)).toMatchObject({ amount: "270000.00", status: "unpaid", provider: "manual", appointment_id: null });
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from public.payments where lab_order_id = ${lab_order_id}`;
    expect(n).toBe(1);
  });

  it("refuses a forged or changed amount, even from the server, and freezes it once paid", async () => {
    const { lab_order_id } = await order({ patient: await patient(), tests: [await test(40000)] });
    const payment = await bill(lab_order_id);
    const asService = (run: (tx: postgres.TransactionSql) => Promise<unknown>) =>
      sql.begin(async (tx) => {
        await tx.unsafe("set local role service_role");
        await run(tx);
      });
    expect((await pgError(() => asService((tx) => tx`update public.payments set amount = 1 where id = ${payment.id}`))).message).toMatch(
      /must equal its order/,
    );
    await asService((tx) => tx`update public.payments set status = 'paid', paid_at = now(), paid_by = ${staff} where id = ${payment.id}`);
    expect((await pgError(() => asService((tx) => tx`update public.payments set amount = 40001 where id = ${payment.id}`))).message).toMatch(
      /cannot change/,
    );
    // A payment never moves between subjects, and needs exactly one.
    expect((await pgError(() => asService((tx) => tx`update public.payments set lab_order_id = null where id = ${payment.id}`))).message).toMatch(/subject/);
    // Signed-in roles cannot touch payments at all.
    const signedIn = await pgError(() =>
      sql.begin(async (tx) => {
        await tx.unsafe("set local role authenticated");
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: staff, role: "authenticated" })}, true)`;
        await tx`update public.payments set status = 'paid' where id = ${payment.id}`;
      }),
    );
    expect(["42501", "P0001"]).toContain(signedIn.code);
  });

  it("lowers an unpaid bill when items are cancelled, and leaves a paid one for refund", async () => {
    const { lab_order_id } = await order({ patient: await patient(), tests: [await test(30000), await test(20000)] });
    await sql`update public.lab_orders set status = 'cancelled', cancelled_by = ${staff}, cancel_reason = 'Bemor ketdi' where id = ${lab_order_id}`;
    expect((await bill(lab_order_id)).amount).toBe("0.00");

    const paid = await order({ patient: await patient(), tests: [await test(30000)] });
    const p = await bill(paid.lab_order_id);
    await sql`update public.payments set status = 'paid', paid_at = now(), paid_by = ${staff} where id = ${p.id}`;
    await sql`update public.lab_orders set status = 'cancelled', cancelled_by = ${staff} where id = ${paid.lab_order_id}`;
    expect(await bill(paid.lab_order_id)).toMatchObject({ amount: "30000.00", status: "paid" });
  });

  it("releases items waiting for payment once the bill is paid (clinic policy before_collection)", async () => {
    await sql`insert into public.app_settings ${sql({ clinic_id: clinic, key: "lab", value: { paymentPolicy: "before_collection", releaseToPatient: true } })}
              on conflict (clinic_id, key) do update set value = excluded.value`;
    const { lab_order_id } = await order({ patient: await patient(), tests: [await test(10000)] });
    expect((await items(lab_order_id))[0].status).toBe("ordered");
    const p = await bill(lab_order_id);
    await sql`update public.payments set status = 'paid', paid_at = now(), paid_by = ${staff} where id = ${p.id}`;
    expect((await items(lab_order_id))[0].status).toBe("ready_for_collection");
    await sql`delete from public.app_settings where clinic_id = ${clinic} and key = 'lab'`;
  });

  it("keeps a lab bill inside its clinic and patient", async () => {
    const { lab_order_id } = await order({ patient: await patient(), tests: [await test(1000)] });
    const other = await patient();
    const err = await pgError(() => sql`insert into public.payments ${sql({ clinic_id: clinic, patient_id: other, lab_order_id, amount: 1000 })}`);
    expect(["23503", "23505"]).toContain(err.code);
    const crossClinic = await pgError(() => sql`insert into public.payments ${sql({ clinic_id: otherClinic, patient_id: other, lab_order_id, amount: 1000 })}`);
    expect(["23503", "23505"]).toContain(crossClinic.code);
  });
});
