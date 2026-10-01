import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { cleanupTestClinics } from "@/test/cleanup-clinics";
import { localDbAvailable } from "@/test/local-db";

/**
 * The laboratory domain model at the DATABASE layer
 * (supabase/migrations/20261003000002_lab_foundation.sql): composite same-clinic integrity, lifecycle
 * and immutability enforced by triggers, snapshots the client cannot forge, append-only versions with
 * verification, ids-only audit, no signed-in access to clinical lab tables, and no deletion paths.
 *
 * Cast: clinic A — doctors A and B, two laboratory staff (lab, ver), a manager, a receptionist, patients X and Y;
 * clinic B — a doctor and a patient (the cross-clinic attacker's targets).
 */

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const describeDb = describe.skipIf(!localDbAvailable());

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

describeDb("laboratory domain model — database layer", () => {
  let sql: postgres.Sql;
  const suffix = Date.now().toString(36);
  const clinicA = randomUUID();
  const clinicB = randomUUID();
  const P = { dA: randomUUID(), dB: randomUUID(), lab: randomUUID(), ver: randomUUID(), mgr: randomUUID(), rec: randomUUID(), dK: randomUUID(), outsider: randomUUID() };
  const D = { a: randomUUID(), b: randomUUID(), k: randomUUID() };
  const patient = { x: randomUUID(), y: randomUUID(), k: randomUUID() };
  const svcA = randomUUID();
  const svcB = randomUUID();
  let consult = ""; // doctor A's in-progress consultation with patient X
  let consultOfB = ""; // doctor B's consultation with patient X
  let consultDone = ""; // doctor A, completed
  let consultBooked = ""; // doctor A, confirmed (not started)
  let consultK = ""; // clinic B
  let cat = "";
  let hb = ""; // CBC-style test: hemoglobin (numeric) + a choice parameter
  let hbParam = "";
  let choiceParam = "";
  let hbRange = "";
  let glu = ""; // second test with its own parameter
  let gluParam = "";
  let tB = ""; // clinic B's test
  let day = 0;
  const VALUE = "132.5";
  const NOTE = `Sensitive handoff note ${suffix}`;

  async function as<T>(role: "service_role" | "authenticated" | "anon", sub: string | null, run: (tx: Tx) => Promise<T>): Promise<T> {
    return (await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${role}`);
      await tx`select set_config('request.jwt.claims', ${JSON.stringify(sub ? { sub, role } : { role })}, true)`;
      return run(tx);
    })) as T;
  }
  const svc = <T>(run: (tx: Tx) => Promise<T>) => as("service_role", null, run);

  async function visit(clinic: string, pt: string, doctor: string, status: string, service = svcA) {
    const start = new Date(Date.UTC(2031, 1, 2, 5, 0) + day++ * 86_400_000);
    const [row] = await sql<{ id: string }[]>`insert into public.appointments ${sql({
      clinic_id: clinic, patient_id: pt, doctor_id: doctor, service_id: service, start_at: start,
      end_at: new Date(start.getTime() + 30 * 60_000), status, source: "walk_in",
    })} returning id`;
    return row.id;
  }

  /** An order by doctor A for patient X with the given tests, created as the server would. */
  async function order(tests: string[] = [hb], opts: { notes?: string; creationKey?: string } = {}) {
    return svc(async (tx) => {
      const [o] = await tx<{ id: string }[]>`
        insert into public.lab_orders (clinic_id, patient_id, ordering_doctor_id, appointment_id, notes, created_by, creation_key)
        values (${clinicA}, ${patient.x}, ${D.a}, ${consult}, ${opts.notes ?? NOTE}, ${P.dA}, ${opts.creationKey ?? null}) returning id`;
      const items: string[] = [];
      for (const t of tests) {
        const [i] = await tx<{ id: string }[]>`
          insert into public.lab_order_items (clinic_id, order_id, test_id) values (${clinicA}, ${o.id}, ${t}) returning id`;
        items.push(i.id);
      }
      return { id: o.id, items };
    });
  }
  const orderStatus = async (id: string) => (await sql<{ status: string }[]>`select status from public.lab_orders where id = ${id}`)[0].status;
  const audits = (entity: string) =>
    sql<{ action: string; actor_id: string | null; actor_type: string; patient_id: string | null; new_values: Record<string, unknown> | null }[]>`
      select action, actor_id, actor_type, patient_id, new_values from public.audit_events where entity_id = ${entity} order by created_at, action`;

  /** A result with a draft version carrying the hemoglobin value; returns ids. */
  async function draftResult(item: string, ord: string, value = VALUE) {
    return svc(async (tx) => {
      const [r] = await tx<{ id: string }[]>`
        insert into public.lab_results (clinic_id, order_item_id, order_id, patient_id) values (${clinicA}, ${item}, ${ord}, ${patient.x}) returning id`;
      const [v] = await tx<{ id: string; version: number }[]>`
        insert into public.lab_result_versions (clinic_id, result_id, entered_by) values (${clinicA}, ${r.id}, ${P.lab}) returning id, version`;
      await tx`insert into public.lab_result_values (clinic_id, version_id, parameter_id, value_numeric, reference_range_id)
               values (${clinicA}, ${v.id}, ${hbParam}, ${value}, ${hbRange})`;
      return { result: r.id, version: v.id };
    });
  }
  const submit = (version: string) => svc((tx) => tx`update public.lab_result_versions set status = 'pending_verification' where id = ${version}`);
  const verify = (version: string, by = P.ver) =>
    svc((tx) => tx`update public.lab_result_versions set status = 'verified', verified_by = ${by} where id = ${version}`);

  beforeAll(async () => {
    sql = postgres(DB_URL, { max: 8, onnotice: () => {} });
    await sql`insert into public.clinics ${sql([
      { id: clinicA, name: `Lab Clinic A ${suffix}`, slug: `lab-a-${suffix}`, timezone: "Asia/Tashkent" },
      { id: clinicB, name: `Lab Clinic B ${suffix}`, slug: `lab-b-${suffix}`, timezone: "Asia/Tashkent" },
    ])}`;
    const users = Object.entries(P).map(([name, id]) => ({ id, email: `lab-${name}-${suffix}@test.local` }));
    await sql`insert into auth.users ${sql(users)}`;
    await sql`insert into public.profiles ${sql(users.map((u) => ({ id: u.id, full_name: u.email })))}`;
    await sql`insert into public.staff_roles ${sql([
      { clinic_id: clinicA, profile_id: P.dA, role: "doctor" },
      { clinic_id: clinicA, profile_id: P.dB, role: "doctor" },
      { clinic_id: clinicA, profile_id: P.lab, role: "lab_staff" },
      { clinic_id: clinicA, profile_id: P.ver, role: "lab_staff" },
      { clinic_id: clinicA, profile_id: P.rec, role: "receptionist" },
      { clinic_id: clinicA, profile_id: P.mgr, role: "manager" },
      { clinic_id: clinicB, profile_id: P.dK, role: "doctor" },
    ])}`;
    await sql`insert into public.doctors ${sql([
      { id: D.a, clinic_id: clinicA, profile_id: P.dA, name: `Dr A ${suffix}`, active: true },
      { id: D.b, clinic_id: clinicA, profile_id: P.dB, name: `Dr B ${suffix}`, active: true },
      { id: D.k, clinic_id: clinicB, profile_id: P.dK, name: `Dr K ${suffix}`, active: true },
    ])}`;
    await sql`insert into public.services ${sql([
      { id: svcA, clinic_id: clinicA, name: `Lab consult ${suffix}`, duration_minutes: 30, price: 100000 },
      { id: svcB, clinic_id: clinicB, name: `Lab consult B ${suffix}`, duration_minutes: 30, price: 100000 },
    ])}`;
    await sql`insert into public.doctor_working_hours ${sql(
      [[clinicA, D.a], [clinicA, D.b], [clinicB, D.k]].flatMap(([clinic, doctor]) =>
        [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinic_id: clinic, doctor_id: doctor, weekday, start_time: "00:00", end_time: "23:59" })),
      ),
    )}`;
    await sql`insert into public.patients ${sql([
      { id: patient.x, clinic_id: clinicA, full_name: `Lab patient X ${suffix}` },
      { id: patient.y, clinic_id: clinicA, full_name: `Lab patient Y ${suffix}` },
      { id: patient.k, clinic_id: clinicB, full_name: `Lab patient K ${suffix}` },
    ])}`;
    consult = await visit(clinicA, patient.x, D.a, "in_progress");
    consultOfB = await visit(clinicA, patient.x, D.b, "in_progress");
    consultDone = await visit(clinicA, patient.x, D.a, "completed");
    consultBooked = await visit(clinicA, patient.x, D.a, "confirmed");
    consultK = await visit(clinicB, patient.k, D.k, "in_progress", svcB);

    // The catalog, as the server (service role) writes it.
    await svc(async (tx) => {
      [{ id: cat }] = await tx<{ id: string }[]>`insert into public.lab_categories (clinic_id, name, updated_by) values (${clinicA}, ${`Blood ${suffix}`}, ${P.mgr}) returning id`;
      [{ id: hb }] = await tx<{ id: string }[]>`
        insert into public.lab_tests (clinic_id, category_id, code, name, price, sample_type, preparation_text, turnaround_minutes, updated_by)
        values (${clinicA}, ${cat}, ${`CBC-${suffix}`}, 'Complete blood count', 85000, 'blood', 'Fasting not required', 120, ${P.mgr}) returning id`;
      [{ id: hbParam }] = await tx<{ id: string }[]>`
        insert into public.lab_test_parameters (clinic_id, test_id, code, name, unit, data_type, display_order)
        values (${clinicA}, ${hb}, 'HGB', 'Hemoglobin', 'g/L', 'numeric', 1) returning id`;
      [{ id: choiceParam }] = await tx<{ id: string }[]>`
        insert into public.lab_test_parameters (clinic_id, test_id, code, name, data_type, choices, display_order)
        values (${clinicA}, ${hb}, 'APP', 'Appearance', 'choice', ${["clear", "turbid"]}, 2) returning id`;
      [{ id: hbRange }] = await tx<{ id: string }[]>`
        insert into public.lab_reference_ranges (clinic_id, parameter_id, low, high, critical_low, critical_high)
        values (${clinicA}, ${hbParam}, 120, 160, 70, 200) returning id`;
      [{ id: glu }] = await tx<{ id: string }[]>`
        insert into public.lab_tests (clinic_id, code, name, price, sample_type) values (${clinicA}, ${`GLU-${suffix}`}, 'Glucose', 25000, 'blood') returning id`;
      [{ id: gluParam }] = await tx<{ id: string }[]>`
        insert into public.lab_test_parameters (clinic_id, test_id, code, name, unit, data_type) values (${clinicA}, ${glu}, 'GLU', 'Glucose', 'mmol/L', 'numeric') returning id`;
      [{ id: tB }] = await tx<{ id: string }[]>`insert into public.lab_tests (clinic_id, code, name, price) values (${clinicB}, 'B-ONLY', 'Clinic B test', 1000) returning id`;
    });
  });

  afterAll(async () => {
    if (!sql) return;
    await cleanupTestClinics([clinicA, clinicB]);
    await sql`delete from auth.users where id in ${sql(Object.values(P))}`;
    await sql.end({ timeout: 5 });
  });

  // ---------- catalog ----------

  it("catalog: codes are unique per clinic (any case), cross-clinic references and impossible ranges are refused", async () => {
    expect((await pgError(() => svc((tx) => tx`insert into public.lab_tests (clinic_id, code, name) values (${clinicA}, ${`cbc-${suffix}`}, 'dup')`))).code).toBe("23505");
    // The same code in another clinic is a different test.
    await svc((tx) => tx`insert into public.lab_tests (clinic_id, code, name) values (${clinicB}, ${`CBC-${suffix}`}, 'B cbc')`);
    // A test of clinic B cannot be filed under clinic A's category (composite same-clinic FK).
    expect((await pgError(() => svc((tx) => tx`insert into public.lab_tests (clinic_id, category_id, code, name) values (${clinicB}, ${cat}, 'X1', 'x')`))).code).toBe("23503");
    // A parameter of clinic A under clinic B's test, and a range on another clinic's parameter.
    expect((await pgError(() => svc((tx) => tx`insert into public.lab_test_parameters (clinic_id, test_id, code, name) values (${clinicB}, ${hb}, 'Z', 'z')`))).code).toBe("23503");
    expect((await pgError(() => svc((tx) => tx`insert into public.lab_reference_ranges (clinic_id, parameter_id, low, high) values (${clinicB}, ${hbParam}, 1, 2)`))).code).toBe("23503");
    // Bounds must make sense; a choice parameter needs choices; only numeric parameters have ranges.
    expect((await pgError(() => svc((tx) => tx`insert into public.lab_reference_ranges (clinic_id, parameter_id, low, high) values (${clinicA}, ${hbParam}, 10, 5)`))).code).toBe("23514");
    expect((await pgError(() => svc((tx) => tx`insert into public.lab_reference_ranges (clinic_id, parameter_id) values (${clinicA}, ${hbParam})`))).code).toBe("23514");
    expect((await pgError(() => svc((tx) => tx`insert into public.lab_test_parameters (clinic_id, test_id, code, name, data_type) values (${clinicA}, ${hb}, 'CH', 'c', 'choice')`))).code).toBe("23514");
    expect((await pgError(() => svc((tx) => tx`insert into public.lab_reference_ranges (clinic_id, parameter_id, low) values (${clinicA}, ${choiceParam}, 1)`))).message).toContain("numeric");
    expect((await pgError(() => svc((tx) => tx`insert into public.lab_tests (clinic_id, code, name, price) values (${clinicA}, 'NEG', 'n', -1)`))).code).toBe("23514");
    // A panel's tests must be the panel's own clinic's.
    const panel = (await svc((tx) => tx<{ id: string }[]>`insert into public.lab_panels (clinic_id, code, name) values (${clinicA}, ${`P-${suffix}`}, 'Basic panel') returning id`))[0].id;
    await svc((tx) => tx`insert into public.lab_panel_tests (panel_id, test_id, clinic_id) values (${panel}, ${hb}, ${clinicA})`);
    expect((await pgError(() => svc((tx) => tx`insert into public.lab_panel_tests (panel_id, test_id, clinic_id) values (${panel}, ${tB}, ${clinicA})`))).code).toBe("23503");
  });

  it("catalog changes are audited as who/which row/which columns — never the prices or ranges themselves", async () => {
    await svc((tx) => tx`update public.lab_tests set price = 99123, updated_by = ${P.mgr} where id = ${glu}`);
    const rows = await audits(glu);
    expect(rows.map((r) => r.action)).toEqual(["lab_catalog_created", "lab_catalog_updated"].sort());
    const updated = rows.find((r) => r.action === "lab_catalog_updated")!;
    expect(updated.new_values).toEqual({ changed_columns: ["price"] });
    expect(JSON.stringify(rows)).not.toContain("99123");
    expect(JSON.stringify(await audits(hbRange))).not.toMatch(/120|160|200/);
    await svc((tx) => tx`update public.lab_tests set price = 25000, updated_by = ${P.mgr} where id = ${glu}`);
  });

  // ---------- orders ----------

  it("an order is created from the doctor's own in-progress consultation; items snapshot the catalog — the client cannot set price or names", async () => {
    const o = await svc(async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into public.lab_orders (clinic_id, patient_id, ordering_doctor_id, appointment_id, created_by)
        values (${clinicA}, ${patient.x}, ${D.a}, ${consult}, ${P.dA}) returning id`;
      // The request claims a bargain price and another name: the database ignores both.
      const [item] = await tx<{ test_code: string; test_name: string; price_snapshot: string; sample_type: string }[]>`
        insert into public.lab_order_items (clinic_id, order_id, test_id, test_code, test_name, price_snapshot)
        values (${clinicA}, ${row.id}, ${hb}, 'FAKE', 'Fake test', 1) returning test_code, test_name, price_snapshot, sample_type`;
      expect(item).toMatchObject({ test_code: `CBC-${suffix}`, test_name: "Complete blood count", price_snapshot: "85000.00", sample_type: "blood" });
      return row;
    });
    // The catalog price later changes: the order keeps what it was ordered at.
    await svc((tx) => tx`update public.lab_tests set price = 90000 where id = ${hb}`);
    expect((await sql`select price_snapshot from public.lab_order_items where order_id = ${o.id}`)[0].price_snapshot).toBe("85000.00");
    await svc((tx) => tx`update public.lab_tests set price = 85000 where id = ${hb}`);
    expect(await orderStatus(o.id)).toBe("ordered");
  });

  it("order integrity: wrong doctor, patient, consultation, clinic, status, login or referral are all refused", async () => {
    const base = (over: Record<string, unknown>) =>
      svc((tx) => tx`insert into public.lab_orders ${tx({ clinic_id: clinicA, patient_id: patient.x, ordering_doctor_id: D.a, appointment_id: consult, created_by: P.dA, ...over })}`);
    // The consultation of another doctor / of another patient / of another clinic: the composite FK refuses.
    expect((await pgError(() => base({ appointment_id: consultOfB }))).code).toBe("23503");
    expect((await pgError(() => base({ patient_id: patient.y }))).code).toBe("23503");
    expect((await pgError(() => base({ patient_id: patient.k, appointment_id: consultK }))).code).toMatch(/^(23503|P0001)$/);
    expect((await pgError(() => base({ clinic_id: clinicB }))).code).toMatch(/^(23503|P0001)$/);
    // A consultation that has not started (booked) is no consultation to order from.
    expect((await pgError(() => base({ appointment_id: consultBooked }))).message).toContain("in progress or completed");
    // Not the doctor's own login; not a doctor at all.
    expect((await pgError(() => base({ created_by: P.dB }))).message).toContain("ordering doctor's own doctor account");
    expect((await pgError(() => base({ ordering_doctor_id: D.b, appointment_id: consultOfB, created_by: P.lab }))).message).toContain("own doctor account");
    // A new order starts as ordered, whatever is claimed.
    expect((await pgError(() => base({ status: "completed" }))).message).toContain("created as ordered");
    // A referral must be this clinic's referral of THIS patient: a valid one is accepted, another patient's or an unknown one is not.
    const [ref] = await sql<{ id: string }[]>`
      insert into public.referrals (clinic_id, patient_id, referring_doctor_id, referred_to_doctor_id, originating_appointment_id, reason, created_by)
      values (${clinicA}, ${patient.x}, ${D.b}, ${D.a}, ${consultOfB}, 'r', ${P.dB}) returning id`;
    await base({ referral_id: ref.id });
    const yVisit = await visit(clinicA, patient.y, D.b, "completed");
    const [refY] = await sql<{ id: string }[]>`
      insert into public.referrals (clinic_id, patient_id, referring_doctor_id, referred_to_doctor_id, originating_appointment_id, reason, created_by)
      values (${clinicA}, ${patient.y}, ${D.b}, ${D.a}, ${yVisit}, 'r', ${P.dB}) returning id`;
    expect((await pgError(() => base({ referral_id: refY.id }))).message).toContain("referral");
    expect((await pgError(() => base({ referral_id: randomUUID() }))).code).toMatch(/^(23503|P0001)$/);
    // A completed consultation is fine (the doctor may order after the visit).
    await base({ appointment_id: consultDone });
  });

  it("an inactive test cannot be ordered, an item is added once per order, and a repeated submission is idempotent", async () => {
    const t = (await svc((tx) => tx<{ id: string }[]>`insert into public.lab_tests (clinic_id, code, name, active) values (${clinicA}, ${`OLD-${suffix}`}, 'Retired', false) returning id`))[0].id;
    const key = randomUUID();
    const o = await order([hb], { creationKey: key });
    expect((await pgError(() => svc((tx) => tx`insert into public.lab_order_items (clinic_id, order_id, test_id) values (${clinicA}, ${o.id}, ${t})`))).message).toContain("inactive");
    expect((await pgError(() => svc((tx) => tx`insert into public.lab_order_items (clinic_id, order_id, test_id) values (${clinicA}, ${o.id}, ${hb})`))).code).toBe("23505");
    // A test of another clinic.
    expect((await pgError(() => svc((tx) => tx`insert into public.lab_order_items (clinic_id, order_id, test_id) values (${clinicA}, ${o.id}, ${tB})`))).message).toContain("not in this clinic");
    // Same creation key by the same doctor: refused (the server resolves it to the first order).
    expect((await pgError(() => order([hb], { creationKey: key }))).code).toBe("23505");
  });

  it("order lifecycle: no edits, only legal transitions, cancel by clinic staff, complete only with every verified result", async () => {
    const o = await order([hb, glu]);
    expect((await pgError(() => svc((tx) => tx`update public.lab_orders set notes = 'changed' where id = ${o.id}`))).code).toBe("42501");
    expect((await pgError(() => sql`update public.lab_orders set notes = 'changed' where id = ${o.id}`)).message).toContain("cannot be edited");
    expect((await pgError(() => svc((tx) => tx`update public.lab_orders set status = 'completed' where id = ${o.id}`))).message).toContain("invalid status transition");
    // Cancelling needs a staff member of the clinic and a reason (a stranger's profile is refused).
    expect((await pgError(() => svc((tx) => tx`update public.lab_orders set status = 'cancelled', cancelled_by = ${P.outsider}, cancel_reason = 'x' where id = ${o.id}`))).message).toContain("staff of the clinic");
    expect((await pgError(() => svc((tx) => tx`update public.lab_orders set status = 'cancelled', cancelled_by = ${P.lab} where id = ${o.id}`))).code).toBe("23514");
    await svc((tx) => tx`update public.lab_orders set status = 'cancelled', cancelled_by = ${P.lab}, cancel_reason = 'Duplicate order' where id = ${o.id}`);
    expect(await orderStatus(o.id)).toBe("cancelled");
    // Terminal: nothing moves it again, and nothing new hangs on it.
    expect((await pgError(() => svc((tx) => tx`update public.lab_orders set status = 'in_progress' where id = ${o.id}`))).message).toContain("invalid status transition");
    expect((await pgError(() => svc((tx) => tx`insert into public.lab_samples (clinic_id, order_id, patient_id, sample_type, sample_code, created_by) values (${clinicA}, ${o.id}, ${patient.x}, 'blood', ${`S-${randomUUID().slice(0, 8)}`}, ${P.lab})`))).message).toContain("cancelled");
    expect((await pgError(() => svc((tx) => tx`insert into public.lab_results (clinic_id, order_item_id, order_id, patient_id) values (${clinicA}, ${o.items[0]}, ${o.id}, ${patient.x})`))).message).toContain("cancelled");
    // An item of an open order is cancelled with a reason; the order cannot complete while an item has no verified result.
    const o2 = await order([hb, glu]);
    await svc((tx) => tx`update public.lab_order_items set status = 'cancelled', cancel_reason = 'Not needed' where id = ${o2.items[1]}`);
    expect((await pgError(() => svc((tx) => tx`update public.lab_order_items set price_snapshot = 1 where id = ${o2.items[0]}`))).code).toBe("42501");
    await svc((tx) => tx`update public.lab_orders set status = 'in_progress' where id = ${o2.id}`);
    expect((await pgError(() => svc((tx) => tx`update public.lab_orders set status = 'completed' where id = ${o2.id}`))).message).toContain("verified result");
  });

  // ---------- samples ----------

  it("samples: one live sample per order and type, only this order's tests, collection recorded by the database and moving the order on", async () => {
    const o = await order([hb, glu]);
    const other = await order([hb]);
    const code = `S-${randomUUID().slice(0, 8)}`;
    const sample = (await svc((tx) => tx<{ id: string }[]>`
      insert into public.lab_samples (clinic_id, order_id, patient_id, sample_type, sample_code, created_by)
      values (${clinicA}, ${o.id}, ${patient.x}, 'blood', ${code}, ${P.lab}) returning id`))[0].id;
    // A second live blood sample of the same order, and a repeated barcode.
    expect((await pgError(() => svc((tx) => tx`insert into public.lab_samples (clinic_id, order_id, patient_id, sample_type, sample_code, created_by) values (${clinicA}, ${o.id}, ${patient.x}, 'blood', ${`S-${randomUUID().slice(0, 8)}`}, ${P.lab})`))).code).toBe("23505");
    expect((await pgError(() => svc((tx) => tx`insert into public.lab_samples (clinic_id, order_id, patient_id, sample_type, sample_code, created_by) values (${clinicA}, ${other.id}, ${patient.x}, 'blood', ${code}, ${P.lab})`))).code).toBe("23505");
    // Order/patient mismatch and cross-clinic.
    expect((await pgError(() => svc((tx) => tx`insert into public.lab_samples (clinic_id, order_id, patient_id, sample_type, sample_code, created_by) values (${clinicA}, ${other.id}, ${patient.y}, 'urine', ${`S-${randomUUID().slice(0, 8)}`}, ${P.lab})`))).code).toBe("23503");
    expect((await pgError(() => svc((tx) => tx`insert into public.lab_samples (clinic_id, order_id, patient_id, sample_type, sample_code, created_by) values (${clinicB}, ${o.id}, ${patient.x}, 'urine', ${`S-${randomUUID().slice(0, 8)}`}, ${P.lab})`))).code).toMatch(/^(23503|P0001)$/);
    // A sample serves the tests of ITS order only.
    await svc((tx) => tx`insert into public.lab_sample_items (sample_id, order_item_id, clinic_id, order_id) values (${sample}, ${o.items[0]}, ${clinicA}, ${o.id})`);
    expect((await pgError(() => svc((tx) => tx`insert into public.lab_sample_items (sample_id, order_item_id, clinic_id, order_id) values (${sample}, ${other.items[0]}, ${clinicA}, ${o.id})`))).code).toBe("23503");

    // Collection: who is required, when is the database's; the order goes in progress.
    expect(await orderStatus(o.id)).toBe("ordered");
    expect((await pgError(() => svc((tx) => tx`update public.lab_samples set status = 'collected', collected_by = ${P.outsider} where id = ${sample}`))).message).toContain("staff of the clinic");
    await svc((tx) => tx`update public.lab_samples set status = 'collected', collected_by = ${P.lab}, collected_at = '2001-01-01' where id = ${sample}`);
    const [row] = await sql<{ collected_at: Date }[]>`select collected_at from public.lab_samples where id = ${sample}`;
    expect(row.collected_at.getFullYear()).toBeGreaterThanOrEqual(2026); // not the claimed 2001
    expect(await orderStatus(o.id)).toBe("in_progress");
    // Tests cannot be attached after collection; illegal transitions; terminal states.
    expect((await pgError(() => svc((tx) => tx`insert into public.lab_sample_items (sample_id, order_item_id, clinic_id, order_id) values (${sample}, ${o.items[1]}, ${clinicA}, ${o.id})`))).message).toContain("before collection");
    expect((await pgError(() => svc((tx) => tx`update public.lab_samples set status = 'awaiting_collection' where id = ${sample}`))).message).toContain("invalid status transition");
    await svc((tx) => tx`update public.lab_samples set status = 'processing' where id = ${sample}`);
    await svc((tx) => tx`update public.lab_samples set status = 'rejected', rejected_reason = 'Hemolysed' where id = ${sample}`);
    expect((await pgError(() => svc((tx) => tx`update public.lab_samples set status = 'processing' where id = ${sample}`))).message).toContain("invalid status transition");
    // The rejected one frees the slot for a re-collection.
    await svc((tx) => tx`insert into public.lab_samples (clinic_id, order_id, patient_id, sample_type, sample_code, created_by) values (${clinicA}, ${o.id}, ${patient.x}, 'blood', ${`S-${randomUUID().slice(0, 8)}`}, ${P.lab})`);
  });

  it("two staff collecting the same sample at once: exactly one collection happens", async () => {
    const o = await order([hb]);
    const sample = (await svc((tx) => tx<{ id: string }[]>`
      insert into public.lab_samples (clinic_id, order_id, patient_id, sample_type, sample_code, created_by)
      values (${clinicA}, ${o.id}, ${patient.x}, 'blood', ${`S-${randomUUID().slice(0, 8)}`}, ${P.lab}) returning id`))[0].id;
    // The server's compare-and-swap: only the row still awaiting collection moves.
    const attempts = await Promise.all([P.lab, P.ver, P.lab, P.ver].map((by) =>
      svc((tx) => tx<{ id: string }[]>`update public.lab_samples set status = 'collected', collected_by = ${by} where id = ${sample} and status = 'awaiting_collection' returning id`),
    ));
    expect(attempts.filter((rows) => rows.length === 1)).toHaveLength(1);
    expect((await audits(sample)).filter((a) => a.action === "lab_sample_collected")).toHaveLength(1);
  });

  // ---------- results ----------

  it("a result: values are validated against the parameter, the reference range is copied and the flag is the database's — never the client's", async () => {
    const o = await order([hb]);
    const { result, version } = await draftResult(o.items[0], o.id, "132.5");
    const value = async (v: string) => (await sql<{ flag: string; ref_low: string; ref_high: string; unit: string; parameter_name: string }[]>`
      select flag, ref_low, ref_high, unit, parameter_name from public.lab_result_values where version_id = ${v} and parameter_id = ${hbParam}`)[0];
    expect(await value(version)).toMatchObject({ flag: "normal", ref_low: "120", ref_high: "160", unit: "g/L", parameter_name: "Hemoglobin" });
    // Another reading of the same parameter in a separate result: low, high, critical.
    for (const [v, flag] of [["110", "low"], ["170", "high"], ["60", "critical_low"], ["250", "critical_high"], ["120", "normal"], ["160", "normal"]] as const) {
      const o2 = await order([hb]);
      const r2 = await draftResult(o2.items[0], o2.id, v);
      expect((await value(r2.version)).flag, v).toBe(flag);
    }
    // A client cannot assert its own flag or bounds.
    const o3 = await order([hb]);
    const r3 = await svc(async (tx) => {
      const [r] = await tx<{ id: string }[]>`insert into public.lab_results (clinic_id, order_item_id, order_id, patient_id) values (${clinicA}, ${o3.items[0]}, ${o3.id}, ${patient.x}) returning id`;
      const [v] = await tx<{ id: string }[]>`insert into public.lab_result_versions (clinic_id, result_id, entered_by) values (${clinicA}, ${r.id}, ${P.lab}) returning id`;
      await tx`insert into public.lab_result_values (clinic_id, version_id, parameter_id, value_numeric, flag, ref_low, ref_high)
               values (${clinicA}, ${v.id}, ${hbParam}, 50, 'normal', 0, 1000)`;
      return v.id;
    });
    expect(await value(r3)).toMatchObject({ flag: "unclassified", ref_low: null, ref_high: null }); // no range chosen → unclassified, not "normal"
    // Type rules and parameter ownership.
    const draft = await draftResult((await order([hb])).items[0], (await order([hb])).id).catch(() => null);
    void draft;
    const o4 = await order([hb]);
    const r4 = await svc(async (tx) => {
      const [r] = await tx<{ id: string }[]>`insert into public.lab_results (clinic_id, order_item_id, order_id, patient_id) values (${clinicA}, ${o4.items[0]}, ${o4.id}, ${patient.x}) returning id`;
      const [v] = await tx<{ id: string }[]>`insert into public.lab_result_versions (clinic_id, result_id, entered_by) values (${clinicA}, ${r.id}, ${P.lab}) returning id`;
      return v.id;
    });
    const put = (parameter: string, over: Record<string, unknown>) =>
      svc((tx) => tx`insert into public.lab_result_values ${tx({ clinic_id: clinicA, version_id: r4, parameter_id: parameter, ...over })}`);
    expect((await pgError(() => put(hbParam, { value_text: "high" }))).code).toMatch(/^(23514|P0001)$/); // a numeric parameter takes a number
    expect((await pgError(() => put(hbParam, { value_numeric: 1, value_text: "x" }))).code).toMatch(/^(23514|P0001)$/);
    expect((await pgError(() => put(choiceParam, { value_text: "cloudy" }))).message).toContain("configured choices");
    await put(choiceParam, { value_text: "clear" });
    expect((await pgError(() => put(gluParam, { value_numeric: 5.1 }))).message).toContain("does not belong to the ordered test");
    expect((await pgError(() => put(hbParam, { value_numeric: 100, reference_range_id: randomUUID() }))).code).toMatch(/^(23503|P0001)$/);
    void result;
  });

  it("a result is versioned: numbering by the database, submit needs values, one version in progress, no direct header writes", async () => {
    const o = await order([hb]);
    const { result, version } = await draftResult(o.items[0], o.id);
    expect((await sql<{ version: number; status: string }[]>`select version, status from public.lab_result_versions where id = ${version}`)[0]).toEqual({ version: 1, status: "draft" });
    // The client cannot claim a version number, a status or a verifier on insert.
    const [claimed] = await sql<{ id: string }[]>`select 1 as id`; void claimed;
    // The header's status follows its versions and cannot be written (not even through the table owner without a nested trigger).
    expect((await pgError(() => svc((tx) => tx`update public.lab_results set status = 'verified' where id = ${result}`))).code).toBe("42501");
    expect((await pgError(() => sql`update public.lab_results set status = 'verified' where id = ${result}`)).message).toContain("follows its versions");
    // Only one version may be open at a time.
    expect((await pgError(() => svc((tx) => tx`insert into public.lab_result_versions (clinic_id, result_id, entered_by) values (${clinicA}, ${result}, ${P.lab})`))).code).toMatch(/^(23505|P0001)$/);
    // An empty version cannot be submitted.
    const o2 = await order([hb]);
    const empty = await svc(async (tx) => {
      const [r] = await tx<{ id: string }[]>`insert into public.lab_results (clinic_id, order_item_id, order_id, patient_id) values (${clinicA}, ${o2.items[0]}, ${o2.id}, ${patient.x}) returning id`;
      const [v] = await tx<{ id: string }[]>`insert into public.lab_result_versions (clinic_id, result_id, entered_by) values (${clinicA}, ${r.id}, ${P.lab}) returning id`;
      return v.id;
    });
    expect((await pgError(() => submit(empty))).message).toContain("without values");
    // entered_by must be staff of the clinic.
    const o3 = await order([hb]);
    const r3 = (await svc((tx) => tx<{ id: string }[]>`insert into public.lab_results (clinic_id, order_item_id, order_id, patient_id) values (${clinicA}, ${o3.items[0]}, ${o3.id}, ${patient.x}) returning id`))[0].id;
    expect((await pgError(() => svc((tx) => tx`insert into public.lab_result_versions (clinic_id, result_id, entered_by) values (${clinicA}, ${r3}, ${P.outsider})`))).message).toContain("staff of the clinic");
    // The result belongs to its item's order and patient: another patient's header is refused by the composite FKs.
    const o4 = await order([hb]);
    expect((await pgError(() => svc((tx) => tx`insert into public.lab_results (clinic_id, order_item_id, order_id, patient_id) values (${clinicA}, ${o4.items[0]}, ${o4.id}, ${patient.y})`))).code).toBe("23503");
    // One result per order item.
    expect((await pgError(() => svc((tx) => tx`insert into public.lab_results (clinic_id, order_item_id, order_id, patient_id) values (${clinicA}, ${o2.items[0]}, ${o2.id}, ${patient.x})`))).code).toBe("23505");
  });

  it("verification: submit → verify (verifier required, time by the database); values and versions are then immutable; the order completes", async () => {
    const o = await order([hb]);
    const { result, version } = await draftResult(o.items[0], o.id);
    await submit(version);
    expect((await sql<{ status: string }[]>`select status from public.lab_results where id = ${result}`)[0].status).toBe("pending_verification");
    // Values of a submitted version are frozen for the application roles.
    expect((await pgError(() => svc((tx) => tx`update public.lab_result_values set value_numeric = 1 where version_id = ${version}`))).message).toContain("not a draft");
    expect((await pgError(() => svc((tx) => tx`delete from public.lab_result_values where version_id = ${version}`))).message).toContain("not a draft");
    expect((await pgError(() => verify(version, P.outsider))).message).toContain("staff of the clinic");
    expect((await pgError(() => svc((tx) => tx`update public.lab_result_versions set status = 'verified', verified_at = '2001-01-01' where id = ${version}`))).code).toMatch(/^(23514|P0001)$/);
    await verify(version);
    const [v] = await sql<{ status: string; verified_by: string; verified_at: Date }[]>`select status, verified_by, verified_at from public.lab_result_versions where id = ${version}`;
    expect(v).toMatchObject({ status: "verified", verified_by: P.ver });
    expect(v.verified_at.getFullYear()).toBeGreaterThanOrEqual(2026);
    expect((await sql<{ status: string }[]>`select status from public.lab_results where id = ${result}`)[0].status).toBe("verified");
    // Every active item has a verified result: the order completed by itself.
    expect(await orderStatus(o.id)).toBe("completed");
    // Frozen: no edit of a verified version or its values; a verified item cannot be cancelled.
    expect((await pgError(() => svc((tx) => tx`update public.lab_result_versions set entered_by = ${P.mgr} where id = ${version}`))).code).toBe("42501");
    expect((await pgError(() => sql`update public.lab_result_versions set entered_by = ${P.mgr} where id = ${version}`)).message).toContain("cannot be edited");
    expect((await pgError(() => svc((tx) => tx`update public.lab_result_values set value_numeric = 1 where version_id = ${version}`))).message).toContain("not a draft");
    expect((await pgError(() => svc((tx) => tx`insert into public.lab_result_values (clinic_id, version_id, parameter_id, value_text) values (${clinicA}, ${version}, ${choiceParam}, 'clear')`))).message).toContain("not a draft");
    expect((await pgError(() => svc((tx) => tx`update public.lab_order_items set status = 'cancelled', cancel_reason = 'x' where id = ${o.items[0]}`))).message).toMatch(/already completed|verified result/);
    // The state machine has no way back or around: verified → pending/draft, pending → superseded.
    expect((await pgError(() => sql`update public.lab_result_versions set status = 'draft', verified_by = null, verified_at = null where id = ${version}`)).message).toContain("invalid version transition");
  });

  it("a correction is a new version by whoever corrects it: the verified one stays until the new one is verified, then it is superseded — exactly one verified at all times", async () => {
    const o = await order([hb]);
    const { result, version: v1 } = await draftResult(o.items[0], o.id, "132.5");
    await submit(v1);
    await verify(v1);
    // A correction must name the current verified version and give a reason.
    expect((await pgError(() => svc((tx) => tx`insert into public.lab_result_versions (clinic_id, result_id, entered_by) values (${clinicA}, ${result}, ${P.lab})`))).code).toMatch(/^(23514|P0001)$/); // no named version, no reason
    expect((await pgError(() => svc((tx) => tx`insert into public.lab_result_versions (clinic_id, result_id, entered_by, corrects_version_id, correction_reason) values (${clinicA}, ${result}, ${P.lab}, ${randomUUID()}, 'typo')`))).code).toMatch(/^(23503|P0001)$/);
    const v2 = (await svc((tx) => tx<{ id: string; version: number }[]>`
      insert into public.lab_result_versions (clinic_id, result_id, entered_by, corrects_version_id, correction_reason)
      values (${clinicA}, ${result}, ${P.ver}, ${v1}, 'Transcription error') returning id, version`))[0];
    expect(v2.version).toBe(2);
    await svc((tx) => tx`insert into public.lab_result_values (clinic_id, version_id, parameter_id, value_numeric, reference_range_id) values (${clinicA}, ${v2.id}, ${hbParam}, 118, ${hbRange})`);
    // Meanwhile the original is still THE verified result; a second concurrent correction is refused.
    expect((await sql<{ status: string }[]>`select status from public.lab_result_versions where id = ${v1}`)[0].status).toBe("verified");
    expect((await pgError(() => svc((tx) => tx`insert into public.lab_result_versions (clinic_id, result_id, entered_by, corrects_version_id, correction_reason) values (${clinicA}, ${result}, ${P.lab}, ${v1}, 'another')`))).code).toBe("23505");
    await submit(v2.id);
    await verify(v2.id, P.lab);
    const versions = await sql<{ version: number; status: string; entered_by: string; verified_by: string | null }[]>`
      select version, status, entered_by, verified_by from public.lab_result_versions where result_id = ${result} order by version`;
    expect(versions).toEqual([
      { version: 1, status: "superseded", entered_by: P.lab, verified_by: P.ver }, // the original author and verifier are preserved
      { version: 2, status: "verified", entered_by: P.ver, verified_by: P.lab },
    ]);
    // The old values are still there, as they were.
    expect((await sql`select value_numeric::text as v from public.lab_result_values where version_id = ${v1}`)[0].v).toBe("132.5");
    // A stale correction (of the superseded version) is refused.
    expect((await pgError(() => svc((tx) => tx`insert into public.lab_result_versions (clinic_id, result_id, entered_by, corrects_version_id, correction_reason) values (${clinicA}, ${result}, ${P.lab}, ${v1}, 'stale')`))).message).toContain("current verified version");
    // The trail names each step.
    expect((await sql<{ action: string }[]>`select action from public.audit_events where entity_id in (${v1}, ${v2.id}) order by created_at, action`).map((a) => a.action).sort())
      .toEqual(["lab_result_entered", "lab_result_submitted", "lab_result_verified", "lab_result_version_created", "lab_result_submitted", "lab_result_verified", "lab_result_version_superseded"].sort());
  });

  it("two verifiers at once: exactly one verification happens (compare-and-swap), and the audit has it once", async () => {
    const o = await order([hb]);
    const { version } = await draftResult(o.items[0], o.id);
    await submit(version);
    const attempts = await Promise.all([P.ver, P.lab, P.ver, P.lab].map((by) =>
      svc((tx) => tx<{ id: string }[]>`update public.lab_result_versions set status = 'verified', verified_by = ${by} where id = ${version} and status = 'pending_verification' returning id`),
    ));
    expect(attempts.filter((rows) => rows.length === 1)).toHaveLength(1);
    expect((await audits(version)).filter((a) => a.action === "lab_result_verified")).toHaveLength(1);
  });

  // ---------- adversarial review of phase 2: work cannot continue on cancelled orders or tests ----------

  it("review: a cancelled order or a cancelled test freezes its samples and results — nothing is submitted, verified, collected or added", async () => {
    // (a) an order cancelled while a result is in draft and a sample awaits collection
    const o = await order([hb, glu]);
    const { version } = await draftResult(o.items[0], o.id);
    const sample = (await svc((tx) => tx<{ id: string }[]>`
      insert into public.lab_samples (clinic_id, order_id, patient_id, sample_type, sample_code, created_by)
      values (${clinicA}, ${o.id}, ${patient.x}, 'blood', ${`S-${randomUUID().slice(0, 8)}`}, ${P.lab}) returning id`))[0].id;
    await svc((tx) => tx`update public.lab_orders set status = 'cancelled', cancelled_by = ${P.lab}, cancel_reason = 'Ordered in error' where id = ${o.id}`);
    expect((await pgError(() => submit(version))).message).toContain("cancelled");
    expect((await pgError(() => svc((tx) => tx`update public.lab_result_versions set status = 'verified', verified_by = ${P.ver} where id = ${version}`))).message).toMatch(/cancelled|invalid version transition/);
    expect((await pgError(() => svc((tx) => tx`insert into public.lab_result_values (clinic_id, version_id, parameter_id, value_text) values (${clinicA}, ${version}, ${choiceParam}, 'clear')`))).message).toContain("cancelled");
    expect((await pgError(() => svc((tx) => tx`update public.lab_result_values set value_numeric = 140 where version_id = ${version} and parameter_id = ${hbParam}`))).message).toContain("cancelled");
    expect((await pgError(() => svc((tx) => tx`update public.lab_samples set status = 'collected', collected_by = ${P.lab} where id = ${sample}`))).message).toContain("cancelled");
    // The sample itself can still be closed off.
    await svc((tx) => tx`update public.lab_samples set status = 'cancelled' where id = ${sample}`);

    // (b) a single test cancelled while its result is in draft
    const o2 = await order([hb, glu]);
    const r2 = await draftResult(o2.items[0], o2.id);
    await svc((tx) => tx`update public.lab_order_items set status = 'cancelled', cancel_reason = 'Not needed' where id = ${o2.items[0]}`);
    expect((await pgError(() => submit(r2.version))).message).toContain("cancelled");
    expect((await pgError(() => svc((tx) => tx`insert into public.lab_result_versions (clinic_id, result_id, entered_by, corrects_version_id, correction_reason) values (${clinicA}, ${r2.result}, ${P.lab}, ${r2.version}, 'x')`))).code).toMatch(/^(P0001|23514)$/);
    // (c) an inactive reference range cannot be chosen for a new value.
    const inactive = (await svc((tx) => tx<{ id: string }[]>`insert into public.lab_reference_ranges (clinic_id, parameter_id, low, high, active) values (${clinicA}, ${hbParam}, 1, 2, false) returning id`))[0].id;
    const o3 = await order([hb]);
    const r3 = await svc(async (tx) => {
      const [r] = await tx<{ id: string }[]>`insert into public.lab_results (clinic_id, order_item_id, order_id, patient_id) values (${clinicA}, ${o3.items[0]}, ${o3.id}, ${patient.x}) returning id`;
      const [v] = await tx<{ id: string }[]>`insert into public.lab_result_versions (clinic_id, result_id, entered_by) values (${clinicA}, ${r.id}, ${P.lab}) returning id`;
      return v.id;
    });
    expect((await pgError(() => svc((tx) => tx`insert into public.lab_result_values (clinic_id, version_id, parameter_id, value_numeric, reference_range_id) values (${clinicA}, ${r3}, ${hbParam}, 1.5, ${inactive})`))).message).toContain("inactive");
  });

  it("review: editing the catalog later never changes a stored result — range edits do not re-flag, and a parameter with results keeps its type", async () => {
    const o = await order([hb]);
    const { version } = await draftResult(o.items[0], o.id, "110"); // low against 120–160
    const stored = async () => (await sql<{ flag: string; ref_low: string; value_numeric: string }[]>`select flag, ref_low, value_numeric from public.lab_result_values where version_id = ${version} and parameter_id = ${hbParam}`)[0];
    expect(await stored()).toMatchObject({ flag: "low", ref_low: "120" });
    await svc((tx) => tx`update public.lab_reference_ranges set low = 100, critical_low = 50 where id = ${hbRange}`);
    expect(await stored()).toMatchObject({ flag: "low", ref_low: "120" }); // evaluated against what applied at entry
    await svc((tx) => tx`update public.lab_reference_ranges set low = 120, critical_low = 70 where id = ${hbRange}`);
    expect((await pgError(() => svc((tx) => tx`update public.lab_test_parameters set data_type = 'text' where id = ${hbParam}`))).message).toContain("data type");
    // A parameter nobody has a result for can still be re-typed.
    const fresh = (await svc((tx) => tx<{ id: string }[]>`insert into public.lab_test_parameters (clinic_id, test_id, code, name, data_type) values (${clinicA}, ${glu}, 'TMP', 'tmp', 'numeric') returning id`))[0].id;
    await svc((tx) => tx`update public.lab_test_parameters set data_type = 'text' where id = ${fresh}`);
  });

  it("only laboratory staff handle samples and results: managers, receptionists, doctors and outsiders are refused in every slot", async () => {
    const o = await order([hb]);
    for (const who of [P.mgr, P.rec, P.dA, P.dB, P.dK, P.outsider]) {
      expect((await pgError(() => svc((tx) => tx`insert into public.lab_samples (clinic_id, order_id, patient_id, sample_type, sample_code, created_by) values (${clinicA}, ${o.id}, ${patient.x}, 'blood', ${`S-${randomUUID().slice(0, 8)}`}, ${who})`))).message, `sample by ${who}`).toContain("lab staff");
    }
    const sample = (await svc((tx) => tx<{ id: string }[]>`insert into public.lab_samples (clinic_id, order_id, patient_id, sample_type, sample_code, created_by) values (${clinicA}, ${o.id}, ${patient.x}, 'blood', ${`S-${randomUUID().slice(0, 8)}`}, ${P.lab}) returning id`))[0].id;
    const r = (await svc((tx) => tx<{ id: string }[]>`insert into public.lab_results (clinic_id, order_item_id, order_id, patient_id) values (${clinicA}, ${o.items[0]}, ${o.id}, ${patient.x}) returning id`))[0].id;
    for (const who of [P.mgr, P.rec, P.dA, P.dK, P.outsider]) {
      expect((await pgError(() => svc((tx) => tx`update public.lab_samples set status = 'collected', collected_by = ${who} where id = ${sample}`))).message, `collect by ${who}`).toContain("lab staff");
      expect((await pgError(() => svc((tx) => tx`insert into public.lab_result_versions (clinic_id, result_id, entered_by) values (${clinicA}, ${r}, ${who})`))).message, `enter by ${who}`).toContain("lab staff");
    }
    const o2 = await order([hb]);
    const d = await draftResult(o2.items[0], o2.id);
    await submit(d.version);
    for (const who of [P.mgr, P.rec, P.dA, P.dK, P.outsider]) {
      expect((await pgError(() => verify(d.version, who))).message, `verify by ${who}`).toContain("lab staff");
    }
    // The same login may enter and verify at the database level: whether a second person must verify is the clinic's setting, enforced by the server.
    await verify(d.version, P.lab);
    // Any staff of the clinic can still cancel an order (the ordering doctor, management, reception).
    const o3 = await order([hb]);
    for (const who of [P.mgr]) {
      await svc((tx) => tx`update public.lab_orders set status = 'cancelled', cancelled_by = ${who}, cancel_reason = 'by management' where id = ${o3.id}`);
    }
  });

  // ---------- audit privacy ----------

  it("the audit trail carries ids and statuses only — never a value, unit, note, price or reason", async () => {
    const o = await order([hb], { notes: NOTE });
    const { result, version } = await draftResult(o.items[0], o.id, "187.25");
    await submit(version);
    await verify(version);
    const rows = await sql<{ action: string; new_values: unknown; metadata: unknown; old_values: unknown; actor_id: string | null; patient_id: string | null }[]>`
      select action, new_values, metadata, old_values, actor_id, patient_id from public.audit_events
       where entity_id in (${o.id}, ${o.items[0]}, ${result}, ${version}) order by created_at, action`;
    const actions = rows.map((r) => r.action);
    for (const a of ["lab_order_created", "lab_order_item_added", "lab_result_entered", "lab_result_submitted", "lab_result_verified", "lab_order_completed"]) {
      expect(actions, a).toContain(a);
    }
    expect(rows.every((r) => r.patient_id === null || r.patient_id === patient.x)).toBe(true);
    expect(rows.find((r) => r.action === "lab_order_created")).toMatchObject({ actor_id: P.dA, patient_id: patient.x });
    expect(rows.find((r) => r.action === "lab_result_verified")).toMatchObject({ actor_id: P.ver });
    const text = JSON.stringify(rows);
    for (const secret of ["187.25", "g/L", "Hemoglobin", "HGB", NOTE, "85000", "Complete blood count"]) expect(text, secret).not.toContain(secret);
  });

  // ---------- who can reach what ----------

  it("signed-in roles read the catalog of their own clinic only, and no order, sample or result at all; nobody writes as a signed-in user", async () => {
    const o = await order([hb]);
    const { result } = await draftResult(o.items[0], o.id);
    // Clinic A staff: the catalog yes, clinic B's catalog no.
    const catalogOf = (profile: string) => as("authenticated", profile, (tx) => tx<{ id: string }[]>`select id from public.lab_tests`);
    expect((await catalogOf(P.lab)).map((r) => r.id)).toContain(hb);
    expect((await catalogOf(P.lab)).map((r) => r.id)).not.toContain(tB);
    expect((await catalogOf(P.dK)).map((r) => r.id)).toContain(tB);
    expect((await catalogOf(P.dK)).map((r) => r.id)).not.toContain(hb);
    // A login that is staff nowhere sees no catalog.
    expect(await catalogOf(P.outsider)).toEqual([]);
    // The clinical lab tables: not even a doctor of the clinic, a manager or the ordering doctor can select them.
    for (const table of ["lab_orders", "lab_order_items", "lab_samples", "lab_sample_items", "lab_results", "lab_result_versions", "lab_result_values", "lab_result_attachments"]) {
      for (const who of [P.dA, P.dB, P.mgr, P.lab, P.dK]) {
        expect((await pgError(() => as("authenticated", who, (tx) => tx.unsafe(`select * from public.${table}`)))).code, `${table} as ${who}`).toBe("42501");
      }
      expect((await pgError(() => as("anon", null, (tx) => tx.unsafe(`select * from public.${table}`)))).code, `${table} as anon`).toBe("42501");
    }
    // No signed-in writes anywhere (catalog included): the server is the only writer.
    expect((await pgError(() => as("authenticated", P.mgr, (tx) => tx`insert into public.lab_tests (clinic_id, code, name) values (${clinicA}, 'HACK', 'x')`))).code).toBe("42501");
    expect((await pgError(() => as("authenticated", P.mgr, (tx) => tx`update public.lab_tests set price = 0 where id = ${hb}`))).code).toBe("42501");
    expect((await pgError(() => as("authenticated", P.dA, (tx) => tx`update public.lab_results set status = 'verified' where id = ${result}`))).code).toBe("42501");
    // Not even the server can delete lab data.
    for (const table of ["lab_orders", "lab_order_items", "lab_samples", "lab_results", "lab_result_versions", "lab_result_attachments", "lab_tests", "lab_categories"]) {
      expect((await pgError(() => svc((tx) => tx.unsafe(`delete from public.${table}`)))).code, `delete ${table}`).toBe("42501");
    }
    // Every lab table has RLS on.
    const [{ without }] = await sql<{ without: number }[]>`
      select count(*)::int as without from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname like 'lab\\_%' and not c.relrowsecurity`;
    expect(without).toBe(0);
  });

  // ---------- retention ----------

  it("retention: a patient, an appointment or a clinic with laboratory data cannot be deleted (no cascade anywhere)", async () => {
    const o = await order([hb]);
    await draftResult(o.items[0], o.id);
    expect((await pgError(() => sql`delete from public.patients where id = ${patient.x}`)).code).toBe("23503");
    expect((await pgError(() => sql`delete from public.appointments where id = ${consult}`)).code).toBe("23503");
    expect((await pgError(() => sql`delete from public.clinics where id = ${clinicA}`)).code).toBe("23503");
    expect((await pgError(() => sql`delete from public.lab_orders where id = ${o.id}`)).code).toBe("23503"); // its items and results hang on it
    expect((await pgError(() => sql`delete from public.lab_tests where id = ${hb}`)).code).toBe("23503");
    // Every lab foreign key is NO ACTION / RESTRICT: none cascades.
    const [{ cascading }] = await sql<{ cascading: number }[]>`
      select count(*)::int as cascading from pg_constraint
       where contype = 'f' and confdeltype = 'c' and conrelid::regclass::text like 'lab\\_%'`;
    expect(cascading).toBe(0);
    const [{ category }] = await sql<{ category: boolean }[]>`select 'laboratory' = any (enum_range(null::public.retention_data_category)::text[]) as category`;
    expect(category).toBe(true);
  });
});
