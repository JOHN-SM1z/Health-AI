import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

/**
 * Sample collection (supabase/migrations/20261005000009): collect_lab_sample,
 * receive_lab_sample and reject_lab_sample at the database — lifecycle,
 * refusals (cancelled order / item, unpaid under "before collection", another
 * order / patient / clinic, mixed sample types), idempotent replay, and
 * concurrency: two collectors racing for the same item produce one sample.
 */

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

async function probe(): Promise<string | null> {
  const p = postgres(DB_URL, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    const [row] = await p<{ ok: boolean }[]>`select to_regprocedure('public.collect_lab_sample(uuid,uuid,uuid[],uuid,text,uuid)') is not null as ok`;
    return row.ok ? null : "sample collection migration not applied";
  } catch (e) {
    return `database unreachable — ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    await p.end({ timeout: 1 });
  }
}

const unavailable = await probe();
if (unavailable) process.stderr.write(`\n⚠️  lab sample collection database suite SKIPPED (${unavailable})\n\n`);

async function pgError(run: () => Promise<unknown>): Promise<postgres.PostgresError> {
  try {
    await run();
  } catch (e) {
    if (e instanceof postgres.PostgresError) return e;
    throw e;
  }
  throw new Error("expected the database to reject the statement");
}

describe.skipIf(unavailable !== null)("sample collection — database", () => {
  let sql: postgres.Sql;
  const suffix = Date.now().toString(36);
  const clinic: string = randomUUID();
  const otherClinic: string = randomUUID();
  const reception = randomUUID();
  const labTech = randomUUID();
  const outsider = randomUUID();
  let seq = 0;

  const asServer = <T,>(run: (tx: postgres.TransactionSql) => Promise<T>) =>
    sql.begin(async (tx) => {
      await tx.unsafe("set local role service_role");
      return run(tx);
    }) as Promise<T>;

  type Collected = { lab_sample_id: string; sample_code: string; replayed: boolean };
  const collect = (orderId: string, itemIds: string[], opts: { by?: string; key?: string | null; clinicId?: string; notes?: string | null } = {}) =>
    asServer(async (tx) => {
      const [row] = await tx<Collected[]>`
        select * from public.collect_lab_sample(${opts.clinicId ?? clinic}, ${orderId}, ${itemIds}::uuid[],
          ${opts.by ?? reception}, ${opts.notes ?? null}, ${opts.key ?? null})`;
      return row;
    });
  const receive = (sampleId: string, by = labTech, clinicId = clinic) =>
    asServer(async (tx) => (await tx<{ r: boolean }[]>`select public.receive_lab_sample(${clinicId}, ${sampleId}, ${by}) as r`)[0].r);
  const reject = (sampleId: string, reason: string | null, by = labTech, clinicId = clinic) =>
    asServer(async (tx) => (await tx<{ r: boolean }[]>`select public.reject_lab_sample(${clinicId}, ${sampleId}, ${by}, ${reason}) as r`)[0].r);

  async function patient(clinicId = clinic) {
    const id = randomUUID();
    await sql`insert into public.patients ${sql({ id, clinic_id: clinicId, full_name: `Sample patient ${suffix}`, date_of_birth: "1990-01-01" })}`;
    return id;
  }
  async function test(sampleType = "Qon", clinicId = clinic) {
    const code = `S${suffix}${seq++}`;
    const [row] = await sql<{ id: string }[]>`insert into public.lab_tests ${sql({ clinic_id: clinicId, code, name: `Test ${code}`, sample_type: sampleType, price: 1000 })} returning id`;
    return row.id;
  }
  async function order(tests: string[], opts: { patientId?: string; clinicId?: string; by?: string } = {}) {
    const clinicId = opts.clinicId ?? clinic;
    const patientId = opts.patientId ?? (await patient(clinicId));
    const [row] = await asServer((tx) => tx<{ lab_order_id: string }[]>`
      select * from public.create_lab_order(${clinicId}, ${patientId}, ${opts.by ?? reception}, 'walk_in', ${tests}::uuid[], '{}'::uuid[])`);
    const items = await sql<{ id: string; test_id: string }[]>`select id, test_id from public.lab_order_items where order_id = ${row.lab_order_id}`;
    const itemOf = (testId: string) => items.find((i) => i.test_id === testId)!.id;
    return { orderId: row.lab_order_id, patientId, itemOf, itemIds: items.map((i) => i.id) };
  }
  const statusOf = async (itemId: string) => (await sql<{ status: string }[]>`select status from public.lab_order_items where id = ${itemId}`)[0].status;
  const sample = async (id: string) =>
    (await sql<{ status: string; sample_type: string; patient_id: string; order_id: string; collected_by: string; sample_code: string; reject_reason: string | null }[]>`
      select status, sample_type, patient_id, order_id, collected_by, sample_code, reject_reason from public.lab_samples where id = ${id}`)[0];

  beforeAll(async () => {
    sql = postgres(DB_URL, { max: 8, onnotice: () => {} });
    await sql`insert into public.clinics ${sql([
      { id: clinic, name: `Sample clinic ${suffix}`, slug: `sample-${suffix}`, timezone: "Asia/Tashkent" },
      { id: otherClinic, name: `Sample other ${suffix}`, slug: `sample-other-${suffix}`, timezone: "Asia/Tashkent" },
    ])}`;
    await sql`insert into auth.users ${sql([
      { id: reception, email: `sample-rec-${suffix}@test.local` },
      { id: labTech, email: `sample-lab-${suffix}@test.local` },
      { id: outsider, email: `sample-out-${suffix}@test.local` },
    ])}`;
    await sql`insert into public.profiles ${sql([{ id: reception, full_name: "Reception" }, { id: labTech, full_name: "Lab" }, { id: outsider, full_name: "Other" }])}`;
    await sql`insert into public.staff_roles ${sql([
      { clinic_id: clinic, profile_id: reception, role: "receptionist" },
      { clinic_id: clinic, profile_id: labTech, role: "lab" },
      { clinic_id: otherClinic, profile_id: outsider, role: "lab" },
    ])}`;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from public.app_settings where clinic_id = ${clinic}`;
    await sql`delete from public.clinics where id in ${sql([clinic, otherClinic])}`;
    await sql`delete from auth.users where id in ${sql([reception, labTech, outsider])}`;
    await sql.end({ timeout: 5 });
  });

  it("collects one tube for several tests of the same sample type: ORDERED → READY → COLLECTED → PROCESSING", async () => {
    const a = await test();
    const b = await test();
    const o = await order([a, b]);
    expect(await statusOf(o.itemOf(a))).toBe("ready_for_collection");

    const s = await collect(o.orderId, o.itemIds, { notes: "  ikkinchi urinish  " });
    expect(s.replayed).toBe(false);
    expect(s.sample_code).toMatch(/^\d{6}-[0-9A-F]{6}$/);
    expect(await sample(s.lab_sample_id)).toMatchObject({ status: "collected", sample_type: "Qon", patient_id: o.patientId, order_id: o.orderId, collected_by: reception });
    expect((await sql`select notes from public.lab_samples where id = ${s.lab_sample_id}`)[0].notes).toBe("ikkinchi urinish");
    for (const id of o.itemIds) expect(await statusOf(id)).toBe("collected");

    expect(await receive(s.lab_sample_id)).toBe(true);
    expect(await receive(s.lab_sample_id)).toBe(false); // already received
    expect((await sample(s.lab_sample_id)).status).toBe("received");
    for (const id of o.itemIds) expect(await statusOf(id)).toBe("processing");

    // Audit: ids and states only, with the actors.
    const audit = await sql<{ action: string; actor_id: string; new_values: Record<string, unknown> }[]>`
      select action, actor_id, new_values from public.audit_events where entity_id = ${s.lab_sample_id} order by created_at, id`;
    expect(audit.map((r) => [r.action, r.actor_id])).toEqual([
      ["lab_sample_collected", reception],
      ["lab_sample_received", labTech],
    ]);
    expect(JSON.stringify(audit)).not.toContain("ikkinchi");
  });

  it("refuses tests needing different sample types in one tube", async () => {
    const blood = await test("Qon");
    const urine = await test("Siydik");
    const o = await order([blood, urine]);
    expect((await pgError(() => collect(o.orderId, o.itemIds))).message).toMatch(/lab_sample_mixed_types/);
    // Separately they are fine.
    await collect(o.orderId, [o.itemOf(blood)]);
    await collect(o.orderId, [o.itemOf(urine)]);
    expect(await statusOf(o.itemOf(urine))).toBe("collected");
  });

  it("refuses a cancelled order and a cancelled item", async () => {
    const a = await test();
    const cancelled = await order([a]);
    await sql`update public.lab_orders set status = 'cancelled', cancelled_at = now(), cancelled_by = ${reception} where id = ${cancelled.orderId}`;
    expect((await pgError(() => collect(cancelled.orderId, cancelled.itemIds))).message).toMatch(/lab_sample_order_not_active/);

    const b = await test();
    const c = await test();
    const partly = await order([b, c]);
    await sql`update public.lab_order_items set status = 'cancelled' where id = ${partly.itemOf(b)}`;
    expect((await pgError(() => collect(partly.orderId, [partly.itemOf(b)]))).message).toMatch(/lab_sample_item_cancelled/);
    expect((await collect(partly.orderId, [partly.itemOf(c)])).replayed).toBe(false);
  });

  it("refuses an item still waiting for payment under the 'before collection' policy", async () => {
    await sql`insert into public.app_settings ${sql({ clinic_id: clinic, key: "lab", value: sql.json({ paymentPolicy: "before_collection", releaseToPatient: true }) })}`;
    try {
      const o = await order([await test()]);
      expect(await statusOf(o.itemIds[0])).toBe("ordered");
      expect((await pgError(() => collect(o.orderId, o.itemIds))).message).toMatch(/lab_sample_item_not_ready/);
    } finally {
      await sql`delete from public.app_settings where clinic_id = ${clinic} and key = 'lab'`;
    }
  });

  it("never joins an item of another order, patient or clinic", async () => {
    const a = await test();
    const mine = await order([a]);
    const sameClinicOther = await order([a]);
    expect((await pgError(() => collect(mine.orderId, [sameClinicOther.itemIds[0]]))).message).toMatch(/lab_sample_foreign_item/);
    expect((await pgError(() => collect(mine.orderId, [...mine.itemIds, sameClinicOther.itemIds[0]]))).message).toMatch(/lab_sample_foreign_item/);

    const foreignTest = await test("Qon", otherClinic);
    const foreign = await order([foreignTest], { clinicId: otherClinic, by: outsider });
    // Another clinic's item through this clinic's order…
    expect((await pgError(() => collect(mine.orderId, foreign.itemIds))).message).toMatch(/lab_sample_foreign_item/);
    // …or this clinic's order addressed as the other clinic.
    expect((await pgError(() => collect(mine.orderId, mine.itemIds, { clinicId: otherClinic, by: outsider }))).message).toMatch(/lab_sample_unknown_order/);
    // A collector from another clinic.
    expect((await pgError(() => collect(mine.orderId, mine.itemIds, { by: outsider }))).message).toMatch(/collected_by must be a staff member/);

    // Direct writes cannot attach another patient's item either.
    const s = await collect(mine.orderId, mine.itemIds);
    const err = await pgError(() => asServer((tx) => tx`insert into public.lab_sample_items ${tx({ sample_id: s.lab_sample_id, order_item_id: sameClinicOther.itemIds[0], clinic_id: clinic })}`));
    expect(err.message).toMatch(/different orders/);
    for (const id of [...mine.itemIds, ...sameClinicOther.itemIds]) expect(await statusOf(id)).toBe(id === sameClinicOther.itemIds[0] ? "ready_for_collection" : "collected");
  });

  it("refuses a second sample for an already collected item", async () => {
    const o = await order([await test()]);
    await collect(o.orderId, o.itemIds);
    expect((await pgError(() => collect(o.orderId, o.itemIds, { by: labTech }))).message).toMatch(/lab_sample_item_already_collected/);
    expect((await sql`select count(*)::int as n from public.lab_samples where order_id = ${o.orderId}`)[0].n).toBe(1);
  });

  it("replays a repeated submit with the same key, and refuses the key for a different sample", async () => {
    const a = await test();
    const b = await test();
    const o = await order([a, b]);
    const key = randomUUID();
    const first = await collect(o.orderId, [o.itemOf(a)], { key });
    const again = await collect(o.orderId, [o.itemOf(a)], { key });
    expect(again).toEqual({ ...first, replayed: true });
    expect((await pgError(() => collect(o.orderId, [o.itemOf(b)], { key }))).message).toMatch(/lab_sample_key_reused/);
  });

  it("two collectors racing for the same item create exactly one sample", async () => {
    for (let round = 0; round < 5; round++) {
      const o = await order([await test()]);
      const results = await Promise.allSettled([
        collect(o.orderId, o.itemIds, { by: reception }),
        collect(o.orderId, o.itemIds, { by: labTech }),
        collect(o.orderId, o.itemIds, { by: reception }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results) {
        if (r.status === "rejected") expect(String((r.reason as Error).message)).toMatch(/lab_sample_item_already_collected/);
      }
      expect((await sql`select count(*)::int as n from public.lab_sample_items where order_item_id = ${o.itemIds[0]}`)[0].n).toBe(1);
    }
  });

  it("the same key submitted twice at once still creates one sample", async () => {
    const o = await order([await test()]);
    const key = randomUUID();
    const [x, y] = await Promise.all([collect(o.orderId, o.itemIds, { key }), collect(o.orderId, o.itemIds, { key })]);
    expect(x.lab_sample_id).toBe(y.lab_sample_id);
    expect([x.replayed, y.replayed].sort()).toEqual([false, true]);
  });

  it("rejecting a sample returns its tests for a new sample; a rejection needs a reason", async () => {
    const o = await order([await test()]);
    const s = await collect(o.orderId, o.itemIds);
    await receive(s.lab_sample_id);
    expect((await pgError(() => reject(s.lab_sample_id, "  "))).message).toMatch(/lab_sample_reason_required/);
    expect(await reject(s.lab_sample_id, "Gemoliz")).toBe(true);
    expect(await reject(s.lab_sample_id, "Gemoliz")).toBe(false);
    expect(await sample(s.lab_sample_id)).toMatchObject({ status: "rejected", reject_reason: "Gemoliz" });
    expect(await statusOf(o.itemIds[0])).toBe("ready_for_collection");
    expect((await pgError(() => receive(s.lab_sample_id))).message).toMatch(/lab_sample_not_collected/);

    // A new sample can now be collected for the same test.
    const second = await collect(o.orderId, o.itemIds, { by: labTech });
    expect(second.lab_sample_id).not.toBe(s.lab_sample_id);
    expect(await statusOf(o.itemIds[0])).toBe("collected");
    const audit = await sql<{ new_values: Record<string, unknown> }[]>`select new_values from public.audit_events where entity_id = ${s.lab_sample_id} and action = 'lab_sample_rejected'`;
    expect(JSON.stringify(audit)).not.toContain("Gemoliz");
  });

  it("refuses rejecting a sample once a test has a result (even a draft)", async () => {
    const o = await order([await test()]);
    const s = await collect(o.orderId, o.itemIds);
    await receive(s.lab_sample_id);
    await asServer((tx) => tx`insert into public.lab_results ${tx({ clinic_id: clinic, patient_id: o.patientId, order_item_id: o.itemIds[0], entered_by: labTech })}`);
    expect((await pgError(() => reject(s.lab_sample_id, "Kech"))).message).toMatch(/lab_sample_has_results/);
    expect((await sample(s.lab_sample_id)).status).toBe("received");
  });

  it("receive and reject stay inside the clinic", async () => {
    const o = await order([await test()]);
    const s = await collect(o.orderId, o.itemIds);
    expect((await pgError(() => receive(s.lab_sample_id, outsider, otherClinic))).message).toMatch(/lab_sample_not_found/);
    expect((await pgError(() => reject(s.lab_sample_id, "x", outsider, otherClinic))).message).toMatch(/lab_sample_not_found/);
    expect((await pgError(() => receive(s.lab_sample_id, outsider))).message).toMatch(/received_by must be a staff member/);
    expect((await sample(s.lab_sample_id)).status).toBe("collected");
  });

  it("signed-in roles cannot call the collection functions", async () => {
    for (const fn of [
      "collect_lab_sample(uuid,uuid,uuid[],uuid,text,uuid)",
      "receive_lab_sample(uuid,uuid,uuid)",
      "reject_lab_sample(uuid,uuid,uuid,text)",
    ]) {
      for (const role of ["anon", "authenticated"]) {
        const [row] = await sql<{ ok: boolean }[]>`select has_function_privilege(${role}, ${`public.${fn}`}, 'execute') as ok`;
        expect(row.ok, `${role} ${fn}`).toBe(false);
      }
    }
  });
});
