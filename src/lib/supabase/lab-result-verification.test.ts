import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { idFree } from "@/test/id-free";

/**
 * Verification and versioning (supabase/migrations/20261005000011):
 * verify_lab_result, return_lab_result, start_lab_result_correction — second
 * person, order completion, corrections as new versions with the previous one
 * preserved, audit with the right actors, tenancy and races (one final state
 * wins).
 */

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

async function probe(): Promise<string | null> {
  const p = postgres(DB_URL, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    const [row] = await p<{ ok: boolean }[]>`select to_regprocedure('public.verify_lab_result(uuid,uuid,uuid)') is not null as ok`;
    return row.ok ? null : "verification migration not applied";
  } catch (e) {
    return `database unreachable — ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    await p.end({ timeout: 1 });
  }
}

const unavailable = await probe();
if (unavailable) process.stderr.write(`\n⚠️  lab result verification database suite SKIPPED (${unavailable})\n\n`);

async function pgError(run: () => Promise<unknown>): Promise<postgres.PostgresError> {
  try {
    await run();
  } catch (e) {
    if (e instanceof postgres.PostgresError) return e;
    throw e;
  }
  throw new Error("expected the database to reject the statement");
}

describe.skipIf(unavailable !== null)("lab result verification — database", () => {
  let sql: postgres.Sql;
  const suffix = Date.now().toString(36);
  const clinic: string = randomUUID();
  const otherClinic: string = randomUUID();
  const tech = randomUUID();
  const reviewer = randomUUID();
  const reviewer2 = randomUUID();
  const outsider = randomUUID();
  let test = "";
  let hgb = "";
  let seq = 0;

  const asServer = <T,>(run: (tx: postgres.TransactionSql) => Promise<T>) =>
    sql.begin(async (tx) => {
      await tx.unsafe("set local role service_role");
      return run(tx);
    }) as Promise<T>;

  const save = (itemId: string, value: number, by = tech) =>
    asServer(async (tx) => (await tx<{ lab_result_id: string; created: boolean }[]>`
      select * from public.save_lab_result_draft(${clinic}, ${itemId}, ${by}, ${tx.json([{ parameter_id: hgb, value_numeric: value }])}::jsonb, null, null)`)[0]);
  const submit = (id: string, by = tech) => asServer(async (tx) => (await tx<{ r: boolean }[]>`select public.submit_lab_result(${clinic}, ${id}, ${by}) as r`)[0].r);
  const verify = (id: string, by = reviewer, clinicId = clinic) =>
    asServer(async (tx) => (await tx<{ r: boolean }[]>`select public.verify_lab_result(${clinicId}, ${id}, ${by}) as r`)[0].r);
  const giveBack = (id: string, by = reviewer, clinicId = clinic) =>
    asServer(async (tx) => (await tx<{ r: boolean }[]>`select public.return_lab_result(${clinicId}, ${id}, ${by}) as r`)[0].r);
  const correct = (id: string, reason: string | null, by = tech, clinicId = clinic) =>
    asServer(async (tx) => (await tx<{ lab_result_id: string; created: boolean }[]>`
      select * from public.start_lab_result_correction(${clinicId}, ${id}, ${by}, ${reason})`)[0]);

  const row = async (id: string) =>
    (await sql<{ status: string; version: number; supersedes_result_id: string | null; entered_by: string; submitted_by: string | null; verified_by: string | null; verified_at: Date | null; correction_reason: string | null }[]>`
      select status, version, supersedes_result_id, entered_by, submitted_by, verified_by, verified_at, correction_reason from public.lab_results where id = ${id}`)[0];
  const valueOf = async (id: string) => (await sql<{ v: string }[]>`select value_numeric::text as v from public.lab_result_values where result_id = ${id}`)[0]?.v;
  const itemStatus = async (itemId: string) => (await sql<{ status: string }[]>`select status from public.lab_order_items where id = ${itemId}`)[0].status;
  const orderStatus = async (orderId: string) => (await sql<{ status: string }[]>`select status from public.lab_orders where id = ${orderId}`)[0].status;

  /** An order with `tests` tests, all received; returns the item ids. */
  async function received(tests = 1) {
    const patient = randomUUID();
    await sql`insert into public.patients ${sql({ id: patient, clinic_id: clinic, full_name: `Verify patient ${suffix} ${seq++}`, date_of_birth: "1980-01-01" })}`;
    const testIds = [test];
    for (let i = 1; i < tests; i++) {
      const [t] = await sql<{ id: string }[]>`insert into public.lab_tests ${sql({ clinic_id: clinic, code: `V${suffix}${seq++}`, name: "Extra", sample_type: "Qon", price: 1 })} returning id`;
      testIds.push(t.id);
    }
    return asServer(async (tx) => {
      const [o] = await tx<{ lab_order_id: string }[]>`select * from public.create_lab_order(${clinic}, ${patient}, ${tech}, 'walk_in', ${testIds}::uuid[], '{}'::uuid[])`;
      const items = await tx<{ id: string; test_id: string }[]>`select id, test_id from public.lab_order_items where order_id = ${o.lab_order_id}`;
      const [s] = await tx<{ lab_sample_id: string }[]>`select * from public.collect_lab_sample(${clinic}, ${o.lab_order_id}, ${items.map((i) => i.id)}::uuid[], ${tech})`;
      await tx`select public.receive_lab_sample(${clinic}, ${s.lab_sample_id}, ${tech})`;
      return { orderId: o.lab_order_id, items: items.sort((a, b) => (a.test_id === test ? -1 : b.test_id === test ? 1 : 0)).map((i) => i.id) };
    });
  }

  /** A submitted first result with HGB = value. */
  async function submitted(value = 130) {
    const { orderId, items } = await received();
    const { lab_result_id: id } = await save(items[0], value);
    await submit(id);
    return { orderId, itemId: items[0], id };
  }

  beforeAll(async () => {
    sql = postgres(DB_URL, { max: 8, onnotice: () => {} });
    await sql`insert into public.clinics ${sql([
      { id: clinic, name: `Verify clinic ${suffix}`, slug: `verify-${suffix}`, timezone: "Asia/Tashkent" },
      { id: otherClinic, name: `Verify other ${suffix}`, slug: `verify-other-${suffix}`, timezone: "Asia/Tashkent" },
    ])}`;
    await sql`insert into auth.users ${sql([tech, reviewer, reviewer2, outsider].map((id, i) => ({ id, email: `verify-${i}-${suffix}@test.local` })))}`;
    await sql`insert into public.profiles ${sql([tech, reviewer, reviewer2, outsider].map((id, i) => ({ id, full_name: `P${i}` })))}`;
    await sql`insert into public.staff_roles ${sql([
      { clinic_id: clinic, profile_id: tech, role: "lab" },
      { clinic_id: clinic, profile_id: reviewer, role: "lab" },
      { clinic_id: clinic, profile_id: reviewer2, role: "doctor" },
      { clinic_id: otherClinic, profile_id: outsider, role: "lab" },
    ])}`;
    const [t] = await sql<{ id: string }[]>`insert into public.lab_tests ${sql({ clinic_id: clinic, code: `VHB${suffix}`, name: `HB ${suffix}`, sample_type: "Qon", price: 1 })} returning id`;
    test = t.id;
    const [p] = await sql<{ id: string }[]>`insert into public.lab_test_parameters ${sql({ clinic_id: clinic, test_id: test, code: "HGB", name: "HGB", value_type: "numeric", unit: "g/L" })} returning id`;
    hgb = p.id;
    await sql`insert into public.lab_reference_ranges ${sql({ clinic_id: clinic, parameter_id: hgb, low: 120, high: 160 })}`;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from public.clinics where id in ${sql([clinic, otherClinic])}`;
    await sql`delete from auth.users where id in ${sql([tech, reviewer, reviewer2, outsider])}`;
    await sql.end({ timeout: 5 });
  });

  it("a second person verifies; the test becomes verified and the order completes", async () => {
    const { orderId, itemId, id } = await submitted();
    expect((await pgError(() => verify(id, tech))).message).toMatch(/lab_result_second_person/);
    expect(await verify(id, reviewer)).toBe(true);
    expect(await verify(id, reviewer)).toBe(false); // repeat: nothing to do
    expect(await row(id)).toMatchObject({ status: "verified", entered_by: tech, submitted_by: tech, verified_by: reviewer });
    expect(await itemStatus(itemId)).toBe("verified");
    expect(await orderStatus(orderId)).toBe("completed");
    expect((await pgError(() => verify(id, reviewer2))).message).toMatch(/lab_result_not_submitted/);
  });

  it("completes the order only when every test is verified", async () => {
    const { orderId, items } = await received(2);
    const a = await save(items[0], 130);
    await submit(a.lab_result_id);
    await verify(a.lab_result_id);
    expect(await orderStatus(orderId)).toBe("active");
  });

  it("only a submitted result can be verified", async () => {
    const { items } = await received();
    const { lab_result_id: id } = await save(items[0], 130);
    expect((await pgError(() => verify(id))).message).toMatch(/lab_result_not_submitted: the result is draft/);
  });

  it("a reviewer returns a submitted result to its author, who fixes and resubmits it", async () => {
    const { itemId, id } = await submitted(1300);
    expect(await giveBack(id)).toBe(true);
    expect(await row(id)).toMatchObject({ status: "draft", submitted_by: null });
    expect(await itemStatus(itemId)).toBe("processing");
    expect((await pgError(() => giveBack(id))).message).toMatch(/lab_result_not_submitted/);
    // The author (only) edits and resubmits; a different person verifies.
    expect((await pgError(() => save(itemId, 130, reviewer))).message).toMatch(/lab_result_draft_owned/);
    await save(itemId, 130);
    await submit(id);
    await verify(id, reviewer);
    expect(await valueOf(id)).toBe("130");
    const audit = await sql<{ action: string; actor_id: string }[]>`select action, actor_id from public.audit_events where entity_id = ${id} order by created_at, id`;
    expect(audit.map((a) => [a.action, a.actor_id])).toEqual([
      ["lab_result_entered", tech],
      ["lab_result_submitted", tech],
      ["lab_result_returned", reviewer],
      ["lab_result_submitted", tech],
      ["lab_result_verified", reviewer],
    ]);
    const itemAudit = await sql<{ actor_id: string | null }[]>`
      select actor_id from public.audit_events where entity_id = ${itemId} and action = 'lab_order_item_status_changed' and new_values->>'status' = 'processing' and new_values->>'previous_status' = 'resulted'`;
    expect(itemAudit.map((a) => a.actor_id)).toEqual([reviewer]);
  });

  it("a verified result is never overwritten: a correction is a new version, the previous one is preserved", async () => {
    const { itemId, id: v1 } = await submitted(130);
    await verify(v1, reviewer);
    const v1Before = await row(v1);

    // Direct edits of the verified version are refused even for the server.
    expect((await pgError(() => asServer((tx) => tx`update public.lab_result_values set value_numeric = 99 where result_id = ${v1}`))).message).toMatch(/only a draft result accepts values/);
    expect((await pgError(() => save(itemId, 99))).message).toMatch(/lab_result_verified/);

    expect((await pgError(() => correct(v1, "  "))).message).toMatch(/lab_result_reason_required/);
    const c = await correct(v1, "Namuna aralashib ketgan");
    expect(c.created).toBe(true);
    expect(await correct(v1, "Namuna aralashib ketgan")).toEqual({ lab_result_id: c.lab_result_id, created: false }); // same person: replay
    expect((await pgError(() => correct(v1, "Boshqa sabab", reviewer))).message).toMatch(/lab_result_correction_exists/);
    expect(await row(c.lab_result_id)).toMatchObject({ status: "draft", version: 2, supersedes_result_id: v1, entered_by: tech, correction_reason: "Namuna aralashib ketgan" });
    expect(await valueOf(c.lab_result_id)).toBe("130"); // starts from the verified values

    // While the correction is in progress, version 1 is still the verified one.
    expect((await row(v1)).status).toBe("verified");
    await save(itemId, 145);
    await submit(c.lab_result_id);
    expect((await pgError(() => verify(c.lab_result_id, tech))).message).toMatch(/lab_result_second_person/);
    await verify(c.lab_result_id, reviewer2);

    const v1After = await row(v1);
    expect(v1After).toMatchObject({ status: "superseded", verified_by: reviewer, entered_by: tech });
    expect(v1After.verified_at).toEqual(v1Before.verified_at);
    expect(await valueOf(v1)).toBe("130"); // previous version preserved
    expect(await row(c.lab_result_id)).toMatchObject({ status: "verified", version: 2, verified_by: reviewer2 });
    expect(await valueOf(c.lab_result_id)).toBe("145");
    expect(await itemStatus(itemId)).toBe("verified");

    // A superseded version cannot be corrected; the current one can (version 3).
    expect((await pgError(() => correct(v1, "x"))).message).toMatch(/lab_result_not_current/);
    const v3 = await correct(c.lab_result_id, "Yana bir xato");
    expect((await row(v3.lab_result_id)).version).toBe(3);

    const audit = await sql<{ action: string; actor_id: string; new_values: Record<string, unknown> }[]>`
      select action, actor_id, new_values from public.audit_events
      where entity_type = 'lab_results' and entity_id in ${sql([v1, c.lab_result_id])} order by created_at, id`;
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["lab_result_correction_started", "lab_result_superseded", "lab_result_corrected"]));
    expect(audit.find((a) => a.action === "lab_result_superseded")!.actor_id).toBe(reviewer2);
    expect(idFree(audit)).not.toMatch(/aralashib|145|130/);
  });

  it("a returned correction goes back to its author; a discarded one leaves the verified version as it was", async () => {
    const { id: v1 } = await submitted(130);
    await verify(v1, reviewer);
    const c = await correct(v1, "Tekshirish");
    await submit(c.lab_result_id);
    await giveBack(c.lab_result_id);
    expect((await row(c.lab_result_id)).status).toBe("draft");
    await asServer((tx) => tx`select public.discard_lab_result_draft(${clinic}, ${c.lab_result_id}, ${reviewer})`);
    expect((await row(v1)).status).toBe("verified");
    expect(await valueOf(v1)).toBe("130");
  });

  it("two reviewers verifying at once: one wins", async () => {
    for (let round = 0; round < 4; round++) {
      const { id } = await submitted();
      const results = await Promise.allSettled([verify(id, reviewer), verify(id, reviewer2)]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(String((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.message)).toMatch(/lab_result_not_submitted/);
      expect([reviewer, reviewer2]).toContain((await row(id)).verified_by);
    }
  });

  it("verify and return at once: exactly one final state", async () => {
    for (let round = 0; round < 4; round++) {
      const { id } = await submitted();
      const results = await Promise.allSettled([verify(id, reviewer), giveBack(id, reviewer2)]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const final = (await row(id)).status;
      expect(["verified", "draft"]).toContain(final);
      expect(final === "verified").toBe(results[0].status === "fulfilled");
    }
  });

  it("two people correcting the same result at once: one correction", async () => {
    for (let round = 0; round < 4; round++) {
      const { itemId, id } = await submitted();
      await verify(id, reviewer);
      const results = await Promise.allSettled([correct(id, "A", tech), correct(id, "B", reviewer)]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(String((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.message)).toMatch(/lab_result_correction_exists/);
      expect((await sql`select count(*)::int as n from public.lab_results where order_item_id = ${itemId} and version = 2`)[0].n).toBe(1);
    }
  });

  it("never crosses clinics", async () => {
    const { id } = await submitted();
    expect((await pgError(() => verify(id, outsider, otherClinic))).message).toMatch(/lab_result_not_found/);
    expect((await pgError(() => verify(id, outsider))).message).toMatch(/verified_by must be a staff member/);
    expect((await pgError(() => giveBack(id, outsider, otherClinic))).message).toMatch(/lab_result_not_found/);
    expect((await pgError(() => giveBack(id, outsider))).message).toMatch(/lab_result_not_found/);
    await verify(id);
    expect((await pgError(() => correct(id, "x", outsider, otherClinic))).message).toMatch(/lab_result_not_found/);
    expect((await pgError(() => correct(id, "x", outsider))).message).toMatch(/entered_by must be a staff member/);
    expect((await row(id)).status).toBe("verified");
  });

  it("signed-in roles cannot call the verification functions", async () => {
    for (const fn of ["verify_lab_result(uuid,uuid,uuid)", "return_lab_result(uuid,uuid,uuid)", "start_lab_result_correction(uuid,uuid,uuid,text)"]) {
      for (const role of ["anon", "authenticated"]) {
        const [r] = await sql<{ ok: boolean }[]>`select has_function_privilege(${role}, ${`public.${fn}`}, 'execute') as ok`;
        expect(r.ok, `${role} ${fn}`).toBe(false);
      }
    }
  });
});
