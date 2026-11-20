import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

/**
 * Laboratory security review (Phase 19, docs/labs/SECURITY_REVIEW.md) — the
 * DATABASE layer, attacked the way PostgREST runs a signed-in request
 * (`set local role authenticated` + the user's JWT claims) and the way a
 * compromised or buggy server path would (service_role).
 *
 * Every statement here is an attack; the expected result is a refusal or an
 * empty answer. Regression tests for findings F1 (TRUNCATE / MAINTAIN on
 * public tables) and F2 (payment amounts readable directly) are marked.
 */

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

async function probeDatabase(): Promise<string | null> {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    const [row] = await probe<{ ok: boolean; roles: boolean }[]>`
      select to_regclass('public.lab_results') is not null as ok,
             pg_has_role(current_user, 'authenticated', 'MEMBER') and pg_has_role(current_user, 'service_role', 'MEMBER') as roles`;
    if (!row.ok) return "lab migrations not applied";
    if (!row.roles) return "database user cannot switch roles";
    return null;
  } catch (e) {
    return `database unreachable — ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    await probe.end({ timeout: 1 });
  }
}

const unavailable = await probeDatabase();
if (unavailable) process.stderr.write(`\n⚠️  lab security review database suite SKIPPED (${unavailable})\n\n`);
const describeDb = describe.skipIf(unavailable !== null);

type Tx = postgres.TransactionSql;

async function pgError(run: () => Promise<unknown>): Promise<postgres.PostgresError> {
  try {
    await run();
  } catch (e) {
    if (e instanceof postgres.PostgresError) return e;
    throw e;
  }
  throw new Error("expected the database to refuse the statement");
}

/** Tables holding laboratory data (catalog included). */
const LAB_TABLES = [
  "lab_test_categories", "lab_tests", "lab_test_parameters", "lab_reference_ranges", "lab_panels", "lab_panel_tests",
  "lab_orders", "lab_order_items", "lab_samples", "lab_sample_items", "lab_results", "lab_result_values", "lab_documents",
  "lab_import_batches", "lab_import_rows", "lab_providers", "lab_provider_codes", "lab_external_requests",
];
/** Signed-in roles never read these directly: results, documents, imports, provider data, orders and samples go through the server. */
const SERVER_ONLY = LAB_TABLES.filter((t) => !["lab_test_categories", "lab_tests", "lab_test_parameters", "lab_reference_ranges", "lab_panels", "lab_panel_tests"].includes(t));
/** The only functions signed-in users may execute: RLS helpers, plus one pure normaliser. */
const CALLABLE_BY_SIGNED_IN = ["current_doctor_id", "doctor_can_read_appointment", "doctor_can_read_patient", "is_clinic_staff", "is_linked_doctor", "is_platform_admin", "normalize_identity_document"];

describeDb("lab security review — database layer", () => {
  let sql: postgres.Sql;
  const suffix = Date.now().toString(36);
  const clinicA = randomUUID();
  const clinicB = randomUUID();
  const p = {
    owner: randomUUID(), admin: randomUUID(), manager: randomUUID(), reception: randomUUID(),
    lab1: randomUUID(), lab2: randomUUID(), drA: randomUUID(), drC: randomUUID(), labB: randomUUID(), ownerB: randomUUID(),
  };
  const doctors = { a: randomUUID(), c: randomUUID() };
  const service = randomUUID();
  const fx = { testA: "", paramA: "", testB: "", paramB: "", patientX: "", patientY: "", orderX: "", itemX: "", resultX: "", orderY: "", itemY: "", resultY: "" };

  async function as<T>(role: "anon" | "authenticated" | "service_role", sub: string | null, run: (tx: Tx) => Promise<T>): Promise<T> {
    return (await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${role}`);
      await tx`select set_config('request.jwt.claims', ${JSON.stringify(sub ? { sub, role } : { role })}, true)`;
      return run(tx);
    })) as T;
  }
  const asUser = <T>(id: string, run: (tx: Tx) => Promise<T>) => as("authenticated", id, run);
  const asServer = <T>(run: (tx: Tx) => Promise<T>) => as("service_role", null, run);

  /** A verified result for a fresh order of `test` for `patient` in `clinic` (lab1 enters, lab2 verifies). */
  async function verifiedResult(clinic: string, patient: string, test: string, param: string, value: number, staff: { order: string; enter: string; verify: string }) {
    return asServer(async (tx) => {
      const [o] = await tx<{ lab_order_id: string }[]>`select * from public.create_lab_order(${clinic}, ${patient}, ${staff.order}, 'walk_in', ${[test]}::uuid[], '{}'::uuid[])`;
      const [i] = await tx<{ id: string }[]>`select id from public.lab_order_items where order_id = ${o.lab_order_id}`;
      const [s] = await tx<{ lab_sample_id: string }[]>`select * from public.collect_lab_sample(${clinic}, ${o.lab_order_id}, ${[i.id]}::uuid[], ${staff.enter})`;
      await tx`select public.receive_lab_sample(${clinic}, ${s.lab_sample_id}, ${staff.enter})`;
      const [r] = await tx<{ lab_result_id: string }[]>`select * from public.save_lab_result_draft(${clinic}, ${i.id}, ${staff.enter}, ${tx.json([{ parameter_id: param, value_numeric: value }])}::jsonb, null, null)`;
      await tx`select public.submit_lab_result(${clinic}, ${r.lab_result_id}, ${staff.enter})`;
      await tx`select public.verify_lab_result(${clinic}, ${r.lab_result_id}, ${staff.verify})`;
      return { order: o.lab_order_id, item: i.id, result: r.lab_result_id };
    });
  }

  beforeAll(async () => {
    sql = postgres(DB_URL, { max: 8, onnotice: () => {} });
    await sql`insert into public.clinics ${sql([
      { id: clinicA, name: `Sec A ${suffix}`, slug: `sec-a-${suffix}`, timezone: "Asia/Tashkent" },
      { id: clinicB, name: `Sec B ${suffix}`, slug: `sec-b-${suffix}`, timezone: "Asia/Tashkent" },
    ])}`;
    const users = Object.entries(p).map(([name, id]) => ({ id, email: `sec-${name}-${suffix}@test.local` }));
    await sql`insert into auth.users ${sql(users)}`;
    await sql`insert into public.profiles ${sql(users.map((u) => ({ id: u.id, full_name: u.email })))}`;
    await sql`insert into public.staff_roles ${sql([
      { clinic_id: clinicA, profile_id: p.owner, role: "owner" },
      { clinic_id: clinicA, profile_id: p.admin, role: "admin" },
      { clinic_id: clinicA, profile_id: p.manager, role: "manager" },
      { clinic_id: clinicA, profile_id: p.reception, role: "receptionist" },
      { clinic_id: clinicA, profile_id: p.lab1, role: "lab" },
      { clinic_id: clinicA, profile_id: p.lab2, role: "lab" },
      { clinic_id: clinicA, profile_id: p.drA, role: "doctor" },
      { clinic_id: clinicA, profile_id: p.drC, role: "doctor" },
      { clinic_id: clinicB, profile_id: p.labB, role: "lab" },
      { clinic_id: clinicB, profile_id: p.ownerB, role: "owner" },
    ])}`;
    await sql`insert into public.doctors ${sql([
      { id: doctors.a, clinic_id: clinicA, profile_id: p.drA, name: `Dr A ${suffix}`, active: true },
      { id: doctors.c, clinic_id: clinicA, profile_id: p.drC, name: `Dr C ${suffix}`, active: true },
    ])}`;
    await sql`insert into public.services ${sql({ id: service, clinic_id: clinicA, name: `Sec consult ${suffix}`, duration_minutes: 30, price: 1 })}`;
    await sql`insert into public.doctor_working_hours ${sql([1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinic_id: clinicA, doctor_id: doctors.a, weekday, start_time: "00:00", end_time: "23:59" })))}`;

    const [tA] = await sql`insert into public.lab_tests ${sql({ clinic_id: clinicA, code: `SECA${suffix}`, name: "Sec test A", sample_type: "Qon", price: 50000 })} returning id`;
    const [pA] = await sql`insert into public.lab_test_parameters ${sql({ clinic_id: clinicA, test_id: tA.id, code: "HGB", name: "Gemoglobin", value_type: "numeric", unit: "g/L" })} returning id`;
    const [tB] = await sql`insert into public.lab_tests ${sql({ clinic_id: clinicB, code: `SECB${suffix}`, name: "Sec test B", sample_type: "Qon", price: 70000 })} returning id`;
    const [pB] = await sql`insert into public.lab_test_parameters ${sql({ clinic_id: clinicB, test_id: tB.id, code: "HGB", name: "Gemoglobin", value_type: "numeric", unit: "g/L" })} returning id`;
    Object.assign(fx, { testA: tA.id, paramA: pA.id, testB: tB.id, paramB: pB.id });
    const [x] = await sql`insert into public.patients ${sql({ clinic_id: clinicA, full_name: `Sec X ${suffix}`, date_of_birth: "1980-01-01" })} returning id`;
    const [y] = await sql`insert into public.patients ${sql({ clinic_id: clinicB, full_name: `Sec Y ${suffix}`, date_of_birth: "1981-01-01" })} returning id`;
    fx.patientX = x.id;
    fx.patientY = y.id;
    const start = new Date(Date.UTC(2023, 0, 2, 5, 0));
    await sql`insert into public.appointments ${sql({ clinic_id: clinicA, patient_id: x.id, doctor_id: doctors.a, service_id: service, start_at: start, end_at: new Date(start.getTime() + 1_800_000), status: "completed", source: "walk_in" })}`;

    const rx = await verifiedResult(clinicA, x.id, tA.id, pA.id, 140, { order: p.reception, enter: p.lab1, verify: p.lab2 });
    Object.assign(fx, { orderX: rx.order, itemX: rx.item, resultX: rx.result });
    // Clinic B needs a second lab user to verify (second person).
    const labB2 = randomUUID();
    await sql`insert into auth.users ${sql({ id: labB2, email: `sec-labB2-${suffix}@test.local` })}`;
    await sql`insert into public.profiles ${sql({ id: labB2, full_name: "labB2" })}`;
    await sql`insert into public.staff_roles ${sql({ clinic_id: clinicB, profile_id: labB2, role: "lab" })}`;
    (p as Record<string, string>).labB2 = labB2;
    const ry = await verifiedResult(clinicB, y.id, tB.id, pB.id, 99, { order: p.labB, enter: p.labB, verify: labB2 });
    Object.assign(fx, { orderY: ry.order, itemY: ry.item, resultY: ry.result });
  }, 60_000);

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from public.clinics where id in ${sql([clinicA, clinicB])}`;
    await sql`delete from auth.users where id in ${sql(Object.values(p))}`;
    await sql.end({ timeout: 5 });
  });

  // ---------------------------------------------------------------- F1, grants

  it("F1: no signed-in or anonymous role holds TRUNCATE, REFERENCES, TRIGGER or MAINTAIN on any public table, now or by default", async () => {
    const rows = await sql<{ relname: string; role: string; priv: string }[]>`
      select c.relname, r.role, x.priv
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      cross join (values ('anon'), ('authenticated')) r(role)
      cross join (values ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) x(priv)
      where n.nspname = 'public' and c.relkind in ('r', 'p') and has_table_privilege(r.role, c.oid, x.priv)`;
    expect(rows).toEqual([]);
    const [{ v }] = await sql<{ v: number }[]>`select current_setting('server_version_num')::int as v`;
    if (v >= 170000) {
      const maintain = await sql`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and (has_table_privilege('authenticated', c.oid, 'MAINTAIN') or has_table_privilege('anon', c.oid, 'MAINTAIN'))`;
      expect(maintain).toEqual([]);
    }
    // A new table must not get them either.
    await sql.begin(async (tx) => {
      await tx`create table public.sec_review_probe (id int)`;
      const [g] = await tx<{ t: boolean; r: boolean }[]>`select has_table_privilege('authenticated', 'public.sec_review_probe', 'TRUNCATE') as t, has_table_privilege('authenticated', 'public.sec_review_probe', 'REFERENCES') as r`;
      expect(g).toEqual({ t: false, r: false });
      await tx`drop table public.sec_review_probe`;
    });
    // And the attack itself: emptying every clinic's settings as a signed-in manager.
    expect((await pgError(() => asUser(p.manager, (tx) => tx`truncate public.app_settings`))).code).toBe("42501");
    expect((await pgError(() => asUser(p.lab1, (tx) => tx`truncate public.staff_roles`))).code).toBe("42501");
  });

  // ---------------------------------------------------------------- direct reads

  it("signed-in roles read no result, document, import, provider, order or sample table directly; anonymous reads nothing", async () => {
    for (const who of [p.owner, p.manager, p.reception, p.lab1, p.drA, p.labB]) {
      for (const table of SERVER_ONLY) {
        expect((await pgError(() => asUser(who, (tx) => tx`select * from ${tx(table)} limit 1`))).code, `${table}`).toBe("42501");
      }
    }
    for (const table of LAB_TABLES) {
      expect((await pgError(() => as("anon", null, (tx) => tx`select * from ${tx(table)} limit 1`))).code, `anon ${table}`).toBe("42501");
    }
  });

  it("1: the catalog is readable only within one's own clinic", async () => {
    for (const table of ["lab_tests", "lab_test_parameters"]) {
      const seenByA = await asUser(p.lab1, (tx) => tx<{ clinic_id: string }[]>`select clinic_id from ${tx(table)} where clinic_id = ${clinicB}`);
      expect(seenByA).toEqual([]);
    }
    // Even with a guessed id.
    expect(await asUser(p.owner, (tx) => tx`select id from public.lab_tests where id = ${fx.testB}`)).toEqual([]);
  });

  it("2: no signed-in role writes laboratory data — any clinic, any table", async () => {
    for (const who of [p.owner, p.manager, p.lab1, p.drA]) {
      for (const table of LAB_TABLES) {
        expect((await pgError(() => asUser(who, (tx) => tx`delete from ${tx(table)} where clinic_id = ${clinicB}`))).code, `${table}`).toBe("42501");
        expect((await pgError(() => asUser(who, (tx) => tx`update ${tx(table)} set clinic_id = clinic_id where clinic_id = ${clinicA}`))).code, `${table}`).toBe("42501");
      }
      expect((await pgError(() => asUser(who, (tx) => tx`insert into public.lab_tests ${tx({ clinic_id: clinicB, code: "X", name: "X", sample_type: "Qon", price: 1 })}`))).code).toBe("42501");
    }
  });

  it("no laboratory (or any privileged) function can be called by signed-in or anonymous users", async () => {
    const rows = await sql<{ proname: string }[]>`
      select distinct p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      left join pg_depend d on d.objid = p.oid and d.deptype = 'e'
      where n.nspname = 'public' and d.objid is null and p.prorettype <> 'trigger'::regtype
        and (has_function_privilege('authenticated', p.oid, 'EXECUTE') or has_function_privilege('anon', p.oid, 'EXECUTE'))`;
    expect(rows.map((r) => r.proname).sort()).toEqual([...CALLABLE_BY_SIGNED_IN].sort());
    // And calling one anyway:
    expect((await pgError(() => asUser(p.lab1, (tx) => tx`select public.verify_lab_result(${clinicA}, ${fx.resultX}, ${p.lab1})`))).code).toBe("42501");
    expect((await pgError(() => asUser(p.owner, (tx) => tx`select * from public.create_lab_order(${clinicB}, ${fx.patientY}, ${p.owner}, 'walk_in', ${[fx.testB]}::uuid[], '{}'::uuid[])`))).code).toBe("42501");
    expect((await pgError(() => asUser(p.drA, (tx) => tx`select * from public.lab_doctor_accessible_patients(${clinicA}, ${doctors.a}, ${[fx.patientX]}::uuid[])`))).code).toBe("42501");
  });

  // ---------------------------------------------------------------- F2, payments

  it("F2 / 6 / 9: payment amounts are not readable directly — not by manager, receptionist, doctor or lab — only the status", async () => {
    for (const who of [p.manager, p.reception, p.drA, p.owner]) {
      expect((await pgError(() => asUser(who, (tx) => tx`select amount from public.payments where lab_order_id = ${fx.orderX}`))).code).toBe("42501");
      expect((await pgError(() => asUser(who, (tx) => tx`select metadata, provider_reference, payment_url from public.payments limit 1`))).code).toBe("42501");
    }
    const [row] = await asUser(p.reception, (tx) => tx<{ status: string }[]>`select status from public.payments where lab_order_id = ${fx.orderX}`);
    expect(row.status).toBe("unpaid");
    // Lab staff see no payments at all (RLS), and nobody sees another clinic's.
    expect(await asUser(p.lab1, (tx) => tx`select id from public.payments`)).toEqual([]);
    expect(await asUser(p.owner, (tx) => tx`select id from public.payments where lab_order_id = ${fx.orderY}`)).toEqual([]);
  });

  it("9: payment state cannot be forged — not by a signed-in user, and not even the server can change a paid amount or the subject", async () => {
    expect((await pgError(() => asUser(p.owner, (tx) => tx`update public.payments set status = 'paid' where lab_order_id = ${fx.orderX}`))).code).toBe("42501");
    expect((await pgError(() => asUser(p.owner, (tx) => tx`insert into public.payments ${tx({ clinic_id: clinicA, lab_order_id: fx.orderX, patient_id: fx.patientX, amount: 1, status: "paid" })}`))).code).toBe("42501");
    // The server path: an unpaid lab bill must equal its order; a paid one is frozen.
    expect((await pgError(() => asServer((tx) => tx`update public.payments set amount = 1 where lab_order_id = ${fx.orderX}`))).message).toMatch(/amount/i);
    await asServer((tx) => tx`update public.payments set status = 'paid', paid_at = now() where lab_order_id = ${fx.orderX}`);
    expect((await pgError(() => asServer((tx) => tx`update public.payments set amount = 1 where lab_order_id = ${fx.orderX}`))).message).toMatch(/amount|paid/i);
    expect((await pgError(() => asServer((tx) => tx`update public.payments set lab_order_id = ${fx.orderY} where lab_order_id = ${fx.orderX}`))).message).toBeTruthy();
    // A second bill for the same order is impossible.
    expect((await pgError(() => asServer((tx) => tx`insert into public.payments ${tx({ clinic_id: clinicA, lab_order_id: fx.orderX, patient_id: fx.patientX, amount: 50000 })}`))).code).toBe("23505");
  });

  // ---------------------------------------------------------------- results

  it("10 / 11: a verified result and its history cannot be changed, deleted or re-ordered — even by the server", async () => {
    const refuse = async (run: (tx: Tx) => Promise<unknown>) => expect((await pgError(() => asServer(run))).message).toBeTruthy();
    await refuse((tx) => tx`update public.lab_result_values set value_numeric = 99 where result_id = ${fx.resultX}`);
    await refuse((tx) => tx`delete from public.lab_result_values where result_id = ${fx.resultX}`);
    await refuse((tx) => tx`update public.lab_results set verified_by = ${p.lab1} where id = ${fx.resultX}`); // the enterer as verifier
    await refuse((tx) => tx`update public.lab_results set status = 'draft' where id = ${fx.resultX}`);
    await refuse((tx) => tx`delete from public.lab_results where id = ${fx.resultX}`);
    await refuse((tx) => tx`update public.lab_results set clinic_id = ${clinicB} where id = ${fx.resultX}`);
    // A correction is a new version; the old one is superseded and stays frozen.
    const [c] = await asServer((tx) => tx<{ lab_result_id: string }[]>`select * from public.start_lab_result_correction(${clinicA}, ${fx.resultX}, ${p.lab1}, 'Qayta o‘lchandi')`);
    await asServer(async (tx) => {
      await tx`select public.save_lab_result_draft(${clinicA}, ${fx.itemX}, ${p.lab1}, ${tx.json([{ parameter_id: fx.paramA, value_numeric: 141 }])}::jsonb, null, null)`;
      await tx`select public.submit_lab_result(${clinicA}, ${c.lab_result_id}, ${p.lab1})`;
      await tx`select public.verify_lab_result(${clinicA}, ${c.lab_result_id}, ${p.lab2})`;
    });
    await refuse((tx) => tx`update public.lab_results set status = 'verified' where id = ${fx.resultX}`); // revive the old version
    await refuse((tx) => tx`update public.lab_results set supersedes_result_id = null where id = ${c.lab_result_id}`); // cut the chain
    await refuse((tx) => tx`update public.lab_results set version = 1 where id = ${c.lab_result_id}`); // rewrite the order
    const versions = await sql<{ version: number; status: string }[]>`select version, status from public.lab_results where order_item_id = ${fx.itemX} order by version`;
    expect(versions).toEqual([{ version: 1, status: "superseded" }, { version: 2, status: "verified" }]);
    fx.resultX = c.lab_result_id;
  });

  it("forged verification: nobody verifies their own result; a verified row cannot be inserted directly", async () => {
    const [o] = await asServer((tx) => tx<{ lab_order_id: string }[]>`select * from public.create_lab_order(${clinicA}, ${fx.patientX}, ${p.reception}, 'walk_in', ${[fx.testA]}::uuid[], '{}'::uuid[])`);
    const [i] = await sql<{ id: string }[]>`select id from public.lab_order_items where order_id = ${o.lab_order_id}`;
    const [s] = await asServer((tx) => tx<{ lab_sample_id: string }[]>`select * from public.collect_lab_sample(${clinicA}, ${o.lab_order_id}, ${[i.id]}::uuid[], ${p.lab1})`);
    await asServer((tx) => tx`select public.receive_lab_sample(${clinicA}, ${s.lab_sample_id}, ${p.lab1})`);
    const [r] = await asServer((tx) => tx<{ lab_result_id: string }[]>`select * from public.save_lab_result_draft(${clinicA}, ${i.id}, ${p.lab1}, ${tx.json([{ parameter_id: fx.paramA, value_numeric: 130 }])}::jsonb, null, null)`);
    await asServer((tx) => tx`select public.submit_lab_result(${clinicA}, ${r.lab_result_id}, ${p.lab1})`);
    expect((await pgError(() => asServer((tx) => tx`select public.verify_lab_result(${clinicA}, ${r.lab_result_id}, ${p.lab1})`))).message).toMatch(/second|same|own|enter/i);
    // Another clinic's staff, or the wrong clinic id, cannot verify it.
    expect((await pgError(() => asServer((tx) => tx`select public.verify_lab_result(${clinicB}, ${r.lab_result_id}, ${p.labB})`))).message).toBeTruthy();
    expect((await pgError(() => asServer((tx) => tx`select public.verify_lab_result(${clinicA}, ${r.lab_result_id}, ${p.labB})`))).message).toBeTruthy();
    // F4: a direct update (or a server bug) cannot record an ineligible verifier: not the receptionist, owner or
    // admin, not a doctor without access to the patient, not another clinic's lab staff.
    for (const who of [p.reception, p.owner, p.admin, p.manager, p.drC, p.labB]) {
      const e = await pgError(() => asServer((tx) => tx`update public.lab_results set status = 'verified', verified_by = ${who} where id = ${r.lab_result_id}`));
      expect(e.message, who).toMatch(/verifier|staff member/);
      expect((await pgError(() => asServer((tx) => tx`select public.verify_lab_result(${clinicA}, ${r.lab_result_id}, ${who})`))).message).toMatch(/verifier|staff member/);
    }
    // The clinic's verifier setting holds in the database: lab only → not the patient's doctor; doctor only → not lab staff.
    await sql`insert into public.app_settings ${sql({ clinic_id: clinicA, key: "lab", value: sql.json({ verifiers: "lab_only" }) })} on conflict (clinic_id, key) do update set value = excluded.value`;
    expect((await pgError(() => asServer((tx) => tx`select public.verify_lab_result(${clinicA}, ${r.lab_result_id}, ${p.drA})`))).message).toMatch(/verifier/);
    await sql`update public.app_settings set value = ${sql.json({ verifiers: "doctor_only" })} where clinic_id = ${clinicA} and key = 'lab'`;
    expect((await pgError(() => asServer((tx) => tx`select public.verify_lab_result(${clinicA}, ${r.lab_result_id}, ${p.lab2})`))).message).toMatch(/verifier/);
    await sql`delete from public.app_settings where clinic_id = ${clinicA} and key = 'lab'`;
    // Nor can an ineligible person enter or submit a result.
    const [o2] = await asServer((tx) => tx<{ lab_order_id: string }[]>`select * from public.create_lab_order(${clinicA}, ${fx.patientX}, ${p.reception}, 'walk_in', ${[fx.testA]}::uuid[], '{}'::uuid[])`);
    const [i2] = await sql<{ id: string }[]>`select id from public.lab_order_items where order_id = ${o2.lab_order_id}`;
    const [s2] = await asServer((tx) => tx<{ lab_sample_id: string }[]>`select * from public.collect_lab_sample(${clinicA}, ${o2.lab_order_id}, ${[i2.id]}::uuid[], ${p.reception})`);
    await asServer((tx) => tx`select public.receive_lab_sample(${clinicA}, ${s2.lab_sample_id}, ${p.lab1})`);
    for (const who of [p.reception, p.owner, p.drC]) {
      expect((await pgError(() => asServer((tx) => tx`select public.save_lab_result_draft(${clinicA}, ${i2.id}, ${who}, ${tx.json([{ parameter_id: fx.paramA, value_numeric: 1 }])}::jsonb, null, null)`))).message).toMatch(/entered_by/);
    }
    expect((await pgError(() => asServer((tx) => tx`insert into public.lab_results ${tx({ clinic_id: clinicA, patient_id: fx.patientX, order_item_id: i.id, version: 9, status: "verified", source: "manual", entered_by: p.lab1, verified_by: p.lab2, verified_at: new Date() })}`))).message).toBeTruthy();
  });

  it("concurrent writes end in exactly one final state: two verifiers, two collectors, one idempotent order", async () => {
    const [o] = await asServer((tx) => tx<{ lab_order_id: string }[]>`select * from public.create_lab_order(${clinicA}, ${fx.patientX}, ${p.reception}, 'walk_in', ${[fx.testA]}::uuid[], '{}'::uuid[])`);
    const [i] = await sql<{ id: string }[]>`select id from public.lab_order_items where order_id = ${o.lab_order_id}`;
    // Two desks collect the same test at once: one sample.
    const collects = await Promise.allSettled([p.lab1, p.lab2, p.reception].map((who) => asServer((tx) => tx`select * from public.collect_lab_sample(${clinicA}, ${o.lab_order_id}, ${[i.id]}::uuid[], ${who})`)));
    expect(collects.filter((c) => c.status === "fulfilled")).toHaveLength(1);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from public.lab_sample_items where order_item_id = ${i.id}`;
    expect(n).toBe(1);
    const [s] = await sql<{ id: string }[]>`select sample_id as id from public.lab_sample_items where order_item_id = ${i.id}`;
    await asServer((tx) => tx`select public.receive_lab_sample(${clinicA}, ${s.id}, ${p.lab1})`);
    const [r] = await asServer((tx) => tx<{ lab_result_id: string }[]>`select * from public.save_lab_result_draft(${clinicA}, ${i.id}, ${p.lab1}, ${tx.json([{ parameter_id: fx.paramA, value_numeric: 120 }])}::jsonb, null, null)`);
    await asServer((tx) => tx`select public.submit_lab_result(${clinicA}, ${r.lab_result_id}, ${p.lab1})`);
    // Two second persons verify at the same moment: one verification.
    const doctorVerify = asServer((tx) => tx`select public.verify_lab_result(${clinicA}, ${r.lab_result_id}, ${p.drA})`);
    const labVerify = asServer((tx) => tx`select public.verify_lab_result(${clinicA}, ${r.lab_result_id}, ${p.lab2})`);
    const outcomes = await Promise.allSettled([doctorVerify, labVerify]);
    expect(outcomes.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const audits = await sql`select id from public.audit_events where entity_id = ${r.lab_result_id} and action = 'lab_result_verified'`;
    expect(audits).toHaveLength(1);
    // The same order twice (a repeated request with the same key): one order.
    const key = randomUUID();
    const orders = await Promise.all([1, 2, 3].map(() => asServer((tx) => tx<{ lab_order_id: string }[]>`select * from public.create_lab_order(${clinicA}, ${fx.patientX}, ${p.reception}, 'walk_in', ${[fx.testA]}::uuid[], '{}'::uuid[], ${key})`).then((x) => x[0].lab_order_id).catch(() => "error")));
    expect(new Set(orders.filter((x) => x !== "error")).size).toBe(1);
  });

  // ---------------------------------------------------------------- cross-clinic writes through the server's own functions

  it("13 / 2: the server's functions refuse every clinic mix — another clinic's patient, test, order, sample or staff", async () => {
    const refuse = async (run: (tx: Tx) => Promise<unknown>) => expect((await pgError(() => asServer(run))).message).toBeTruthy();
    await refuse((tx) => tx`select * from public.create_lab_order(${clinicA}, ${fx.patientY}, ${p.reception}, 'walk_in', ${[fx.testA]}::uuid[], '{}'::uuid[])`); // B patient in A
    await refuse((tx) => tx`select * from public.create_lab_order(${clinicA}, ${fx.patientX}, ${p.reception}, 'walk_in', ${[fx.testB]}::uuid[], '{}'::uuid[])`); // B test in A
    await refuse((tx) => tx`select * from public.create_lab_order(${clinicA}, ${fx.patientX}, ${p.labB}, 'walk_in', ${[fx.testA]}::uuid[], '{}'::uuid[])`); // B staff as orderer
    await refuse((tx) => tx`select * from public.collect_lab_sample(${clinicA}, ${fx.orderY}, ${[fx.itemY]}::uuid[], ${p.lab1})`); // B order under A
    await refuse((tx) => tx`select public.save_lab_result_draft(${clinicA}, ${fx.itemY}, ${p.lab1}, ${tx.json([{ parameter_id: fx.paramB, value_numeric: 1 }])}::jsonb, null, null)`);
    await refuse((tx) => tx`select public.start_lab_result_correction(${clinicA}, ${fx.resultY}, ${p.lab1}, 'x')`);
    // Rows that point across clinics cannot exist (composite keys).
    await refuse((tx) => tx`insert into public.lab_order_items ${tx({ clinic_id: clinicA, order_id: fx.orderY, patient_id: fx.patientY, test_id: fx.testB, test_code_snapshot: "X", test_name_snapshot: "X", list_price_snapshot: 1, price_snapshot: 1 })}`);
    await refuse((tx) => tx`update public.lab_orders set patient_id = ${fx.patientY} where id = ${fx.orderX}`);
    // An import row cannot point at another clinic's patient, test or batch.
    const [batch] = await sql`insert into public.lab_import_batches ${sql({
      clinic_id: clinicA, source_system: "old", file_name: "x.csv", file_sha256: "a".repeat(64), status: "uploaded", headers: sql.json(["patient"]), row_count: 3, summary: sql.json({}), created_by: p.lab1,
    })} returning id`;
    await refuse((tx) => tx`insert into public.lab_import_rows ${tx({ clinic_id: clinicA, batch_id: batch.id, row_number: 1, raw: tx.json({}), patient_id: fx.patientY })}`);
    await refuse((tx) => tx`insert into public.lab_import_rows ${tx({ clinic_id: clinicA, batch_id: batch.id, row_number: 2, raw: tx.json({}), test_id: fx.testB })}`);
    await refuse((tx) => tx`insert into public.lab_import_rows ${tx({ clinic_id: clinicB, batch_id: batch.id, row_number: 3, raw: tx.json({}) })}`);
    // And the import never runs under another clinic's id.
    await refuse((tx) => tx`select * from public.run_lab_import(${clinicB}, ${batch.id}, ${p.labB}, true)`);
  });

  it("14: an external provider's result cannot land in another clinic", async () => {
    const refuse = async (run: (tx: Tx) => Promise<unknown>) => expect((await pgError(() => asServer(run))).message).toBeTruthy();
    const [provB] = await sql`insert into public.lab_providers ${sql({ clinic_id: clinicB, code: `prvb-${suffix}`, name: "Prov B", adapter: "mock", config: sql.json({}), active: true, send_patient_name: false, created_by: p.ownerB })} returning id`;
    await sql`insert into public.lab_provider_codes ${sql({ clinic_id: clinicB, provider_id: provB.id, kind: "test", internal_id: fx.testB, external_code: "EXT-B" })}`;
    // Clinic A's test cannot be sent to clinic B's provider (under either clinic's id).
    await refuse((tx) => tx`select * from public.request_external_lab(${clinicA}, ${fx.itemX}, ${provB.id}, ${p.lab1})`);
    await refuse((tx) => tx`select * from public.request_external_lab(${clinicB}, ${fx.itemX}, ${provB.id}, ${p.labB})`);
    // A live send-out in clinic B: its result cannot be recorded under clinic A, nor touch A's tests.
    const [o] = await asServer((tx) => tx<{ lab_order_id: string }[]>`select * from public.create_lab_order(${clinicB}, ${fx.patientY}, ${p.labB}, 'walk_in', ${[fx.testB]}::uuid[], '{}'::uuid[])`);
    const [i] = await sql<{ id: string }[]>`select id from public.lab_order_items where order_id = ${o.lab_order_id}`;
    const [smp] = await asServer((tx) => tx<{ lab_sample_id: string }[]>`select * from public.collect_lab_sample(${clinicB}, ${o.lab_order_id}, ${[i.id]}::uuid[], ${p.labB})`);
    await asServer((tx) => tx`select public.receive_lab_sample(${clinicB}, ${smp.lab_sample_id}, ${p.labB})`);
    const [req] = await asServer((tx) => tx<{ request_id?: string; lab_external_request_id?: string; id?: string }[]>`select * from public.request_external_lab(${clinicB}, ${i.id}, ${provB.id}, ${p.labB})`);
    const reqId = (req.lab_external_request_id ?? req.request_id ?? req.id)!;
    expect(reqId).toBeTruthy();
    await refuse((tx) => tx`select public.record_external_lab_result(${clinicA}, ${reqId}, 'res-1', ${tx.json([{ code: "HGB", value: "1" }])}::jsonb)`);
    // A row tying clinic A's item to clinic B's provider cannot exist.
    await refuse((tx) => tx`insert into public.lab_external_requests ${tx({ clinic_id: clinicA, order_item_id: fx.itemX, provider_id: provB.id, requested_by: p.lab1 })}`);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from public.lab_results where order_item_id = ${fx.itemX} and source = 'external'`;
    expect(n).toBe(0);
  });

  // ---------------------------------------------------------------- audit

  it("12: audit history is append-only — signed-in users cannot touch it, and not even the server can rewrite it", async () => {
    const [row] = await sql<{ id: string }[]>`select id from public.audit_events where clinic_id = ${clinicA} limit 1`;
    expect(row).toBeTruthy();
    for (const who of [p.owner, p.admin]) {
      expect((await pgError(() => asUser(who, (tx) => tx`update public.audit_events set action = 'x' where id = ${row.id}`))).code).toBe("42501");
      expect((await pgError(() => asUser(who, (tx) => tx`delete from public.audit_events where id = ${row.id}`))).code).toBe("42501");
      expect((await pgError(() => asUser(who, (tx) => tx`insert into public.audit_events ${tx({ clinic_id: clinicA, action: "forged", entity_type: "x" })}`))).code).toBe("42501");
    }
    expect((await pgError(() => asServer((tx) => tx`update public.audit_events set action = 'x' where id = ${row.id}`))).message).toBeTruthy();
    expect((await pgError(() => asServer((tx) => tx`delete from public.audit_events where id = ${row.id}`))).message).toBeTruthy();
    // Management reads only its own clinic's audit trail; nobody else reads it.
    expect(await asUser(p.owner, (tx) => tx`select id from public.audit_events where clinic_id = ${clinicB}`)).toEqual([]);
    expect(await asUser(p.lab1, (tx) => tx`select id from public.audit_events`)).toEqual([]);
    // And it never carries a value.
    const values = await sql<{ metadata: unknown }[]>`select metadata from public.audit_events where clinic_id = ${clinicA} and entity_type like 'lab_%'`;
    expect(JSON.stringify(values)).not.toMatch(/value_numeric|"140"|"141"|"130"/);
  });

  it("7: patients have no database identity: anonymous gets nothing, a signed-in non-staff user sees no patient or lab row", async () => {
    const outsider = randomUUID();
    await sql`insert into auth.users ${sql({ id: outsider, email: `sec-outsider-${suffix}@test.local` })}`;
    try {
      expect(await asUser(outsider, (tx) => tx`select id from public.patients`)).toEqual([]);
      expect(await asUser(outsider, (tx) => tx`select id from public.lab_tests`)).toEqual([]);
      expect((await pgError(() => asUser(outsider, (tx) => tx`select id from public.lab_results`))).code).toBe("42501");
      expect((await pgError(() => as("anon", null, (tx) => tx`select id from public.patients`))).code).toBe("42501");
    } finally {
      await sql`delete from auth.users where id = ${outsider}`;
    }
  });

  it("documents: the bucket is private and only the server role can reach it", async () => {
    const [bucket] = await sql<{ public: boolean }[]>`select public from storage.buckets where id = 'lab-documents'`;
    expect(bucket.public).toBe(false);
    const policies = await sql<{ roles: string[] }[]>`select roles::text[] as roles from pg_policies where schemaname = 'storage' and qual like '%lab-documents%'`;
    expect(policies.flatMap((x) => x.roles)).toEqual(["service_role"]);
  });
});
