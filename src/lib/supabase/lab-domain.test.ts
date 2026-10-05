import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

/**
 * Laboratory domain — the DATABASE guarantees of
 * supabase/migrations/20261005000001…4 (docs/labs/PHASE_1_DOMAIN_MODEL.md):
 * clinic-scoped identity documents, a configured catalog, orders that any
 * clinic staff member may place, catalog-derived snapshots, separate order /
 * item / sample / result lifecycles, second-person verification, versioned
 * corrections, configuration-derived flags, an audit trail without values,
 * history that is never silently deleted, and no direct access for signed-in
 * roles.
 *
 * Sessions are simulated the way PostgREST runs requests (`set local role` +
 * JWT claims), so an "as …" statement is what that person gets with their own
 * token. Server statements run as service_role, like the app's admin client.
 *
 * Cast: Dr A (patient X's doctor), Dr C (no relationship), Dr K (clinic B),
 * the receptionist, the manager and the owner of clinic A.
 */

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

async function probeDatabase(): Promise<string | null> {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    const [row] = await probe<{ has_labs: boolean; can_switch_roles: boolean }[]>`
      select
        to_regclass('public.lab_results') is not null as has_labs,
        pg_has_role(current_user, 'anon', 'MEMBER')
          and pg_has_role(current_user, 'authenticated', 'MEMBER')
          and pg_has_role(current_user, 'service_role', 'MEMBER') as can_switch_roles`;
    if (!row.has_labs) return "lab migrations not applied — run `npm run db:reset-local`";
    if (!row.can_switch_roles) return "database user cannot switch to anon/authenticated/service_role";
    return null;
  } catch (e) {
    return `database unreachable via SUPABASE_DB_URL — ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    await probe.end({ timeout: 1 });
  }
}

const unavailable = await probeDatabase();
if (unavailable) process.stderr.write(`\n⚠️  lab domain database suite SKIPPED (${unavailable})\n\n`);

const describeDb = describe.skipIf(unavailable !== null);

type Tx = postgres.TransactionSql;
type Values = Record<string, unknown>;

async function pgError(run: () => Promise<unknown>): Promise<postgres.PostgresError> {
  try {
    await run();
  } catch (e) {
    if (e instanceof postgres.PostgresError) return e;
    throw e;
  }
  throw new Error("expected the database to reject the statement");
}

describeDb("lab domain — database layer", () => {
  let sql: postgres.Sql;
  const suffix = Date.now().toString(36);
  const clinicA = randomUUID();
  const clinicB = randomUUID();
  const serviceA = randomUUID();
  const profiles = {
    a: randomUUID(),
    c: randomUUID(),
    k: randomUUID(),
    receptionist: randomUUID(),
    manager: randomUUID(),
    owner: randomUUID(),
    outsider: randomUUID(),
  };
  const doctors = { a: randomUUID(), c: randomUUID(), k: randomUUID() };
  let day = 0;
  let codeSeq = 0;

  async function as<T>(role: "anon" | "authenticated" | "service_role", sub: string | null, run: (tx: Tx) => Promise<T>): Promise<T> {
    return (await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${role}`);
      await tx`select set_config('request.jwt.claims', ${JSON.stringify(sub ? { sub, role } : { role })}, true)`;
      return run(tx);
    })) as T;
  }
  const asServer = <T>(run: (tx: Tx) => Promise<T>) => as("service_role", null, run);
  const asUser = <T>(profileId: string, run: (tx: Tx) => Promise<T>) => as("authenticated", profileId, run);

  // ---------- fixtures ----------

  async function newPatient(clinicId = clinicA, extra: Values = {}) {
    const id = randomUUID();
    await asServer((tx) => tx`insert into public.patients ${tx({
      id,
      clinic_id: clinicId,
      full_name: `Lab patient ${suffix}`,
      date_of_birth: "1980-06-15",
      sex: "female",
      ...extra,
    })}`);
    return id;
  }

  async function visit(patient: string, doctor: string, status = "in_progress", clinicId = clinicA) {
    const start = new Date(Date.UTC(2026, 1, 2, 5, 0) + day++ * 86_400_000);
    const [row] = await sql<{ id: string }[]>`insert into public.appointments ${sql({
      clinic_id: clinicId,
      patient_id: patient,
      doctor_id: doctor,
      service_id: serviceA,
      start_at: start,
      end_at: new Date(start.getTime() + 30 * 60_000),
      status,
      source: "walk_in",
    })} returning id`;
    return row.id;
  }

  async function newTest(clinicId = clinicA, extra: Values = {}) {
    const code = `T${suffix}${codeSeq++}`;
    const [row] = await asServer((tx) => tx<{ id: string }[]>`insert into public.lab_tests ${tx({
      clinic_id: clinicId,
      code,
      name: `Test ${code}`,
      sample_type: "Venous blood",
      price: 100000,
      ...extra,
    })} returning id`);
    return row.id;
  }

  async function newParameter(testId: string, extra: Values = {}, clinicId = clinicA) {
    const [row] = await asServer((tx) => tx<{ id: string }[]>`insert into public.lab_test_parameters ${tx({
      clinic_id: clinicId,
      test_id: testId,
      code: `P${codeSeq++}`,
      name: "Hemoglobin",
      value_type: "numeric",
      unit: "g/L",
      ...extra,
    })} returning id`);
    return row.id;
  }

  async function newRange(parameterId: string, extra: Values) {
    const [row] = await asServer((tx) => tx<{ id: string }[]>`insert into public.lab_reference_ranges ${tx({
      clinic_id: clinicA,
      parameter_id: parameterId,
      ...extra,
    })} returning id`);
    return row.id;
  }

  async function newOrder(patient: string, extra: Values = {}, clinicId = clinicA) {
    const [row] = await asServer((tx) => tx<{ id: string }[]>`insert into public.lab_orders ${tx({
      clinic_id: clinicId,
      patient_id: patient,
      source: "walk_in",
      ordered_by: profiles.receptionist,
      ...extra,
    })} returning id`);
    return row.id;
  }

  async function newItem(order: string, patient: string, test: string, extra: Values = {}, clinicId = clinicA) {
    const [row] = await asServer((tx) => tx<{ id: string; price_snapshot: string; test_code_snapshot: string }[]>`
      insert into public.lab_order_items ${tx({
        clinic_id: clinicId,
        order_id: order,
        patient_id: patient,
        test_id: test,
        test_code_snapshot: "x",
        test_name_snapshot: "x",
        list_price_snapshot: 0,
        price_snapshot: 0,
        ...extra,
      })} returning id, price_snapshot, test_code_snapshot`);
    return row;
  }

  const itemStatus = async (id: string) =>
    (await sql<{ status: string }[]>`select status from public.lab_order_items where id = ${id}`)[0].status;

  const moveItem = (id: string, status: string, by = profiles.receptionist) =>
    asServer((tx) => tx`update public.lab_order_items set status = ${status}, status_changed_by = ${by} where id = ${id}`);

  async function newSample(order: string, patient: string, items: string[], clinicId = clinicA) {
    const sampleId = randomUUID();
    await asServer(async (tx) => {
      await tx`insert into public.lab_samples ${tx({
        id: sampleId,
        clinic_id: clinicId,
        patient_id: patient,
        order_id: order,
        sample_code: `S-${suffix}-${codeSeq++}`,
        sample_type: "Venous blood",
        collected_by: profiles.receptionist,
      })}`;
      for (const item of items) {
        await tx`insert into public.lab_sample_items ${tx({ sample_id: sampleId, order_item_id: item, clinic_id: clinicId })}`;
      }
    });
    return sampleId;
  }

  /** Patient → walk-in order → one numeric test with a configured range → collected sample. */
  async function collectedItem(rangeExtra: Values = { low: 120, high: 160, critical_low: 70, critical_high: 200 }) {
    const patient = await newPatient();
    const test = await newTest();
    const parameter = await newParameter(test);
    await newRange(parameter, rangeExtra);
    const order = await newOrder(patient);
    const item = (await newItem(order, patient, test)).id;
    await moveItem(item, "ready_for_collection");
    const sample = await newSample(order, patient, [item]);
    await moveItem(item, "collected");
    return { patient, test, parameter, order, item, sample };
  }

  async function newResult(item: string, patient: string, extra: Values = {}) {
    const [row] = await asServer((tx) => tx<{ id: string }[]>`insert into public.lab_results ${tx({
      clinic_id: clinicA,
      patient_id: patient,
      order_item_id: item,
      entered_by: profiles.receptionist,
      ...extra,
    })} returning id`);
    return row.id;
  }

  async function addValue(result: string, parameter: string, value: Values) {
    const [row] = await asServer((tx) => tx<{ id: string; flag: string; unit_snapshot: string | null; range_low: string | null }[]>`
      insert into public.lab_result_values ${tx({ clinic_id: clinicA, result_id: result, parameter_id: parameter, ...value })}
      returning id, flag, unit_snapshot, range_low`);
    return row;
  }

  const submit = (result: string, by = profiles.receptionist) =>
    asServer((tx) => tx`update public.lab_results set status = 'submitted', submitted_by = ${by} where id = ${result}`);
  const verify = (result: string, by = profiles.a) =>
    asServer((tx) => tx`update public.lab_results set status = 'verified', verified_by = ${by} where id = ${result}`);

  /** A fully verified result (Hb 118 → low against 120–160). */
  async function verifiedResult() {
    const fx = await collectedItem();
    const result = await newResult(fx.item, fx.patient);
    await addValue(result, fx.parameter, { value_numeric: 118 });
    await submit(result);
    await verify(result);
    return { ...fx, result };
  }

  beforeAll(async () => {
    sql = postgres(DB_URL, { max: 6, onnotice: () => {} });
    await sql`insert into public.clinics ${sql([
      { id: clinicA, name: `Lab Clinic A ${suffix}`, slug: `lab-a-${suffix}`, timezone: "Asia/Tashkent" },
      { id: clinicB, name: `Lab Clinic B ${suffix}`, slug: `lab-b-${suffix}`, timezone: "Asia/Tashkent" },
    ])}`;
    const users = Object.entries(profiles).map(([name, id]) => ({ id, email: `lab-${name}-${suffix}@test.local` }));
    await sql`insert into auth.users ${sql(users)}`;
    await sql`insert into public.profiles ${sql(users.map((u) => ({ id: u.id, full_name: u.email })))}`;
    await sql`insert into public.staff_roles ${sql([
      { clinic_id: clinicA, profile_id: profiles.a, role: "doctor" },
      { clinic_id: clinicA, profile_id: profiles.c, role: "doctor" },
      { clinic_id: clinicB, profile_id: profiles.k, role: "doctor" },
      { clinic_id: clinicA, profile_id: profiles.receptionist, role: "receptionist" },
      { clinic_id: clinicA, profile_id: profiles.manager, role: "manager" },
      { clinic_id: clinicA, profile_id: profiles.owner, role: "owner" },
    ])}`;
    await sql`insert into public.doctors ${sql([
      { id: doctors.a, clinic_id: clinicA, profile_id: profiles.a, name: `Dr A ${suffix}`, active: true },
      { id: doctors.c, clinic_id: clinicA, profile_id: profiles.c, name: `Dr C ${suffix}`, active: true },
      { id: doctors.k, clinic_id: clinicB, profile_id: profiles.k, name: `Dr K ${suffix}`, active: true },
    ])}`;
    await sql`insert into public.services ${sql([
      { id: serviceA, clinic_id: clinicA, name: `Lab consult ${suffix}`, duration_minutes: 30, price: 100000 },
    ])}`;
    await sql`insert into public.doctor_working_hours ${sql(
      [doctors.a, doctors.c].flatMap((doctor_id) =>
        [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinic_id: clinicA, doctor_id, weekday, start_time: "00:00", end_time: "23:59" })),
      ),
    )}`;
  });

  afterAll(async () => {
    if (!sql) return;
    // Deleting the clinics removes every lab row with them (and proves it works).
    await sql`delete from public.clinics where id in ${sql([clinicA, clinicB])}`;
    await sql`delete from auth.users where id in ${sql(Object.values(profiles))}`;
    await sql.end({ timeout: 5 });
  });

  // ---------- patients: identity ----------

  describe("patient identity", () => {
    it("normalises passport / PINFL and keeps them unique within a clinic only", async () => {
      const first = await newPatient(clinicA, { document_number: " aa 12-34 567 ", pinfl: "3010 1990 0000 12" });
      const [stored] = await sql<{ document_number: string; pinfl: string }[]>`
        select document_number, pinfl from public.patients where id = ${first}`;
      expect(stored).toEqual({ document_number: "AA1234567", pinfl: "30101990000012" });

      const duplicate = await pgError(() => newPatient(clinicA, { document_number: "AA-1234567" }));
      expect(duplicate.code).toBe("23505");
      const duplicatePinfl = await pgError(() => newPatient(clinicA, { pinfl: "30101990000012" }));
      expect(duplicatePinfl.code).toBe("23505");

      // The same document in another clinic is another, valid patient.
      await expect(newPatient(clinicB, { document_number: "AA1234567", pinfl: "30101990000012" })).resolves.toBeTruthy();
    });

    it("rejects malformed identifiers and impossible dates of birth; sex may stay unknown", async () => {
      expect((await pgError(() => newPatient(clinicA, { pinfl: "12345" }))).code).toBe("23514");
      expect((await pgError(() => newPatient(clinicA, { document_number: "A!" }))).code).toBe("23514");
      expect((await pgError(() => newPatient(clinicA, { date_of_birth: "2999-01-01" }))).code).toBe("23514");
      await expect(newPatient(clinicA, { sex: null })).resolves.toBeTruthy();
    });
  });

  // ---------- catalog ----------

  describe("catalog", () => {
    it("is readable by clinic staff only, and nobody signed in can write it", async () => {
      const test = await newTest();
      const seen = (profile: string) =>
        asUser(profile, (tx) => tx<{ id: string }[]>`select id from public.lab_tests where id = ${test}`).then((r) => r.length);
      expect(await seen(profiles.receptionist)).toBe(1);
      expect(await seen(profiles.a)).toBe(1);
      expect(await seen(profiles.k)).toBe(0); // another clinic
      expect(await seen(profiles.outsider)).toBe(0);
      expect((await pgError(() => as("anon", null, (tx) => tx`select id from public.lab_tests`))).code).toBe("42501");

      const write = await pgError(() =>
        asUser(profiles.owner, (tx) => tx`update public.lab_tests set price = 1 where id = ${test}`),
      );
      expect(write.code).toBe("42501");
      const insert = await pgError(() =>
        asUser(profiles.owner, (tx) => tx`insert into public.lab_tests (clinic_id, code, name, sample_type) values (${clinicA}, 'X1', 'X', 'Blood')`),
      );
      expect(insert.code).toBe("42501");
    });

    it("refuses cross-clinic catalog references", async () => {
      const testB = await newTest(clinicB);
      const err = await pgError(() => newParameter(testB, {}, clinicA));
      expect(err.code).toBe("23503");
    });

    it("refuses overlapping active ranges and type-mismatched expectations", async () => {
      const parameter = await newParameter(await newTest());
      await newRange(parameter, { sex: "female", age_min_days: 0, age_max_days: 6570, low: 110, high: 150 });
      const overlap = await pgError(() => newRange(parameter, { sex: "female", age_min_days: 6000, low: 120, high: 160 }));
      expect(overlap.message).toMatch(/overlaps/);
      // Other sex, or a non-overlapping band, is fine.
      await newRange(parameter, { sex: "male", low: 130, high: 170 });
      await newRange(parameter, { sex: "female", age_min_days: 6571, low: 120, high: 160 });
      expect((await pgError(() => newRange(parameter, { sex: null, normal_text: "negative" }))).message).toMatch(/numeric/);

      const yesNo = await newParameter(await newTest(), { value_type: "boolean", unit: null });
      expect((await pgError(() => newRange(yesNo, { normal_text: "maybe" }))).message).toMatch(/true or false/);
    });

    it("fixes a parameter's identity once created", async () => {
      const parameter = await newParameter(await newTest());
      const err = await pgError(() =>
        asServer((tx) => tx`update public.lab_test_parameters set value_type = 'text', unit = null where id = ${parameter}`),
      );
      expect(err.message).toMatch(/cannot change/);
    });
  });

  // ---------- orders ----------

  describe("orders", () => {
    it("lets any clinic staff member order, and derives what the item is and costs from the catalog", async () => {
      const patient = await newPatient();
      const test = await newTest(clinicA, { price: 85000 });
      for (const orderedBy of [profiles.receptionist, profiles.manager, profiles.owner, profiles.c]) {
        const order = await newOrder(patient, { ordered_by: orderedBy });
        const item = await newItem(order, patient, test, { price_snapshot: 1, list_price_snapshot: 1, test_code_snapshot: "FORGED" });
        expect(Number(item.price_snapshot)).toBe(85000);
        expect(item.test_code_snapshot).not.toBe("FORGED");
      }
      // Not a staff member of this clinic.
      expect((await pgError(() => newOrder(patient, { ordered_by: profiles.k }))).message).toMatch(/staff member/);
      expect((await pgError(() => newOrder(patient, { ordered_by: profiles.outsider }))).message).toMatch(/staff member/);
    });

    it("requires the patient's date of birth (except for imports)", async () => {
      const patient = await newPatient(clinicA, { date_of_birth: null });
      expect((await pgError(() => newOrder(patient))).message).toMatch(/date of birth/);
      await expect(
        newOrder(patient, { source: "external_import", external_reference: `EXT-${suffix}-${codeSeq++}` }),
      ).resolves.toBeTruthy();
    });

    it("pins a consultation order to the ordering doctor's own consultation with this patient", async () => {
      const patient = await newPatient();
      const consultationA = await visit(patient, doctors.a);
      await expect(
        newOrder(patient, { source: "consultation", ordered_by: profiles.a, ordering_doctor_id: doctors.a, appointment_id: consultationA }),
      ).resolves.toBeTruthy();

      // Dr C cannot file an order under Dr A's consultation…
      const other = await pgError(() =>
        newOrder(patient, { source: "consultation", ordered_by: profiles.c, ordering_doctor_id: doctors.c, appointment_id: consultationA }),
      );
      expect(other.code).toBe("23503");
      // …nor claim to be Dr A.
      const impersonation = await pgError(() =>
        newOrder(patient, { source: "consultation", ordered_by: profiles.c, ordering_doctor_id: doctors.a, appointment_id: consultationA }),
      );
      expect(impersonation.message).toMatch(/own active doctor account/);
      // A consultation of another patient.
      const otherPatient = await newPatient();
      const wrongPatient = await pgError(() =>
        newOrder(otherPatient, { source: "consultation", ordered_by: profiles.a, ordering_doctor_id: doctors.a, appointment_id: consultationA }),
      );
      expect(wrongPatient.code).toBe("23503");
      // A doctor of another clinic.
      const crossClinic = await pgError(() => newOrder(patient, { ordered_by: profiles.a, ordering_doctor_id: doctors.k }));
      expect(crossClinic.message).toMatch(/own active doctor account/);
      // A consultation that has not started.
      const booked = await visit(patient, doctors.a, "confirmed");
      const notStarted = await pgError(() =>
        newOrder(patient, { source: "consultation", ordered_by: profiles.a, ordering_doctor_id: doctors.a, appointment_id: booked }),
      );
      expect(notStarted.message).toMatch(/in progress or completed/);
    });

    it("refuses orders for another clinic's patient and items from another clinic's catalog", async () => {
      const patientB = await newPatient(clinicB);
      expect((await pgError(() => newOrder(patientB))).code).toBe("23503");

      const patient = await newPatient();
      const order = await newOrder(patient);
      const testB = await newTest(clinicB);
      expect((await pgError(() => newItem(order, patient, testB))).message).toMatch(/unknown test/);
      // An item whose patient differs from the order's.
      const otherPatient = await newPatient();
      const anotherTest = await newTest();
      expect((await pgError(() => newItem(order, otherPatient, anotherTest))).code).toBe("23503");
    });

    it("cannot newly order an inactive test, yet keeps history of one", async () => {
      const patient = await newPatient();
      const test = await newTest();
      const order = await newOrder(patient);
      const item = await newItem(order, patient, test);
      await asServer((tx) => tx`update public.lab_tests set active = false where id = ${test}`);
      const laterOrder = await newOrder(patient);
      expect((await pgError(() => newItem(laterOrder, patient, test))).message).toMatch(/inactive/);
      expect(await itemStatus(item.id)).toBe("ordered");
    });

    it("keeps the allocated panel price on the item and requires panel membership", async () => {
      const patient = await newPatient();
      const cbc = await newTest(clinicA, { price: 100000 });
      const glucose = await newTest(clinicA, { price: 50000 });
      const [panel] = await asServer((tx) => tx<{ id: string }[]>`insert into public.lab_panels ${tx({
        clinic_id: clinicA, code: `PN${suffix}${codeSeq++}`, name: `Panel ${suffix}${codeSeq++}`, price: 120000,
      })} returning id`);
      await asServer((tx) => tx`insert into public.lab_panel_tests ${tx([{ panel_id: panel.id, test_id: cbc, clinic_id: clinicA }])}`);
      const order = await newOrder(patient);
      const item = await newItem(order, patient, cbc, { panel_id: panel.id, price_snapshot: 80000 });
      expect(Number(item.price_snapshot)).toBe(80000);
      expect((await pgError(() => newItem(order, patient, glucose, { panel_id: panel.id, price_snapshot: 40000 }))).message).toMatch(
        /not part of the panel/,
      );
    });

    it("rejects duplicate items, enforces creation-key idempotency, and fixes provenance after creation", async () => {
      const patient = await newPatient();
      const test = await newTest();
      const key = randomUUID();
      const order = await newOrder(patient, { creation_key: key });
      expect((await pgError(() => newOrder(patient, { creation_key: key }))).code).toBe("23505");
      await newItem(order, patient, test);
      expect((await pgError(() => newItem(order, patient, test))).code).toBe("23505");
      const err = await pgError(() => asServer((tx) => tx`update public.lab_orders set ordered_by = ${profiles.owner} where id = ${order}`));
      expect(err.message).toMatch(/cannot be changed/);
    });

    it("cancels an order and its open items, but not once a sample is collected", async () => {
      const patient = await newPatient();
      const order = await newOrder(patient);
      const item = (await newItem(order, patient, await newTest())).id;
      await asServer((tx) => tx`update public.lab_orders set status = 'cancelled', cancelled_by = ${profiles.receptionist}, cancel_reason = 'Patient left' where id = ${order}`);
      expect(await itemStatus(item)).toBe("cancelled");
      expect((await pgError(() => asServer((tx) => tx`update public.lab_orders set status = 'active' where id = ${order}`))).message).toMatch(
        /cannot change status/,
      );
      // No sample for a cancelled order.
      expect((await pgError(() => newSample(order, patient, []))).message).toMatch(/active order/);

      const fx = await collectedItem();
      const collected = await pgError(() =>
        asServer((tx) => tx`update public.lab_orders set status = 'cancelled', cancelled_by = ${profiles.receptionist} where id = ${fx.order}`),
      );
      expect(collected.message).toMatch(/collected samples/);
    });
  });

  // ---------- samples ----------

  describe("samples", () => {
    it("allows only legal item and sample transitions", async () => {
      const fx = await collectedItem();
      expect((await pgError(() => moveItem(fx.item, "verified"))).message).toMatch(/not allowed|requires/);
      expect((await pgError(() => moveItem(fx.item, "cancelled"))).message).toMatch(/not allowed/);
      await asServer((tx) => tx`update public.lab_samples set status = 'rejected', rejected_by = ${profiles.receptionist}, reject_reason = 'Haemolysed' where id = ${fx.sample}`);
      expect((await pgError(() => asServer((tx) => tx`update public.lab_samples set status = 'received', received_by = ${profiles.receptionist} where id = ${fx.sample}`))).message).toMatch(
        /not allowed/,
      );
      // A rejected sample's item can be recollected with a new sample.
      await moveItem(fx.item, "ready_for_collection");
      await expect(newSample(fx.order, fx.patient, [fx.item])).resolves.toBeTruthy();
    });

    it("never attaches a sample to another order, patient or clinic", async () => {
      const fx = await collectedItem();
      const other = await collectedItem();
      // fx's sample cannot serve other's item.
      const crossOrder = await pgError(() =>
        asServer((tx) => tx`insert into public.lab_sample_items ${tx({ sample_id: fx.sample, order_item_id: other.item, clinic_id: clinicA })}`),
      );
      expect(crossOrder.message).toMatch(/different orders/);
      // A sample whose patient is not the order's patient.
      const wrongPatient = await pgError(() =>
        asServer((tx) => tx`insert into public.lab_samples ${tx({
          clinic_id: clinicA, patient_id: other.patient, order_id: fx.order, sample_code: `S-${suffix}-${codeSeq++}`,
          sample_type: "Blood", collected_by: profiles.receptionist,
        })}`),
      );
      expect(wrongPatient.code).toBe("23503");
      // Recorded under another clinic.
      const crossClinic = await pgError(() =>
        asServer((tx) => tx`insert into public.lab_sample_items ${tx({ sample_id: fx.sample, order_item_id: fx.item, clinic_id: clinicB })}`),
      );
      expect(crossClinic.message).toMatch(/unknown sample or order item/);
    });

    it("lets only one of two concurrent collectors attach a live sample to an item", async () => {
      const patient = await newPatient();
      const order = await newOrder(patient);
      const item = (await newItem(order, patient, await newTest())).id;
      await moveItem(item, "ready_for_collection");
      const outcomes = await Promise.allSettled([newSample(order, patient, [item]), newSample(order, patient, [item])]);
      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from public.lab_sample_items where order_item_id = ${item}`;
      expect(n).toBe(1);
    });
  });

  // ---------- results ----------

  describe("results", () => {
    it("sets unit, range and flag from configuration and the patient's sex and age — never from the caller", async () => {
      const fx = await collectedItem();
      const result = await newResult(fx.item, fx.patient);
      expect(await itemStatus(fx.item)).toBe("processing");
      const value = await addValue(result, fx.parameter, { value_numeric: 118, flag: "normal", unit_snapshot: "forged", range_low: 0 });
      expect(value).toMatchObject({ flag: "low", unit_snapshot: "g/L" });
      expect(Number(value.range_low)).toBe(120);

      // Sex- and age-specific ranges win over generic ones.
      const parameter = await newParameter(fx.test, { code: `HB${codeSeq++}` });
      await newRange(parameter, { low: 100, high: 200 });
      await newRange(parameter, { sex: "female", age_min_days: 18 * 365, low: 120, high: 150 });
      expect((await addValue(result, parameter, { value_numeric: 160 })).flag).toBe("high");

      // Critical bounds are reported as such (no alerting exists).
      const critical = await newParameter(fx.test, { code: `CR${codeSeq++}` });
      await newRange(critical, { low: 120, high: 160, critical_low: 70 });
      expect((await addValue(result, critical, { value_numeric: 60 })).flag).toBe("critical_low");

      // No applicable range: not evaluated, never guessed.
      const unranged = await newParameter(fx.test, { code: `UN${codeSeq++}` });
      expect((await addValue(result, unranged, { value_numeric: 5 })).flag).toBe("not_evaluated");
    });

    it("validates values against the parameter type and the ordered test", async () => {
      const fx = await collectedItem();
      const result = await newResult(fx.item, fx.patient);
      expect((await pgError(() => addValue(result, fx.parameter, { value_text: "high" }))).message).toMatch(/expects a numeric/);
      expect((await pgError(() => addValue(result, fx.parameter, { value_numeric: 1, value_text: "x" }))).code).toBe("23514");
      const foreign = await newParameter(await newTest());
      expect((await pgError(() => addValue(result, foreign, { value_numeric: 1 }))).message).toMatch(/does not belong/);
      const choice = await newParameter(fx.test, { code: `CH${codeSeq++}`, value_type: "choice", unit: null, choices: ["negative", "positive"] });
      expect((await pgError(() => addValue(result, choice, { value_text: "maybe" }))).message).toMatch(/choices/);
      await newRange(choice, { normal_text: "negative" });
      expect((await addValue(result, choice, { value_text: "positive" })).flag).toBe("abnormal");
    });

    it("refuses results before collection, a second first version, and a result for another clinic or patient", async () => {
      const patient = await newPatient();
      const order = await newOrder(patient);
      const item = (await newItem(order, patient, await newTest())).id;
      expect((await pgError(() => newResult(item, patient))).message).toMatch(/after the sample is collected/);

      const fx = await collectedItem();
      await newResult(fx.item, fx.patient);
      expect((await pgError(() => newResult(fx.item, fx.patient))).message).toMatch(/already has a result/);

      const fresh = await collectedItem();
      const other = await newPatient();
      expect((await pgError(() => newResult(fresh.item, other))).code).toBe("23503");
      const crossClinic = await pgError(() =>
        asServer((tx) => tx`insert into public.lab_results ${tx({
          clinic_id: clinicB, patient_id: fresh.patient, order_item_id: fresh.item, entered_by: profiles.k,
        })}`),
      );
      expect(crossClinic.message).toMatch(/staff member|unknown order item/);
    });

    it("requires a second person to verify, and moves the item with the result", async () => {
      const fx = await collectedItem();
      const result = await newResult(fx.item, fx.patient);
      await addValue(result, fx.parameter, { value_numeric: 140 });
      await submit(result);
      expect(await itemStatus(fx.item)).toBe("resulted");

      // The person who entered (and submitted) it cannot verify it.
      expect((await pgError(() => verify(result, profiles.receptionist))).message).toMatch(/second person/);
      // Someone outside the clinic cannot verify it.
      expect((await pgError(() => verify(result, profiles.k))).message).toMatch(/staff member/);

      // Returned to draft for a fix, then resubmitted and verified by a doctor.
      await asServer((tx) => tx`update public.lab_results set status = 'draft' where id = ${result}`);
      expect(await itemStatus(fx.item)).toBe("processing");
      await submit(result);
      await verify(result, profiles.a);
      expect(await itemStatus(fx.item)).toBe("verified");

      // The CHECK constraint holds even without the trigger's message path.
      const [{ ok }] = await sql<{ ok: boolean }[]>`
        select verified_by <> entered_by and verified_by <> submitted_by as ok from public.lab_results where id = ${result}`;
      expect(ok).toBe(true);
    });

    it("never changes a verified result; a correction is a new version that supersedes it", async () => {
      const fx = await verifiedResult();
      expect((await pgError(() => asServer((tx) => tx`update public.lab_results set lab_comment = 'edited' where id = ${fx.result}`))).message).toMatch(
        /cannot be edited/,
      );
      expect((await pgError(() => asServer((tx) => tx`update public.lab_result_values set value_numeric = 150 where result_id = ${fx.result}`))).message).toMatch(
        /only a draft/,
      );
      expect((await pgError(() => asServer((tx) => tx`delete from public.lab_results where id = ${fx.result}`))).message).toMatch(/only a draft/);
      expect((await pgError(() => asServer((tx) => tx`update public.lab_results set status = 'superseded' where id = ${fx.result}`))).message).toMatch(
        /only by verifying its correction/,
      );

      // A correction without a reason, or skipping a version, is refused.
      expect((await pgError(() => newResult(fx.item, fx.patient, { version: 2, supersedes_result_id: fx.result }))).code).toBe("23514");
      expect(
        (await pgError(() => newResult(fx.item, fx.patient, { version: 3, supersedes_result_id: fx.result, correction_reason: "Transcription error" }))).message,
      ).toMatch(/version 2/);

      const correction = await newResult(fx.item, fx.patient, {
        version: 2, supersedes_result_id: fx.result, correction_reason: "Transcription error", entered_by: profiles.manager,
      });
      await addValue(correction, fx.parameter, { value_numeric: 128 });
      await submit(correction, profiles.manager);
      expect((await pgError(() => verify(correction, profiles.manager))).message).toMatch(/second person/);
      await verify(correction, profiles.a);

      const versions = await sql<{ id: string; version: number; status: string }[]>`
        select id, version, status from public.lab_results where order_item_id = ${fx.item} order by version`;
      expect(versions.map((v) => [v.version, v.status])).toEqual([[1, "superseded"], [2, "verified"]]);
      // The original values are preserved.
      const [original] = await sql<{ value_numeric: string; flag: string }[]>`
        select value_numeric, flag from public.lab_result_values where result_id = ${fx.result}`;
      expect(original).toMatchObject({ flag: "low" });
      expect(Number(original.value_numeric)).toBe(118);
      expect(await itemStatus(fx.item)).toBe("verified");
    });

    it("lets only one of two concurrent verifiers win", async () => {
      const fx = await collectedItem();
      const result = await newResult(fx.item, fx.patient);
      await addValue(result, fx.parameter, { value_numeric: 140 });
      await submit(result);
      const outcomes = await Promise.allSettled([verify(result, profiles.a), verify(result, profiles.manager)]);
      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      const [row] = await sql<{ status: string; verified_by: string }[]>`select status, verified_by from public.lab_results where id = ${result}`;
      expect(row.status).toBe("verified");
      expect([profiles.a, profiles.manager]).toContain(row.verified_by);
    });

    it("discards a draft with its values but keeps everything else", async () => {
      const fx = await collectedItem();
      const draft = await newResult(fx.item, fx.patient);
      await addValue(draft, fx.parameter, { value_numeric: 140 });
      await asServer((tx) => tx`delete from public.lab_results where id = ${draft}`);
      const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from public.lab_result_values where result_id = ${draft}`;
      expect(n).toBe(0);
    });
  });

  // ---------- documents ----------

  describe("documents", () => {
    it("records provenance, is withdrawn but never deleted, and stays in its clinic", async () => {
      const fx = await verifiedResult();
      const id = randomUUID();
      const doc = {
        id, clinic_id: clinicA, patient_id: fx.patient, order_id: fx.order, result_id: fx.result, kind: "report",
        storage_path: `${clinicA}/${id}`, mime_type: "application/pdf", size_bytes: 1024, sha256: "a".repeat(64),
        uploaded_by: profiles.receptionist,
      };
      await asServer((tx) => tx`insert into public.lab_documents ${tx(doc)}`);

      const wrongPathId = randomUUID();
      expect((await pgError(() => asServer((tx) => tx`insert into public.lab_documents ${tx({ ...doc, id: wrongPathId, storage_path: `${clinicB}/${wrongPathId}` })}`))).code).toBe("23514");
      const exeId = randomUUID();
      expect((await pgError(() => asServer((tx) => tx`insert into public.lab_documents ${tx({ ...doc, id: exeId, storage_path: `${clinicA}/${exeId}`, mime_type: "application/x-msdownload" })}`))).code).toBe("23514");
      const otherOrder = await collectedItem();
      const mismatchId = randomUUID();
      expect((await pgError(() => asServer((tx) => tx`insert into public.lab_documents ${tx({ ...doc, id: mismatchId, storage_path: `${clinicA}/${mismatchId}`, order_id: otherOrder.order, patient_id: otherOrder.patient })}`))).message).toMatch(
        /another order/,
      );

      // The server has no DELETE privilege at all (the trigger refuses it too).
      expect((await pgError(() => asServer((tx) => tx`delete from public.lab_documents where id = ${id}`))).code).toBe("42501");
      await asServer((tx) => tx`update public.lab_documents set withdrawn_by = ${profiles.manager}, withdraw_reason = 'Wrong file', withdrawn_at = now() where id = ${id}`);
      expect((await pgError(() => asServer((tx) => tx`update public.lab_documents set withdraw_reason = 'again' where id = ${id}`))).message).toMatch(
        /already withdrawn/,
      );

      const [bucket] = await sql<{ public: boolean }[]>`select public from storage.buckets where id = 'lab-documents'`;
      expect(bucket.public).toBe(false);
    });
  });

  // ---------- access, audit, deletion ----------

  describe("access, audit and deletion", () => {
    it("gives no signed-in role or anonymous caller any direct access to lab work or results", async () => {
      const fx = await verifiedResult();
      for (const profile of [profiles.a, profiles.receptionist, profiles.owner, profiles.k]) {
        for (const table of ["lab_orders", "lab_order_items", "lab_samples", "lab_results", "lab_result_values", "lab_documents"]) {
          const read = await pgError(() => asUser(profile, (tx) => tx.unsafe(`select id from public.${table} limit 1`)));
          expect(read.code).toBe("42501");
        }
        const write = await pgError(() =>
          asUser(profile, (tx) => tx`update public.lab_results set status = 'superseded' where id = ${fx.result}`),
        );
        expect(write.code).toBe("42501");
        const forge = await pgError(() =>
          asUser(profile, (tx) => tx`insert into public.lab_orders (clinic_id, patient_id, source, ordered_by) values (${clinicA}, ${fx.patient}, 'walk_in', ${profile})`),
        );
        expect(forge.code).toBe("42501");
      }
      expect((await pgError(() => as("anon", null, (tx) => tx`select id from public.lab_results`))).code).toBe("42501");
    });

    it("RLS backstop: result tables show nothing even with a stray grant; order status follows the access model", async () => {
      const fx = await verifiedResult();
      const ROLLBACK = Symbol("rollback");
      async function visible(profile: string, table: string, patient: string): Promise<number> {
        let n = -1;
        await sql
          .begin(async (tx) => {
            await tx.unsafe(`grant select on public.${table} to authenticated`);
            await tx.unsafe("set local role authenticated");
            await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: profile, role: "authenticated" })}, true)`;
            n = (await tx.unsafe(`select 1 from public.${table} where patient_id = $1`, [patient])).length;
            throw ROLLBACK;
          })
          .catch((e) => {
            if (e !== ROLLBACK) throw e;
          });
        return n;
      }
      for (const profile of [profiles.a, profiles.owner, profiles.receptionist]) {
        expect(await visible(profile, "lab_results", fx.patient)).toBe(0);
      }
      // Walk-in patient with no relationship to any doctor: operational staff
      // see the work status, doctors (no relationship) and other clinics do not.
      expect(await visible(profiles.receptionist, "lab_order_items", fx.patient)).toBe(1);
      expect(await visible(profiles.c, "lab_order_items", fx.patient)).toBe(0);
      expect(await visible(profiles.k, "lab_order_items", fx.patient)).toBe(0);
      // Once Dr A has seen the patient, Dr A is admitted (doctor_patient_access).
      await visit(fx.patient, doctors.a, "completed");
      expect(await visible(profiles.a, "lab_order_items", fx.patient)).toBe(1);
      expect(await visible(profiles.c, "lab_order_items", fx.patient)).toBe(0);
    });

    it("audits the lifecycle with ids and states only — never values or comments", async () => {
      const fx = await collectedItem();
      const result = await newResult(fx.item, fx.patient, { lab_comment: "Sample slightly lipaemic" });
      await addValue(result, fx.parameter, { value_numeric: 187.5 });
      await submit(result);
      await verify(result);
      const rows = await sql<{ action: string; actor_id: string | null; new_values: unknown; old_values: unknown }[]>`
        select action, actor_id, new_values, old_values from public.audit_events
        where clinic_id = ${clinicA} and (entity_id = ${result} or entity_id = ${fx.item} or entity_id = ${fx.order} or entity_id = ${fx.sample})
        order by created_at`;
      const actions = rows.map((r) => r.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          "lab_order_created", "lab_order_item_created", "lab_sample_collected", "lab_order_item_status_changed",
          "lab_result_entered", "lab_result_submitted", "lab_result_verified",
        ]),
      );
      expect(rows.find((r) => r.action === "lab_result_verified")?.actor_id).toBe(profiles.a);
      const text = JSON.stringify(rows);
      expect(text).not.toContain("187.5");
      expect(text).not.toContain("lipaemic");
    });

    it("never deletes a patient's lab history with the patient", async () => {
      const fx = await verifiedResult();
      const err = await pgError(() => asServer((tx) => tx`delete from public.patients where id = ${fx.patient}`));
      expect(err.code).toBe("23503");
    });

    it("erases a clinic together with all of its lab data", async () => {
      const clinic = randomUUID();
      await sql`insert into public.clinics ${sql({ id: clinic, name: `Lab erase ${suffix}`, slug: `lab-erase-${suffix}`, timezone: "Asia/Tashkent" })}`;
      await sql`insert into public.staff_roles ${sql({ clinic_id: clinic, profile_id: profiles.manager, role: "manager" })}`;
      await sql`insert into public.staff_roles ${sql({ clinic_id: clinic, profile_id: profiles.owner, role: "owner" })}`;
      const patient = await newPatient(clinic);
      const test = await newTest(clinic);
      const parameter = await newParameter(test, {}, clinic);
      const order = await newOrder(patient, { ordered_by: profiles.manager }, clinic);
      const item = (await newItem(order, patient, test, {}, clinic)).id;
      await asServer((tx) => tx`update public.lab_order_items set status = 'ready_for_collection' where id = ${item}`);
      const sampleId = randomUUID();
      await asServer(async (tx) => {
        await tx`insert into public.lab_samples ${tx({ id: sampleId, clinic_id: clinic, patient_id: patient, order_id: order, sample_code: `S-E-${suffix}`, sample_type: "Blood", collected_by: profiles.manager })}`;
        await tx`insert into public.lab_sample_items ${tx({ sample_id: sampleId, order_item_id: item, clinic_id: clinic })}`;
        await tx`update public.lab_order_items set status = 'collected' where id = ${item}`;
      });
      const [result] = await asServer((tx) => tx<{ id: string }[]>`insert into public.lab_results ${tx({ clinic_id: clinic, patient_id: patient, order_item_id: item, entered_by: profiles.manager })} returning id`);
      await asServer((tx) => tx`insert into public.lab_result_values ${tx({ clinic_id: clinic, result_id: result.id, parameter_id: parameter, value_numeric: 1 })}`);
      await asServer((tx) => tx`update public.lab_results set status = 'submitted', submitted_by = ${profiles.manager} where id = ${result.id}`);
      await asServer((tx) => tx`update public.lab_results set status = 'verified', verified_by = ${profiles.owner} where id = ${result.id}`);

      await sql`delete from public.clinics where id = ${clinic}`;
      const [{ n }] = await sql<{ n: number }[]>`
        select (select count(*) from public.lab_results where clinic_id = ${clinic})
             + (select count(*) from public.lab_orders where clinic_id = ${clinic})
             + (select count(*) from public.lab_tests where clinic_id = ${clinic})::int as n`;
      expect(Number(n)).toBe(0);
    });
  });
});
