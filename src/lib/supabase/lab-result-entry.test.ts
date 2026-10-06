import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

/**
 * Structured result entry (supabase/migrations/20261005000010):
 * save_lab_result_draft, submit_lab_result, discard_lab_result_draft and
 * lab_entry_ranges at the database — typed values, flags from the configured
 * range only, completeness, ownership of a draft, received samples only,
 * tenancy, concurrency, audit actors.
 */

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

async function probe(): Promise<string | null> {
  const p = postgres(DB_URL, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    const [row] = await p<{ ok: boolean }[]>`select to_regprocedure('public.save_lab_result_draft(uuid,uuid,uuid,jsonb,text,timestamptz)') is not null as ok`;
    return row.ok ? null : "result entry migration not applied";
  } catch (e) {
    return `database unreachable — ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    await p.end({ timeout: 1 });
  }
}

const unavailable = await probe();
if (unavailable) process.stderr.write(`\n⚠️  lab result entry database suite SKIPPED (${unavailable})\n\n`);

async function pgError(run: () => Promise<unknown>): Promise<postgres.PostgresError> {
  try {
    await run();
  } catch (e) {
    if (e instanceof postgres.PostgresError) return e;
    throw e;
  }
  throw new Error("expected the database to reject the statement");
}

type Value = { parameter_id: string; value_numeric?: number | string; value_text?: string; value_boolean?: boolean; clear?: boolean };

describe.skipIf(unavailable !== null)("lab result entry — database", () => {
  let sql: postgres.Sql;
  const suffix = Date.now().toString(36);
  const clinic: string = randomUUID();
  const otherClinic: string = randomUUID();
  const lab1 = randomUUID();
  const lab2 = randomUUID();
  const outsider = randomUUID();
  let test = "";
  const p: Record<"hgb" | "wbc" | "hiv" | "color" | "note" | "old", string> = { hgb: "", wbc: "", hiv: "", color: "", note: "", old: "" };
  let otherTestParam = "";
  let seq = 0;

  const asServer = <T,>(run: (tx: postgres.TransactionSql) => Promise<T>) =>
    sql.begin(async (tx) => {
      await tx.unsafe("set local role service_role");
      return run(tx);
    }) as Promise<T>;

  const save = (itemId: string, values: Value[], opts: { by?: string; clinicId?: string; comment?: string | null } = {}) =>
    asServer(async (tx) => {
      const [row] = await tx<{ lab_result_id: string; created: boolean }[]>`
        select * from public.save_lab_result_draft(${opts.clinicId ?? clinic}, ${itemId}, ${opts.by ?? lab1},
          ${tx.json(values)}::jsonb, ${opts.comment ?? null}, null)`;
      return row;
    });
  const submit = (resultId: string, by = lab1, clinicId = clinic) =>
    asServer(async (tx) => (await tx<{ r: boolean }[]>`select public.submit_lab_result(${clinicId}, ${resultId}, ${by}) as r`)[0].r);
  const discard = (resultId: string, by = lab2, clinicId = clinic) =>
    asServer(async (tx) => (await tx<{ r: boolean }[]>`select public.discard_lab_result_draft(${clinicId}, ${resultId}, ${by}) as r`)[0].r);

  const values = (resultId: string) =>
    sql<{ parameter_id: string; value_numeric: string | null; value_text: string | null; value_boolean: boolean | null; flag: string; unit_snapshot: string | null; range_low: string | null; range_high: string | null }[]>`
      select parameter_id, value_numeric, value_text, value_boolean, flag, unit_snapshot, range_low, range_high
      from public.lab_result_values where result_id = ${resultId}`;
  const itemStatus = async (itemId: string) => (await sql<{ status: string }[]>`select status from public.lab_order_items where id = ${itemId}`)[0].status;
  const resultRow = async (id: string) =>
    (await sql<{ status: string; entered_by: string; submitted_by: string | null; lab_comment: string | null }[]>`
      select status, entered_by, submitted_by, lab_comment from public.lab_results where id = ${id}`)[0];

  const complete = (): Value[] => [
    { parameter_id: p.hgb, value_numeric: 135 },
    { parameter_id: p.wbc, value_numeric: "7.2" },
    { parameter_id: p.hiv, value_boolean: false },
    { parameter_id: p.color, value_text: "Sariq" },
    { parameter_id: p.note, value_text: "Izoh yo‘q" },
  ];

  /** A patient's order for the CBC test, collected and (by default) received by the lab. */
  async function receivedItem(opts: { receive?: boolean; sex?: string | null } = {}) {
    const patient = randomUUID();
    await sql`insert into public.patients ${sql({ id: patient, clinic_id: clinic, full_name: `Entry patient ${suffix} ${seq++}`, date_of_birth: "1990-06-01", sex: opts.sex === undefined ? "female" : opts.sex })}`;
    return asServer(async (tx) => {
      const [o] = await tx<{ lab_order_id: string }[]>`select * from public.create_lab_order(${clinic}, ${patient}, ${lab1}, 'walk_in', ${[test]}::uuid[], '{}'::uuid[])`;
      const [item] = await tx<{ id: string }[]>`select id from public.lab_order_items where order_id = ${o.lab_order_id}`;
      const [s] = await tx<{ lab_sample_id: string }[]>`select * from public.collect_lab_sample(${clinic}, ${o.lab_order_id}, ${[item.id]}::uuid[], ${lab1})`;
      if (opts.receive !== false) await tx`select public.receive_lab_sample(${clinic}, ${s.lab_sample_id}, ${lab2})`;
      return { itemId: item.id, patient, orderId: o.lab_order_id };
    });
  }

  beforeAll(async () => {
    sql = postgres(DB_URL, { max: 8, onnotice: () => {} });
    await sql`insert into public.clinics ${sql([
      { id: clinic, name: `Entry clinic ${suffix}`, slug: `entry-${suffix}`, timezone: "Asia/Tashkent" },
      { id: otherClinic, name: `Entry other ${suffix}`, slug: `entry-other-${suffix}`, timezone: "Asia/Tashkent" },
    ])}`;
    await sql`insert into auth.users ${sql([
      { id: lab1, email: `entry-l1-${suffix}@test.local` },
      { id: lab2, email: `entry-l2-${suffix}@test.local` },
      { id: outsider, email: `entry-out-${suffix}@test.local` },
    ])}`;
    await sql`insert into public.profiles ${sql([{ id: lab1, full_name: "Lab 1" }, { id: lab2, full_name: "Lab 2" }, { id: outsider, full_name: "Other" }])}`;
    await sql`insert into public.staff_roles ${sql([
      { clinic_id: clinic, profile_id: lab1, role: "lab" },
      { clinic_id: clinic, profile_id: lab2, role: "lab" },
      { clinic_id: otherClinic, profile_id: outsider, role: "lab" },
    ])}`;

    const [t] = await sql<{ id: string }[]>`insert into public.lab_tests ${sql({ clinic_id: clinic, code: `CBC${suffix}`, name: `CBC ${suffix}`, sample_type: "Qon", price: 1000 })} returning id`;
    test = t.id;
    const param = async (code: string, extra: Record<string, unknown>, testId = test) =>
      (await sql<{ id: string }[]>`insert into public.lab_test_parameters ${sql({ clinic_id: clinic, test_id: testId, code, name: code, ...extra })} returning id`)[0].id;
    p.hgb = await param("HGB", { value_type: "numeric", unit: "g/L", decimals: 0, sort_order: 1 });
    p.wbc = await param("WBC", { value_type: "numeric", unit: "×10⁹/L", decimals: 1, sort_order: 2 });
    p.hiv = await param("HIV", { value_type: "boolean", sort_order: 3 });
    p.color = await param("COLOR", { value_type: "choice", choices: ["Sariq", "Qizil"], sort_order: 4 });
    p.note = await param("NOTE", { value_type: "text", sort_order: 5 });
    p.old = await param("OLD", { value_type: "numeric", active: false, sort_order: 6 });
    const [t2] = await sql<{ id: string }[]>`insert into public.lab_tests ${sql({ clinic_id: clinic, code: `GLU${suffix}`, name: `GLU ${suffix}`, sample_type: "Qon", price: 1000 })} returning id`;
    otherTestParam = await param("GLU", { value_type: "numeric" }, t2.id);

    // HGB: any sex 120–170, women 120–150, critical below 70 / above 200.
    await sql`insert into public.lab_reference_ranges ${sql([
      { clinic_id: clinic, parameter_id: p.hgb, sex: null, low: 120, high: 170, critical_low: 70, critical_high: 200 },
      { clinic_id: clinic, parameter_id: p.hgb, sex: "female", low: 120, high: 150, critical_low: 70, critical_high: 200 },
    ])}`;
    await sql`insert into public.lab_reference_ranges ${sql({ clinic_id: clinic, parameter_id: p.wbc, low: 4, high: 9 })}`;
    await sql`insert into public.lab_reference_ranges ${sql({ clinic_id: clinic, parameter_id: p.hiv, normal_text: "false" })}`;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from public.clinics where id in ${sql([clinic, otherClinic])}`;
    await sql`delete from auth.users where id in ${sql([lab1, lab2, outsider])}`;
    await sql.end({ timeout: 5 });
  });

  it("enters typed values as a draft; flags come only from the configured range for the patient", async () => {
    const { itemId } = await receivedItem();
    expect(await itemStatus(itemId)).toBe("processing");
    const first = await save(itemId, [
      { parameter_id: p.hgb, value_numeric: 118 },
      { parameter_id: p.wbc, value_numeric: "7.2" },
      { parameter_id: p.hiv, value_boolean: true },
    ], { comment: "  Takroriy o‘lchov  " });
    expect(first.created).toBe(true);
    expect(await resultRow(first.lab_result_id)).toMatchObject({ status: "draft", entered_by: lab1, lab_comment: "Takroriy o‘lchov" });

    const byParam = Object.fromEntries((await values(first.lab_result_id)).map((v) => [v.parameter_id, v]));
    // Women's range (120–150) is chosen over the any-sex range.
    expect(byParam[p.hgb]).toMatchObject({ value_numeric: "118", flag: "low", unit_snapshot: "g/L", range_low: "120", range_high: "150" });
    expect(byParam[p.wbc]).toMatchObject({ value_numeric: "7.2", flag: "normal" });
    expect(byParam[p.hiv]).toMatchObject({ value_boolean: true, flag: "abnormal" });

    // Saving again updates and clears values on the same draft.
    const again = await save(itemId, [{ parameter_id: p.hgb, value_numeric: 60 }, { parameter_id: p.hiv, clear: true }]);
    expect(again).toEqual({ lab_result_id: first.lab_result_id, created: false });
    const now = Object.fromEntries((await values(first.lab_result_id)).map((v) => [v.parameter_id, v]));
    expect(now[p.hgb].flag).toBe("critical_low");
    expect(now[p.hiv]).toBeUndefined();
    expect(await itemStatus(itemId)).toBe("processing");
  });

  it("uses the any-sex range when the patient's sex is unknown, and previews the same range", async () => {
    const { itemId } = await receivedItem({ sex: null });
    const preview = await asServer((tx) => tx<{ parameter_id: string; range_low: string | null; range_high: string | null }[]>`
      select * from public.lab_entry_ranges(${clinic}, ${itemId})`);
    expect(preview.find((r) => r.parameter_id === p.hgb)).toMatchObject({ range_low: "120", range_high: "170" });
    expect(preview.find((r) => r.parameter_id === p.note)).toMatchObject({ range_low: null, range_high: null });
    const { lab_result_id } = await save(itemId, [{ parameter_id: p.hgb, value_numeric: 160 }]);
    expect((await values(lab_result_id))[0]).toMatchObject({ flag: "normal", range_high: "170" });
  });

  it("validates values server-side: type, configured choices, decimals, parameter of this test", async () => {
    const { itemId } = await receivedItem();
    const cases: Array<[Value[], RegExp]> = [
      [[{ parameter_id: p.hgb, value_text: "baland" }], /HGB expects a numeric value/],
      [[{ parameter_id: p.hgb, value_numeric: "abc" }], /invalid input syntax for type numeric/],
      [[{ parameter_id: p.color, value_text: "Ko‘k" }], /not one of the configured choices/],
      [[{ parameter_id: p.hgb, value_numeric: 118.5 }], /HGB takes at most 0 decimal places/],
      [[{ parameter_id: p.wbc, value_numeric: 7.25 }], /WBC takes at most 1 decimal places/],
      [[{ parameter_id: p.hiv, value_text: "yo‘q" }], /HIV expects a boolean value/],
      [[{ parameter_id: otherTestParam, value_numeric: 5 }], /lab_result_bad_values: a parameter does not belong to this test/],
      [[{ parameter_id: p.hgb, value_numeric: 1 }, { parameter_id: p.hgb, value_numeric: 2 }], /given twice/],
      [[{ parameter_id: "nope" } as Value], /unknown parameter/],
      [[{ parameter_id: p.old, value_numeric: 1 }], /OLD is inactive/],
    ];
    for (const [vals, message] of cases) {
      expect((await pgError(() => save(itemId, vals))).message).toMatch(message);
    }
    // Nothing was created by the refused saves.
    expect((await sql`select count(*)::int as n from public.lab_results where order_item_id = ${itemId}`)[0].n).toBe(0);
  });

  it("submits only a complete draft, only by its author; then the result is no longer editable", async () => {
    const { itemId } = await receivedItem();
    const { lab_result_id: id } = await save(itemId, [{ parameter_id: p.hgb, value_numeric: 135 }]);
    expect((await pgError(() => submit(id))).message).toMatch(/lab_result_incomplete: 4 parameter/);
    await save(itemId, complete());
    expect((await pgError(() => submit(id, lab2))).message).toMatch(/lab_result_draft_owned/);

    expect(await submit(id)).toBe(true);
    expect(await submit(id)).toBe(false); // repeat: nothing to do
    expect(await resultRow(id)).toMatchObject({ status: "submitted", submitted_by: lab1 });
    expect(await itemStatus(itemId)).toBe("resulted");

    expect((await pgError(() => save(itemId, [{ parameter_id: p.hgb, value_numeric: 140 }]))).message).toMatch(/lab_result_submitted/);
    expect((await pgError(() => discard(id))).message).toMatch(/only a draft can be discarded/);
    // Direct writes to a submitted result's values are refused too.
    expect((await pgError(() => asServer((tx) => tx`update public.lab_result_values set value_numeric = 140 where result_id = ${id} and parameter_id = ${p.hgb}`))).message)
      .toMatch(/only a draft result accepts values/);

    // Once verified (Phase 9 does this through its own function), a save is a correction, not an edit.
    await sql`update public.lab_results set status = 'verified', verified_by = ${lab2} where id = ${id}`;
    expect((await pgError(() => save(itemId, [{ parameter_id: p.hgb, value_numeric: 140 }]))).message).toMatch(/lab_result_verified/);
  });

  it("only the author changes a draft; a colleague may discard it (audited) and start their own", async () => {
    const { itemId } = await receivedItem();
    const { lab_result_id: id } = await save(itemId, [{ parameter_id: p.hgb, value_numeric: 135 }]);
    expect((await pgError(() => save(itemId, [{ parameter_id: p.hgb, value_numeric: 999 }], { by: lab2 }))).message).toMatch(/lab_result_draft_owned/);
    expect((await values(id))[0].value_numeric).toBe("135");

    expect(await discard(id, lab2)).toBe(true);
    expect((await pgError(() => discard(id, lab2))).message).toMatch(/already discarded/);
    expect(await itemStatus(itemId)).toBe("processing");
    const [audit] = await sql<{ actor_id: string; new_values: Record<string, unknown> }[]>`
      select actor_id, new_values from public.audit_events where entity_id = ${id} and action = 'lab_result_draft_discarded'`;
    expect(audit.actor_id).toBe(lab2);
    expect(JSON.stringify(audit.new_values)).not.toContain("135");

    const mine = await save(itemId, [{ parameter_id: p.hgb, value_numeric: 140 }], { by: lab2 });
    expect(mine.created).toBe(true);
    expect((await resultRow(mine.lab_result_id)).entered_by).toBe(lab2);
  });

  it("enters results only once the lab has received the sample", async () => {
    const collectedOnly = await receivedItem({ receive: false });
    expect(await itemStatus(collectedOnly.itemId)).toBe("collected");
    expect((await pgError(() => save(collectedOnly.itemId, [{ parameter_id: p.hgb, value_numeric: 130 }]))).message).toMatch(/lab_result_item_not_ready/);
  });

  it("never crosses clinics", async () => {
    const { itemId } = await receivedItem();
    expect((await pgError(() => save(itemId, [{ parameter_id: p.hgb, value_numeric: 130 }], { clinicId: otherClinic, by: outsider }))).message).toMatch(/lab_result_unknown_item/);
    expect((await pgError(() => save(itemId, [{ parameter_id: p.hgb, value_numeric: 130 }], { by: outsider }))).message).toMatch(/entered_by must be a staff member/);
    const { lab_result_id: id } = await save(itemId, complete());
    expect((await pgError(() => submit(id, outsider, otherClinic))).message).toMatch(/lab_result_not_found/);
    expect((await pgError(() => discard(id, outsider, otherClinic))).message).toMatch(/lab_result_not_found/);
    expect((await pgError(() => discard(id, outsider, clinic))).message).toMatch(/lab_result_not_found/);
    expect((await resultRow(id)).status).toBe("draft");
  });

  it("two staff starting the same result at once: one draft, the other is told it is taken", async () => {
    for (let round = 0; round < 4; round++) {
      const { itemId } = await receivedItem();
      const results = await Promise.allSettled([
        save(itemId, [{ parameter_id: p.hgb, value_numeric: 130 }], { by: lab1 }),
        save(itemId, [{ parameter_id: p.hgb, value_numeric: 131 }], { by: lab2 }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(String(rejected.reason.message)).toMatch(/lab_result_draft_owned/);
      expect((await sql`select count(*)::int as n from public.lab_results where order_item_id = ${itemId}`)[0].n).toBe(1);
    }
  });

  it("audits entry and submission with ids only and the right actors", async () => {
    const { itemId } = await receivedItem();
    const { lab_result_id: id } = await save(itemId, complete(), { comment: "Maxfiy izoh" });
    await submit(id);
    const audit = await sql<{ action: string; actor_id: string; new_values: Record<string, unknown> }[]>`
      select action, actor_id, new_values from public.audit_events where entity_id = ${id} order by created_at, id`;
    expect(audit.map((a) => [a.action, a.actor_id])).toEqual([
      ["lab_result_entered", lab1],
      ["lab_result_submitted", lab1],
    ]);
    const text = JSON.stringify(audit);
    for (const secret of ["Maxfiy", "135", "7.2", "Sariq"]) expect(text).not.toContain(secret);
  });

  it("signed-in roles cannot call the entry functions", async () => {
    for (const fn of [
      "save_lab_result_draft(uuid,uuid,uuid,jsonb,text,timestamptz)",
      "submit_lab_result(uuid,uuid,uuid)",
      "discard_lab_result_draft(uuid,uuid,uuid)",
      "lab_entry_ranges(uuid,uuid)",
      "lab_applicable_range(uuid,patient_sex,integer)",
      "lab_current_actor()",
    ]) {
      for (const role of ["anon", "authenticated"]) {
        const [row] = await sql<{ ok: boolean }[]>`select has_function_privilege(${role}, ${`public.${fn}`}, 'execute') as ok`;
        expect(row.ok, `${role} ${fn}`).toBe(false);
      }
    }
  });
});
