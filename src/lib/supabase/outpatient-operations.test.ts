import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

/**
 * Outpatient pilot — database layer (20261007000002), against the real local
 * database: walk-in registration, the kassa ledger, refunds and grants, the
 * queue, the walk-in consultation and doctor access through a visit or a
 * pending referral. Every call goes through the server-only RPCs exactly as
 * the API does (service role + the session's actor id).
 */

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

async function probeDatabase(): Promise<string | null> {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    const [row] = await probe<{ has_visits: boolean }[]>`select to_regclass('public.visits') is not null as has_visits`;
    return row.has_visits ? null : "outpatient migrations not applied — run `npx supabase migration up --local`";
  } catch (e) {
    return `database unreachable via SUPABASE_DB_URL — ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    await probe.end({ timeout: 1 });
  }
}

const unavailable = await probeDatabase();
if (unavailable) process.stderr.write(`\n⚠️  outpatient operations database suite SKIPPED (${unavailable})\n\n`);
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

/** Minutes until midnight in Tashkent (UTC+5): a walk-in consultation must end today. */
const minutesToClinicMidnight = () => {
  const local = new Date(Date.now() + 5 * 3_600_000);
  return 24 * 60 - (local.getUTCHours() * 60 + local.getUTCMinutes());
};

describeDb("outpatient operations — database layer", () => {
  let sql: postgres.Sql;
  const suffix = Date.now().toString(36);
  const clinicA = randomUUID();
  const clinicB = randomUUID();
  const services = { consult: randomUUID(), ecg: randomUUID(), free: randomUUID(), b: randomUUID() };
  const profiles = {
    owner: randomUUID(),
    manager: randomUUID(),
    admin: randomUUID(),
    reception: randomUUID(),
    cashier: randomUUID(),
    cashier2: randomUUID(),
    drA: randomUUID(),
    drC: randomUUID(),
    receptionB: randomUUID(),
  };
  const doctors = { a: randomUUID(), c: randomUUID(), b: randomUUID() };

  const asServer = async <T>(run: (tx: Tx) => Promise<T>): Promise<T> =>
    (await sql.begin(async (tx) => {
      await tx.unsafe("set local role service_role");
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ role: "service_role" })}, true)`;
      return run(tx);
    })) as T;
  const asUser = async <T>(profileId: string, run: (tx: Tx) => Promise<T>): Promise<T> =>
    (await sql.begin(async (tx) => {
      await tx.unsafe("set local role authenticated");
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: profileId, role: "authenticated" })}, true)`;
      return run(tx);
    })) as T;

  // ---------- RPC wrappers (as the API calls them) ----------

  type Reg = { visit_id: string; replayed: boolean };
  const register = (opts: { actor?: string; key?: string; patient?: string | null; newPatient?: Record<string, unknown> | null; doctor?: string; services?: string[]; clinic?: string }) =>
    asServer(async (tx) => {
      const [row] = await tx<{ r: Reg }[]>`select public.register_arrival(
        ${opts.clinic ?? clinicA}, ${opts.actor ?? profiles.reception}, ${opts.key ?? randomUUID()},
        ${opts.patient ?? null}, ${opts.newPatient ? tx.json(opts.newPatient as postgres.JSONValue) : null},
        ${opts.doctor ?? doctors.a}, ${opts.services ?? [services.consult]}::uuid[]) as r`;
      return row.r;
    });
  const pay = (visit: string, lines: Array<{ method: string; amount: number }>, expected: number, actor = profiles.cashier, key = randomUUID()) =>
    asServer(async (tx) => {
      const [row] = await tx<{ r: { queue_number: number | null; replayed: boolean } }[]>`select public.record_visit_payment(
        ${clinicA}, ${actor}, ${visit}, ${key}, ${tx.json(lines)}, ${expected}) as r`;
      return row.r;
    });
  const refund = (visit: string, method: string, amount: number, actor: string, reason = "Bemor xizmatdan voz kechdi", key = randomUUID()) =>
    asServer(async (tx) => {
      const [row] = await tx<{ r: unknown }[]>`select public.refund_visit_payment(${clinicA}, ${actor}, ${visit}, ${key}, ${method}, ${amount}, ${reason}) as r`;
      return row.r;
    });
  const transition = (visit: string, expected: string, status: string, actor: string, reason: string | null = null) =>
    asServer(async (tx) => {
      const [row] = await tx<{ r: { status: string } }[]>`select public.transition_visit(${clinicA}, ${actor}, ${visit}, ${expected}, ${status}, ${reason}) as r`;
      return row.r;
    });
  const balance = async (visit: string) => {
    const [b] = await asServer((tx) => tx<{ charged: string; collected: string; refunded: string; outstanding: string; cash_net: string; terminal_net: string }[]>`
      select * from public.visit_balance(${visit})`);
    return Object.fromEntries(Object.entries(b).map(([k, v]) => [k, Number(v)])) as Record<keyof typeof b, number>;
  };
  const visitRow = async (id: string) =>
    (await sql<{ status: string; queue_number: number | null; queue_date: string | null; patient_id: string; appointment_id: string | null }[]>`
      select status, queue_number, queue_date::text, patient_id, appointment_id from public.visits where id = ${id}`)[0];
  const newPatient = async (clinic = clinicA) => {
    const [row] = await sql<{ id: string }[]>`insert into public.patients ${sql({ clinic_id: clinic, full_name: `Bemor ${randomUUID().slice(0, 6)}`, date_of_birth: "1990-01-01" })} returning id`;
    return row.id;
  };

  beforeAll(async () => {
    sql = postgres(DB_URL, { max: 10, onnotice: () => {} });
    await sql`insert into public.clinics ${sql([
      { id: clinicA, name: `Ops A ${suffix}`, slug: `ops-a-${suffix}`, timezone: "Asia/Tashkent" },
      { id: clinicB, name: `Ops B ${suffix}`, slug: `ops-b-${suffix}`, timezone: "Asia/Tashkent" },
    ])}`;
    const users = Object.entries(profiles).map(([name, id]) => ({ id, email: `ops-${name}-${suffix}@test.local` }));
    await sql`insert into auth.users ${sql(users)}`;
    await sql`insert into public.profiles ${sql(users.map((u) => ({ id: u.id, full_name: u.email })))}`;
    await sql`insert into public.staff_roles ${sql([
      { clinic_id: clinicA, profile_id: profiles.owner, role: "owner" },
      { clinic_id: clinicA, profile_id: profiles.manager, role: "manager" },
      { clinic_id: clinicA, profile_id: profiles.admin, role: "admin" },
      { clinic_id: clinicA, profile_id: profiles.reception, role: "receptionist" },
      { clinic_id: clinicA, profile_id: profiles.cashier, role: "cashier" },
      { clinic_id: clinicA, profile_id: profiles.cashier2, role: "cashier" },
      { clinic_id: clinicA, profile_id: profiles.drA, role: "doctor" },
      { clinic_id: clinicA, profile_id: profiles.drC, role: "doctor" },
      { clinic_id: clinicB, profile_id: profiles.receptionB, role: "receptionist" },
    ])}`;
    await sql`insert into public.doctors ${sql([
      { id: doctors.a, clinic_id: clinicA, profile_id: profiles.drA, name: `Dr A ${suffix}`, active: true },
      { id: doctors.c, clinic_id: clinicA, profile_id: profiles.drC, name: `Dr C ${suffix}`, active: true },
      { id: doctors.b, clinic_id: clinicB, profile_id: null, name: `Dr B ${suffix}`, active: true },
    ])}`;
    await sql`insert into public.services ${sql([
      { id: services.consult, clinic_id: clinicA, name: `Konsultatsiya ${suffix}`, duration_minutes: 5, price: 150000 },
      { id: services.ecg, clinic_id: clinicA, name: `EKG ${suffix}`, duration_minutes: 5, price: 80000.5 },
      { id: services.free, clinic_id: clinicA, name: `Bepul ko‘rik ${suffix}`, duration_minutes: 5, price: 0 },
      { id: services.b, clinic_id: clinicB, name: `B xizmat ${suffix}`, duration_minutes: 5, price: 1000 },
    ])}`;
    await sql`insert into public.doctor_working_hours ${sql(
      [doctors.a, doctors.c].flatMap((doctor_id) =>
        [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinic_id: clinicA, doctor_id, weekday, start_time: "00:00", end_time: "23:59" })),
      ),
    )}`;
  });

  afterAll(async () => {
    if (!sql) return;
    // Charges, the ledger and grants refuse deletion by design; test cleanup
    // bypasses those guards for its own rows only, inside one transaction.
    await sql.begin(async (tx) => {
      await tx.unsafe("set local session_replication_role = replica");
      const clinics = [clinicA, clinicB];
      await tx`delete from public.visit_transactions where clinic_id in ${tx(clinics)}`;
      await tx`delete from public.visit_charges where clinic_id in ${tx(clinics)}`;
      await tx`delete from public.refund_grants where clinic_id in ${tx(clinics)}`;
      await tx`delete from public.notification_jobs where clinic_id in ${tx(clinics)} and visit_id is not null`;
      await tx`delete from public.visits where clinic_id in ${tx(clinics)}`;
    });
    await sql`delete from public.clinics where id in ${sql([clinicA, clinicB])}`;
    await sql`delete from auth.users where id in ${sql(Object.values(profiles))}`;
    await sql.end({ timeout: 5 });
  });

  // ---------- registration ----------

  it("registers a new patient, the visit and itemized server-priced charges in one transaction — no queue number before payment", async () => {
    const doc = `AB${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;
    const r = await register({
      newPatient: { full_name: "Karimov Aziz", date_of_birth: "1985-03-04", document_number: ` ${doc.slice(0, 2)} ${doc.slice(2)} `, phone: "+998 90 123 45 67", sex: "male" },
      services: [services.consult, services.ecg],
    });
    expect(r.replayed).toBe(false);
    const v = await visitRow(r.visit_id);
    expect(v).toMatchObject({ status: "awaiting_payment", queue_number: null });
    const [p] = await sql<{ document_number: string; patient_number: string }[]>`select document_number, patient_number from public.patients where id = ${v.patient_id}`;
    expect(p.document_number).toBe(doc);
    expect(Number(p.patient_number)).toBeGreaterThan(0);
    const charges = await sql<{ service_name: string; unit_price: string; amount: string; currency: string }[]>`
      select service_name, unit_price, amount, currency from public.visit_charges where visit_id = ${r.visit_id} order by created_at, service_name`;
    expect(charges.map((c) => Number(c.amount)).sort((a, b) => a - b)).toEqual([80000.5, 150000]);
    expect(charges.every((c) => c.currency === "UZS")).toBe(true);
    expect(await balance(r.visit_id)).toMatchObject({ charged: 230000.5, collected: 0, outstanding: 230000.5 });

    // The same person again (same document) is never a second record.
    const dup = await pgError(() => register({ newPatient: { full_name: "Boshqa ism", date_of_birth: "1985-03-04", document_number: doc } }));
    expect(dup.hint).toBe("patient_exists");
    expect(dup.detail).toBe(v.patient_id);
    // Nor the same name and date of birth.
    expect((await pgError(() => register({ newPatient: { full_name: "  karimov aziz ", date_of_birth: "1985-03-04" } }))).hint).toBe("patient_exists");
    // Already waiting for the same doctor: not registered twice.
    expect((await pgError(() => register({ patient: v.patient_id }))).hint).toBe("already_registered");
  });

  it("a retried registration returns the original visit; a reused key with different content is refused", async () => {
    const patient = await newPatient();
    const key = randomUUID();
    const first = await register({ patient, key });
    const again = await register({ patient, key });
    expect(again).toEqual({ visit_id: first.visit_id, replayed: true });
    expect((await pgError(() => register({ patient, key, services: [services.ecg] }))).hint).toBe("idempotency_conflict");
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from public.visits where patient_id = ${patient}`;
    expect(n).toBe(1);
  });

  it("eight concurrent retries of one registration create one visit and one set of charges", async () => {
    const patient = await newPatient();
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 8 }, () => register({ patient, key })));
    expect(new Set(results.map((r) => r.visit_id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from public.visit_charges where visit_id = ${results[0].visit_id}`;
    expect(n).toBe(1);
  });

  it("refuses roles, clinics, services and patients it must not accept", async () => {
    const patient = await newPatient();
    // A cashier and a doctor cannot register; another clinic's receptionist cannot use this clinic.
    expect((await pgError(() => register({ patient, actor: profiles.cashier }))).code).toBe("42501");
    expect((await pgError(() => register({ patient, actor: profiles.drA }))).code).toBe("42501");
    expect((await pgError(() => register({ patient, actor: profiles.receptionB }))).code).toBe("42501");
    // Another clinic's doctor, service or patient.
    expect((await pgError(() => register({ patient, doctor: doctors.b }))).hint).toBe("doctor_not_found");
    expect((await pgError(() => register({ patient, services: [services.b] }))).hint).toBe("service_not_found");
    const foreignPatient = await newPatient(clinicB);
    expect((await pgError(() => register({ patient: foreignPatient }))).hint).toBe("patient_not_found");
    expect((await pgError(() => register({ patient, services: [services.consult, services.consult] }))).hint).toBe("invalid_services");
    expect((await pgError(() => register({ newPatient: { full_name: "Ism", date_of_birth: "" } }))).hint).toBe("invalid_patient");
  });

  // ---------- kassa ----------

  it("full payment (cash + terminal split) issues the next queue number; under- or over-payment and stale bills are refused", async () => {
    const r = await register({ patient: await newPatient(), services: [services.consult, services.ecg] });
    expect((await pgError(() => pay(r.visit_id, [{ method: "cash", amount: 100000 }], 230000.5))).hint).toBe("amount_mismatch");
    expect((await pgError(() => pay(r.visit_id, [{ method: "cash", amount: 300000 }], 230000.5))).hint).toBe("amount_mismatch");
    expect((await pgError(() => pay(r.visit_id, [{ method: "cash", amount: 230000.5 }], 150000))).hint).toBe("stale");
    expect((await pgError(() => pay(r.visit_id, [{ method: "cash", amount: 100000 }, { method: "cash", amount: 130000.5 }], 230000.5))).hint).toBe("invalid_request");
    // Reception cannot take money.
    expect((await pgError(() => pay(r.visit_id, [{ method: "cash", amount: 230000.5 }], 230000.5, profiles.reception))).code).toBe("42501");

    const key = randomUUID();
    const paid = await pay(r.visit_id, [{ method: "cash", amount: 30000.5 }, { method: "terminal", amount: 200000 }], 230000.5, profiles.cashier, key);
    expect(paid.queue_number).toBeGreaterThan(0);
    const v = await visitRow(r.visit_id);
    expect(v).toMatchObject({ status: "waiting", queue_number: paid.queue_number });
    expect(await balance(r.visit_id)).toMatchObject({ outstanding: 0, collected: 230000.5, cash_net: 30000.5, terminal_net: 200000 });
    // Printing a second receipt / retrying the same request records nothing new.
    expect(await pay(r.visit_id, [{ method: "cash", amount: 30000.5 }, { method: "terminal", amount: 200000 }], 230000.5, profiles.cashier, key)).toMatchObject({ replayed: true });
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from public.visit_transactions where visit_id = ${r.visit_id}`;
    expect(n).toBe(2);
    expect((await pgError(() => pay(r.visit_id, [{ method: "cash", amount: 1 }], 0))).hint).toBe("nothing_due");
  });

  it("concurrent payments of one bill: exactly one is recorded", async () => {
    const r = await register({ patient: await newPatient() });
    const outcomes = await Promise.allSettled(
      Array.from({ length: 6 }, () => pay(r.visit_id, [{ method: "cash", amount: 150000 }], 150000)),
    );
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect((await balance(r.visit_id)).collected).toBe(150000);
  });

  it("concurrent payments of different visits get distinct consecutive numbers for the clinic day", async () => {
    const visits = await Promise.all(Array.from({ length: 8 }, async () => (await register({ patient: await newPatient() })).visit_id));
    const paid = await Promise.all(visits.map((v) => pay(v, [{ method: "cash", amount: 150000 }], 150000)));
    const numbers = paid.map((p) => p.queue_number!).sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(8);
    expect(numbers[7] - numbers[0]).toBe(7);
  });

  it("a free visit is queued at once; queue_after_payment = false queues at registration", async () => {
    const free = await register({ patient: await newPatient(), services: [services.free] });
    expect((await visitRow(free.visit_id)).queue_number).not.toBeNull();
    await sql`update public.clinics set queue_after_payment = false where id = ${clinicA}`;
    try {
      const r = await register({ patient: await newPatient() });
      expect(await visitRow(r.visit_id)).toMatchObject({ status: "waiting" });
      expect((await visitRow(r.visit_id)).queue_number).not.toBeNull();
    } finally {
      await sql`update public.clinics set queue_after_payment = true where id = ${clinicA}`;
    }
  });

  // ---------- refunds ----------

  it("refunds: owner and manager yes, admin no, cashier only with a manager's grant — partial, by method, with a reason", async () => {
    const r = await register({ patient: await newPatient(), services: [services.consult, services.ecg] });
    await pay(r.visit_id, [{ method: "cash", amount: 30000.5 }, { method: "terminal", amount: 200000 }], 230000.5);

    expect((await pgError(() => refund(r.visit_id, "terminal", 1000, profiles.admin))).code).toBe("42501");
    expect((await pgError(() => refund(r.visit_id, "terminal", 1000, profiles.reception))).code).toBe("42501");
    expect((await pgError(() => refund(r.visit_id, "terminal", 1000, profiles.cashier2))).hint).toBe("refund_not_permitted");
    expect((await pgError(() => refund(r.visit_id, "terminal", 1000, profiles.manager, "  "))).hint).toBe("reason_required");
    // More than was paid by that method.
    expect((await pgError(() => refund(r.visit_id, "cash", 30001, profiles.manager))).hint).toBe("refund_exceeds_paid");

    await refund(r.visit_id, "terminal", 80000.5, profiles.manager);
    expect(await balance(r.visit_id)).toMatchObject({ refunded: 80000.5, terminal_net: 119999.5, outstanding: 80000.5 });

    // The manager authorizes cashier2; cashier2's refund records both people.
    await asServer((tx) => tx`select public.grant_refund_permission(${clinicA}, ${profiles.manager}, ${profiles.cashier2})`);
    expect((await pgError(() => asServer((tx) => tx`select public.grant_refund_permission(${clinicA}, ${profiles.cashier}, ${profiles.cashier2})`))).code).toBe("42501");
    expect((await pgError(() => asServer((tx) => tx`select public.grant_refund_permission(${clinicA}, ${profiles.manager}, ${profiles.reception})`))).hint).toBe("not_a_cashier");
    await refund(r.visit_id, "cash", 10000, profiles.cashier2);
    const [row] = await sql<{ executed_by: string; authorized_by: string; refund_grant_id: string | null }[]>`
      select executed_by, authorized_by, refund_grant_id from public.visit_transactions
       where visit_id = ${r.visit_id} and kind = 'refund' and method = 'cash'`;
    expect(row).toMatchObject({ executed_by: profiles.cashier2, authorized_by: profiles.manager });
    expect(row.refund_grant_id).not.toBeNull();

    // Revoked: no more refunds by that cashier.
    await asServer((tx) => tx`select public.revoke_refund_permission(${clinicA}, ${profiles.owner}, ${profiles.cashier2}, 'Smena tugadi')`);
    expect((await pgError(() => refund(r.visit_id, "cash", 1000, profiles.cashier2))).hint).toBe("refund_not_permitted");
    // The owner refunds on their own authority.
    await refund(r.visit_id, "cash", 20000.5, profiles.owner);
    expect(await balance(r.visit_id)).toMatchObject({ cash_net: 0 });
  });

  it("concurrent refunds never pay back more than was collected", async () => {
    const r = await register({ patient: await newPatient() });
    await pay(r.visit_id, [{ method: "cash", amount: 150000 }], 150000);
    await Promise.allSettled(Array.from({ length: 6 }, () => refund(r.visit_id, "cash", 100000, profiles.manager)));
    expect((await balance(r.visit_id)).refunded).toBe(100000);
  });

  // ---------- corrections and cancellation ----------

  it("a wrong service is voided (never edited); a void or cancel that would leave money unreturned is refused", async () => {
    const r = await register({ patient: await newPatient(), services: [services.consult, services.ecg] });
    const [ecg] = await sql<{ id: string }[]>`select id from public.visit_charges where visit_id = ${r.visit_id} and service_id = ${services.ecg}`;
    expect((await pgError(() => asServer((tx) => tx`select public.void_visit_charge(${clinicA}, ${profiles.reception}, ${ecg.id}, '')`))).hint).toBe("reason_required");
    await asServer((tx) => tx`select public.void_visit_charge(${clinicA}, ${profiles.reception}, ${ecg.id}, 'Noto‘g‘ri xizmat tanlandi')`);
    expect(await balance(r.visit_id)).toMatchObject({ charged: 150000, outstanding: 150000 });

    await pay(r.visit_id, [{ method: "terminal", amount: 150000 }], 150000);
    const [consult] = await sql<{ id: string }[]>`select id from public.visit_charges where visit_id = ${r.visit_id} and status = 'active'`;
    expect((await pgError(() => asServer((tx) => tx`select public.void_visit_charge(${clinicA}, ${profiles.reception}, ${consult.id}, 'Xato')`))).hint).toBe("refund_first");
    expect((await pgError(() => transition(r.visit_id, "waiting", "cancelled", profiles.reception, "Bemor ketdi"))).hint).toBe("refund_first");

    await refund(r.visit_id, "terminal", 150000, profiles.manager);
    await transition(r.visit_id, "waiting", "cancelled", profiles.reception, "Bemor ketdi");
    expect(await balance(r.visit_id)).toMatchObject({ charged: 0, collected: 150000, refunded: 150000, outstanding: 0 });
    expect((await visitRow(r.visit_id)).status).toBe("cancelled");
    expect((await pgError(() => pay(r.visit_id, [{ method: "cash", amount: 1 }], 0))).hint).toBe("visit_cancelled");
  });

  it("charges and the ledger cannot be changed or deleted, even by the server; signed-in roles reach nothing", async () => {
    const r = await register({ patient: await newPatient() });
    await pay(r.visit_id, [{ method: "cash", amount: 150000 }], 150000);
    expect((await pgError(() => sql`update public.visit_transactions set amount = 1 where visit_id = ${r.visit_id}`)).code).toBe("42501");
    expect((await pgError(() => sql`delete from public.visit_transactions where visit_id = ${r.visit_id}`)).code).toBe("42501");
    expect((await pgError(() => sql`update public.visit_charges set amount = 1, unit_price = 1 where visit_id = ${r.visit_id}`)).code).toBe("42501");
    expect((await pgError(() => sql`delete from public.visit_charges where visit_id = ${r.visit_id}`)).code).toBe("42501");
    expect((await pgError(() => sql`update public.patients set patient_number = 1 where id = (select patient_id from public.visits where id = ${r.visit_id})`)).code).toBe("42501");

    for (const table of ["visits", "visit_charges", "visit_transactions", "refund_grants", "clinic_counters"]) {
      const e = await pgError(() => asUser(profiles.owner, (tx) => tx.unsafe(`select 1 from public.${table} limit 1`)));
      expect(e.code, table).toBe("42501");
    }
    const e = await pgError(() => asUser(profiles.owner, (tx) => tx`select public.register_arrival(${clinicA}, ${profiles.owner}, ${randomUUID()}, null, null, ${doctors.a}, ${[services.consult]}::uuid[])`));
    expect(e.code).toBe("42501");
  });

  // ---------- the queue ----------

  it("an unfinished visit from an earlier day stays in the queue with its own day's number", async () => {
    const r = await register({ patient: await newPatient() });
    await pay(r.visit_id, [{ method: "cash", amount: 150000 }], 150000);
    // Move its queue day back, as if registered yesterday evening.
    await sql`update public.visits set queue_date = queue_date - 1 where id = ${r.visit_id}`;
    const open = await sql<{ id: string }[]>`
      select id from public.visits where clinic_id = ${clinicA} and status in ('waiting', 'called')
       order by queue_date, queue_number`;
    expect(open[0].id).toBe(r.visit_id);
    await transition(r.visit_id, "waiting", "called", profiles.reception);
    expect((await pgError(() => transition(r.visit_id, "waiting", "called", profiles.reception))).hint).toBe("stale");
  });

  it("the visit's doctor starts the consultation without a second bill, writes as usual and completes; others cannot", async () => {
    if (minutesToClinicMidnight() < 8) return; // a walk-in must end before midnight in the clinic
    const patient = await newPatient();
    const r = await register({ patient });
    await pay(r.visit_id, [{ method: "cash", amount: 150000 }], 150000);
    const startAs = (actor: string) =>
      asServer((tx) => tx<{ r: { appointment_id: string } }[]>`select public.start_visit_consultation(${clinicA}, ${actor}, ${r.visit_id}, 'waiting') as r`);
    expect((await pgError(() => startAs(profiles.drC))).code).toBe("42501");
    expect((await pgError(() => startAs(profiles.reception))).code).toBe("42501");

    const [{ r: started }] = await startAs(profiles.drA);
    const v = await visitRow(r.visit_id);
    expect(v).toMatchObject({ status: "in_progress", appointment_id: started.appointment_id });
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from public.payments where appointment_id = ${started.appointment_id}`;
    expect(n).toBe(0);
    const [appt] = await sql<{ status: string; source: string }[]>`select status, source from public.appointments where id = ${started.appointment_id}`;
    expect(appt).toEqual({ status: "in_progress", source: "walk_in" });

    // Dr A may read and write for this patient; Dr C has no relationship.
    const [access] = await sql<{ own_patient: boolean }[]>`select own_patient from public.doctor_patient_access(${doctors.a}, ${patient})`;
    expect(access.own_patient).toBe(true);
    const [other] = await sql<{ own_patient: boolean }[]>`select own_patient from public.doctor_patient_access(${doctors.c}, ${patient})`;
    expect(other.own_patient).toBe(false);

    expect((await pgError(() => transition(r.visit_id, "in_progress", "completed", profiles.reception))).hint).toBe("invalid_transition");
    await transition(r.visit_id, "in_progress", "completed", profiles.drA);
    const [after] = await sql<{ status: string }[]>`select status from public.appointments where id = ${started.appointment_id}`;
    expect(after.status).toBe("completed");
  });

  it("after completing one walk-in the doctor can start the next queued patient at once (the slot ends when the visit does)", async () => {
    if (minutesToClinicMidnight() < 8) return;
    const first = await register({ patient: await newPatient(), doctor: doctors.c });
    const second = await register({ patient: await newPatient(), doctor: doctors.c });
    for (const r of [first, second]) await pay(r.visit_id, [{ method: "cash", amount: 150000 }], 150000);
    const start = (visit: string) =>
      asServer((tx) => tx<{ r: { appointment_id: string } }[]>`select public.start_visit_consultation(${clinicA}, ${profiles.drC}, ${visit}, 'waiting') as r`);
    const [{ r: a }] = await start(first.visit_id);
    // Let the clock pass the first consultation's start minute, as a real visit does.
    await sql`update public.appointments set start_at = start_at - interval '2 minutes', end_at = end_at - interval '2 minutes' where id = ${a.appointment_id}`;
    await transition(first.visit_id, "in_progress", "completed", profiles.drC);
    const [ended] = await sql<{ status: string; ends_now: boolean }[]>`
      select status, end_at <= now() + interval '1 second' as ends_now from public.appointments where id = ${a.appointment_id}`;
    expect(ended).toEqual({ status: "completed", ends_now: true });
    // The 5-minute service booked for the first patient no longer blocks the second.
    const [{ r: b }] = await start(second.visit_id);
    expect(b.appointment_id).toEqual(expect.any(String));
  });

  it("a waiting walk-in gives its doctor access (own relationship) before the consultation starts", async () => {
    const patient = await newPatient();
    await register({ patient, doctor: doctors.c });
    const [row] = await sql<{ own_patient: boolean }[]>`select own_patient from public.doctor_patient_access(${doctors.c}, ${patient})`;
    expect(row.own_patient).toBe(true);
  });

  it("a pending referral shares the referring doctor's history at once — no accept step", async () => {
    const patient = await newPatient();
    const [appt] = await sql<{ id: string }[]>`insert into public.appointments ${sql({
      clinic_id: clinicA, patient_id: patient, doctor_id: doctors.a, service_id: services.consult,
      start_at: new Date(Date.UTC(2026, 0, 5, 5, 0)), end_at: new Date(Date.UTC(2026, 0, 5, 5, 5)), status: "completed", source: "walk_in",
    })} returning id`;
    const [ref] = await sql<{ id: string }[]>`insert into public.referrals ${sql({
      clinic_id: clinicA, patient_id: patient, referring_doctor_id: doctors.a, referred_to_doctor_id: doctors.c,
      originating_appointment_id: appt.id, reason: "Kardiolog ko‘rigi", created_by: profiles.drA,
    })} returning id`;
    const [row] = await sql<{ history_doctor_ids: string[]; active_referral_ids: string[] }[]>`
      select history_doctor_ids, active_referral_ids from public.doctor_patient_access(${doctors.c}, ${patient})`;
    expect(row.active_referral_ids).toEqual([ref.id]);
    expect(row.history_doctor_ids).toEqual([doctors.a]);
    // Revoked: the shared history closes again.
    await sql`update public.referrals set status = 'revoked', revoked_at = now(), revoked_by = ${profiles.drA}, revoked_reason = 'Xato' where id = ${ref.id}`;
    const [closed] = await sql<{ history_doctor_ids: string[] }[]>`select history_doctor_ids from public.doctor_patient_access(${doctors.c}, ${patient})`;
    expect(closed.history_doctor_ids).toEqual([]);
  });

  it("queue tickets go only to the patient's own verified Telegram chat", async () => {
    const tg = 970_000_000 + Math.floor(Math.random() * 1_000_000);
    const [p] = await sql<{ id: string }[]>`insert into public.patients ${sql({ clinic_id: clinicA, full_name: "Telegram bemor", date_of_birth: "1990-01-01", telegram_user_id: tg })} returning id`;
    const r = await register({ patient: p.id });
    await pay(r.visit_id, [{ method: "cash", amount: 150000 }], 150000);
    const jobs = await sql<{ type: string; patient_telegram_user_id: string; status: string }[]>`
      select type, patient_telegram_user_id, status from public.notification_jobs where visit_id = ${r.visit_id}`;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ type: "queue_ticket", status: "pending" });
    expect(Number(jobs[0].patient_telegram_user_id)).toBe(tg);
    // No Telegram identity: nothing is queued for sending.
    const r2 = await register({ patient: await newPatient() });
    await pay(r2.visit_id, [{ method: "cash", amount: 150000 }], 150000);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from public.notification_jobs where visit_id = ${r2.visit_id}`;
    expect(n).toBe(0);
  });
});
