import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import postgres from "postgres";
import { cleanupTestClinics } from "@/test/cleanup-clinics";
import { localDbAvailable } from "@/test/local-db";

/**
 * Laboratory result entry, verification and correction (phase 6) through the REAL routes, guards and database:
 * results entered against the configured parameters, the database-computed flag against the configured range, the
 * submit → verify workflow with the clinic's settings (verification on/off, a separate verifier), append-only
 * versions with a correction that keeps the original author and the old version, and the races (two verifiers,
 * two simultaneous corrections, a stale correction).
 *
 * Mocked: only the staff session lookup (getStaffContext).
 */

const session = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/staff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/staff")>();
  return { ...actual, getStaffContext: async () => session.ctx };
});

import * as resultList from "@/app/api/lab/results/route";
import * as resultItem from "@/app/api/lab/results/[itemId]/route";
import * as resultCorrection from "@/app/api/lab/results/[itemId]/correction/route";
import * as resultVersion from "@/app/api/lab/results/versions/[versionId]/route";

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const describeDb = describe.skipIf(!localDbAvailable());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = { ok: boolean; data?: Record<string, any>; code?: string; error?: string };
type Role = "owner" | "admin" | "manager" | "receptionist" | "lab_staff" | "doctor";

describeDb("laboratory results — real routes and database", () => {
  let sql: postgres.Sql;
  const suffix = Date.now().toString(36) + Math.floor(Math.random() * 1e4);
  const clinicA = randomUUID();
  const clinicB = randomUUID();
  const users: Record<string, string> = Object.fromEntries(["owner", "admin", "mgr", "rec", "lab1", "lab2", "lab3", "doc", "labB"].map((k) => [k, randomUUID()]));
  const doc = randomUUID();
  const svc = randomUUID();
  const patient = randomUUID();
  const T: Record<string, string> = {};
  const P: Record<string, string> = {};
  let consult = "";
  const NOTE = `Doctor's note ${suffix}`;
  const REASON = `Wrong decimal entered ${suffix}`;

  const as = (user: string, role: Role, clinic = clinicA) => {
    session.ctx = { profileId: users[user], clinicId: clinic, clinicName: "Lab", clinicTimezone: "Asia/Tashkent", roles: [role], platformAdmin: false };
  };
  const read = async (res: Response): Promise<{ status: number; body: Json }> => ({ status: res.status, body: (await res.json()) as Json });
  const req = (method: string, path: string, body?: unknown) =>
    new NextRequest(`http://localhost${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const ctx = <K extends string>(key: K, id: string) => ({ params: Promise.resolve({ [key]: id } as Record<K, string>) });

  const list = async (filter = "all") => read(await resultList.GET(req("GET", `/api/lab/results?filter=${filter}`)));
  const detail = async (itemId: string) => read(await resultItem.GET(req("GET", `/api/lab/results/${itemId}`), ctx("itemId", itemId)));
  const save = async (itemId: string, body: unknown) => read(await resultItem.PUT(req("PUT", `/api/lab/results/${itemId}`, body), ctx("itemId", itemId)));
  const move = async (versionId: string, action: string) => read(await resultVersion.POST(req("POST", `/api/lab/results/versions/${versionId}`, { action }), ctx("versionId", versionId)));
  const correct = async (itemId: string, body: unknown) => read(await resultCorrection.POST(req("POST", `/api/lab/results/${itemId}/correction`, body), ctx("itemId", itemId)));

  const setPolicy = async (verification: unknown) => {
    await sql`delete from public.app_settings where clinic_id = ${clinicA} and key = 'lab'`;
    if (verification !== undefined)
      await sql`insert into public.app_settings (clinic_id, key, value) values (${clinicA}, 'lab', ${sql.json({ verification, collection: { requiresPayment: false }, ordering: { recentTestWindowDays: 30 } } as never)})`;
  };

  /** What the database says to a signed-in token running a statement: its error code, or "ok". */
  const tokenResult = async (sub: string, run: (tx: postgres.TransactionSql) => Promise<unknown>) => {
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("set local role authenticated");
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub, role: "authenticated" })}, true)`;
        await run(tx);
      });
      return "ok";
    } catch (e) {
      return (e as postgres.PostgresError).code ?? String(e);
    }
  };

  /** An order with the CBC (and optionally the glucose test) whose samples are collected: results can be entered. */
  async function collectedOrder(tests: string[] = [T.cbc]) {
    const [row] = await sql<{ r: { order_id: string } }[]>`
      select public.lab_create_order(${clinicA}, ${users.doc}, ${patient}, ${doc}, ${consult}, null, 'routine', ${NOTE}, ${randomUUID()}, ${sql.json(tests.map((test_id) => ({ test_id })))}) as r`;
    const orderId = row.r.order_id;
    await sql`select public.lab_create_samples(${clinicA}, ${users.lab1}, ${orderId})`;
    const samples = await sql<{ id: string }[]>`select id from public.lab_samples where order_id = ${orderId}`;
    for (const s of samples) await sql`select public.lab_sample_transition(${clinicA}, ${users.lab1}, ${s.id}, 'collected', null)`;
    const items = await sql<{ id: string; test_id: string }[]>`select id, test_id from public.lab_order_items where order_id = ${orderId}`;
    return { orderId, item: (t: string) => items.find((i) => i.test_id === t)!.id };
  }
  const fullCbc = (hgb: number | string = 130, extra: Record<string, unknown> = {}) => ({
    values: [
      { parameterId: P.hgb, value: hgb },
      { parameterId: P.wbc, value: 7.2 },
      { parameterId: P.kind, value: "negative" },
      { parameterId: P.remark, value: "clear" },
      { parameterId: P.plt, value: 220 },
      { parameterId: P.age, value: 5 },
    ],
    ...extra,
  });
  /** Entered (as lab1), submitted and — with a second person — verified. */
  async function verifiedResult(hgb = 130) {
    const o = await collectedOrder();
    const itemId = o.item(T.cbc);
    as("lab1", "lab_staff");
    const saved = await save(itemId, fullCbc(hgb));
    expect(saved.status).toBe(200);
    expect((await move(saved.body.data!.versionId, "submit")).status).toBe(200);
    as("lab2", "lab_staff");
    expect((await move(saved.body.data!.versionId, "verify")).status).toBe(200);
    return { ...o, itemId, versionId: saved.body.data!.versionId as string };
  }
  const versionsOf = (itemId: string) =>
    sql<{ id: string; version: number; status: string; entered_by: string; verified_by: string | null; corrects_version_id: string | null }[]>`
      select v.id, v.version, v.status, v.entered_by, v.verified_by, v.corrects_version_id from public.lab_result_versions v
        join public.lab_results r on r.id = v.result_id where r.order_item_id = ${itemId} order by v.version`;

  beforeAll(async () => {
    sql = postgres(DB_URL, { max: 12, onnotice: () => {} });
    await sql`insert into public.clinics ${sql([
      { id: clinicA, name: `Lab Results A ${suffix}`, slug: `lab-res-a-${suffix}`, timezone: "Asia/Tashkent" },
      { id: clinicB, name: `Lab Results B ${suffix}`, slug: `lab-res-b-${suffix}`, timezone: "Asia/Tashkent" },
    ])}`;
    const rows = Object.entries(users).map(([k, id]) => ({ id, email: `labres-${k}-${suffix}@test.local` }));
    await sql`insert into auth.users ${sql(rows)}`;
    await sql`insert into public.profiles ${sql(rows.map((x) => ({ id: x.id, full_name: `Person ${x.email.split("-")[1]}` })))}`;
    await sql`insert into public.staff_roles ${sql([
      { clinic_id: clinicA, profile_id: users.owner, role: "owner" },
      { clinic_id: clinicA, profile_id: users.admin, role: "admin" },
      { clinic_id: clinicA, profile_id: users.mgr, role: "manager" },
      { clinic_id: clinicA, profile_id: users.rec, role: "receptionist" },
      { clinic_id: clinicA, profile_id: users.lab1, role: "lab_staff" },
      { clinic_id: clinicA, profile_id: users.lab2, role: "lab_staff" },
      { clinic_id: clinicA, profile_id: users.lab3, role: "lab_staff" },
      { clinic_id: clinicA, profile_id: users.doc, role: "doctor" },
      { clinic_id: clinicB, profile_id: users.labB, role: "lab_staff" },
    ])}`;
    await sql`insert into public.doctors (id, clinic_id, profile_id, name, active) values (${doc}, ${clinicA}, ${users.doc}, ${`Dr Results ${suffix}`}, true)`;
    await sql`insert into public.services (id, clinic_id, name, duration_minutes, price) values (${svc}, ${clinicA}, ${`Results ${suffix}`}, 30, 1000)`;
    await sql`insert into public.doctor_working_hours ${sql([1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinic_id: clinicA, doctor_id: doc, weekday, start_time: "00:00", end_time: "23:59" })))}`;
    await sql`insert into public.patients (id, clinic_id, full_name) values (${patient}, ${clinicA}, ${`Results patient ${suffix}`})`;
    const start = new Date(Date.UTC(2034, 2, 1, 5, 0));
    [{ id: consult }] = await sql<{ id: string }[]>`insert into public.appointments ${sql({
      clinic_id: clinicA, patient_id: patient, doctor_id: doc, service_id: svc, start_at: start,
      end_at: new Date(start.getTime() + 30 * 60_000), status: "in_progress", source: "walk_in",
    })} returning id`;

    const ins = async (table: string, row: Record<string, unknown>) => (await sql<{ id: string }[]>`insert into ${sql(`public.${table}`)} ${sql(row as never)} returning id`)[0].id;
    T.cbc = await ins("lab_tests", { clinic_id: clinicA, code: `CBC-${suffix}`, name: "Complete blood count", price: 85000, sample_type: "blood" });
    T.glu = await ins("lab_tests", { clinic_id: clinicA, code: `GLU-${suffix}`, name: "Glucose", price: 25000, sample_type: "blood" });
    const param = (test: string, code: string, extra: Record<string, unknown>) => ins("lab_test_parameters", { clinic_id: clinicA, test_id: test, code, name: code, ...extra });
    P.hgb = await param(T.cbc, "HGB", { unit: "g/L", data_type: "numeric", display_order: 1 });
    P.wbc = await param(T.cbc, "WBC", { unit: "10^9/L", data_type: "numeric", display_order: 2 });
    P.kind = await param(T.cbc, "KIND", { data_type: "choice", choices: ["positive", "negative"], display_order: 3 });
    P.remark = await param(T.cbc, "REMARK", { data_type: "text", display_order: 4 });
    P.plt = await param(T.cbc, "PLT", { unit: "10^9/L", data_type: "numeric", display_order: 5 }); // two generic ranges: ambiguous
    P.age = await param(T.cbc, "AGEONLY", { unit: "x", data_type: "numeric", display_order: 6 }); // only an age-specific range
    P.gluc = await param(T.glu, "GLUC", { unit: "mmol/L", data_type: "numeric" });
    const range = (parameter: string, row: Record<string, unknown>) => ins("lab_reference_ranges", { clinic_id: clinicA, parameter_id: parameter, ...row });
    P.hgbRange = await range(P.hgb, { low: 120, high: 160, critical_low: 70, critical_high: 200 });
    await range(P.wbc, { low: 4, high: 10 });
    await range(P.wbc, { low: 6, high: 18, age_min_years: 0, age_max_years: 1 });
    await range(P.plt, { low: 150, high: 400 });
    await range(P.plt, { low: 100, high: 300 });
    await range(P.age, { low: 1, high: 2, age_min_years: 0, age_max_years: 5 });
    await range(P.gluc, { low: 3.9, high: 5.6 });
  });

  afterAll(async () => {
    if (!sql) return;
    await cleanupTestClinics([clinicA, clinicB]);
    await sql`delete from auth.users where id in ${sql(Object.values(users))}`;
    await sql.end({ timeout: 5 });
  });

  // ------------------------------------------------------------------ who

  it("results are for laboratory staff only: management, reception and doctors have no route — and another clinic's staff finds nothing", async () => {
    const { itemId, versionId } = await verifiedResult();
    for (const [user, role] of [["owner", "owner"], ["admin", "admin"], ["mgr", "manager"], ["rec", "receptionist"], ["doc", "doctor"]] as const) {
      as(user, role);
      expect((await list()).status, `${role} list`).toBe(403);
      expect((await detail(itemId)).status, `${role} detail`).toBe(403);
      expect((await save(itemId, fullCbc())).status, `${role} save`).toBe(403);
      expect((await move(versionId, "verify")).status, `${role} verify`).toBe(403);
      expect((await correct(itemId, { expectedVersion: 1, reason: REASON })).status, `${role} correct`).toBe(403);
    }
    session.ctx = null;
    expect((await list()).status).toBe(401);
    expect((await save(itemId, fullCbc())).status).toBe(401);
    as("labB", "lab_staff", clinicB);
    expect((await detail(itemId)).status).toBe(404);
    expect((await save(itemId, fullCbc())).status).toBe(404);
    expect((await move(versionId, "return")).status).toBe(404);
    expect((await correct(itemId, { expectedVersion: 1, reason: REASON })).status).toBe(404);
    expect((await detail("not-a-uuid")).status).toBe(404);
    expect((await detail(randomUUID())).status).toBe(404);
    expect((await list()).body.data!.items).toHaveLength(0);
    // The result tables are closed to every signed-in token as well (a doctor reading them directly gets nothing).
    const err = await tokenResult(users.doc, (tx) => tx`select * from public.lab_result_values`);
    expect(err).toBe("42501");
  });

  // ------------------------------------------------------------------ entry and flags

  it("a result can be entered only once the sample was collected", async () => {
    const [row] = await sql<{ r: { order_id: string } }[]>`select public.lab_create_order(${clinicA}, ${users.doc}, ${patient}, ${doc}, ${consult}, null, 'routine', null, ${randomUUID()}, ${sql.json([{ test_id: T.cbc }])}) as r`;
    const [item] = await sql<{ id: string }[]>`select id from public.lab_order_items where order_id = ${row.r.order_id}`;
    as("lab1", "lab_staff");
    expect(await save(item.id, fullCbc())).toMatchObject({ status: 409, body: { code: "sample_not_collected" } });
    await sql`select public.lab_create_samples(${clinicA}, ${users.lab1}, ${row.r.order_id})`;
    expect((await save(item.id, fullCbc())).body.code).toBe("sample_not_collected"); // prepared is not collected
    expect(await sql`select 1 from public.lab_results where order_item_id = ${item.id}`).toHaveLength(0);
    const [sample] = await sql<{ id: string }[]>`select id from public.lab_samples where order_id = ${row.r.order_id}`;
    await sql`select public.lab_sample_transition(${clinicA}, ${users.lab1}, ${sample.id}, 'collected', null)`;
    expect((await save(item.id, fullCbc())).status).toBe(200);
  });

  it("values are checked against the configured parameters of the test and the flag comes from the configured range — set by the database", async () => {
    const { item } = await collectedOrder();
    const itemId = item(T.cbc);
    as("lab1", "lab_staff");
    const res = await save(itemId, fullCbc("118,5"));
    expect(res.status).toBe(200);
    const d = (await detail(itemId)).body.data!.detail;
    const byCode = Object.fromEntries(d.working.values.map((v: { code: string }) => [v.code, v]));
    expect(byCode.HGB).toMatchObject({ value: 118.5, flag: "low", refLow: 120, refHigh: 160, criticalLow: 70, criticalHigh: 200, unit: "g/L" });
    expect(byCode.WBC).toMatchObject({ value: 7.2, flag: "normal", refLow: 4, refHigh: 10 }); // the GENERIC range, not the age-specific one
    expect(byCode.KIND).toMatchObject({ value: "negative", flag: "unclassified" });
    expect(byCode.REMARK).toMatchObject({ value: "clear" });
    // Several generic ranges, or only age-specific ones: no guess — no range, unclassified.
    expect(byCode.PLT).toMatchObject({ flag: "unclassified", refLow: null, refHigh: null });
    expect(byCode.AGEONLY).toMatchObject({ flag: "unclassified", refLow: null });
    // The detail tells the screen which range applies (or that none does) while typing.
    expect(d.parameters.find((p: { code: string }) => p.code === "HGB").range).toEqual({ low: 120, high: 160, criticalLow: 70, criticalHigh: 200 });
    expect(d.parameters.find((p: { code: string }) => p.code === "PLT").range).toBeNull();

    // Every class of flag.
    for (const [value, flag] of [[130, "normal"], [119.99, "low"], [160.01, "high"], [65, "critical_low"], [201, "critical_high"], [120, "normal"], [160, "normal"]] as const) {
      await save(itemId, fullCbc(value));
      const w = (await detail(itemId)).body.data!.detail.working.values.find((v: { code: string }) => v.code === "HGB");
      expect(w.flag, String(value)).toBe(flag);
    }
    // The stored bounds are a snapshot: editing the configured range later never re-flags a stored result.
    await sql`update public.lab_reference_ranges set low = 100 where id = ${P.hgbRange}`;
    try {
      await save(itemId, fullCbc(110));
      expect((await detail(itemId)).body.data!.detail.working.values.find((v: { code: string }) => v.code === "HGB")).toMatchObject({ flag: "normal", refLow: 100 });
      await sql`update public.lab_reference_ranges set low = 120 where id = ${P.hgbRange}`;
      expect((await detail(itemId)).body.data!.detail.working.values.find((v: { code: string }) => v.code === "HGB")).toMatchObject({ flag: "normal", refLow: 100 });
    } finally {
      await sql`update public.lab_reference_ranges set low = 120 where id = ${P.hgbRange}`;
    }
    // Saving again replaces the draft's values (one value per parameter, one draft).
    expect((await sql<{ n: number }[]>`select count(*)::int as n from public.lab_result_values x join public.lab_result_versions v on v.id = x.version_id join public.lab_results r on r.id = v.result_id where r.order_item_id = ${itemId}`)[0].n).toBe(6);
    expect(await versionsOf(itemId)).toHaveLength(1);
  });

  it("what is typed is refused when it does not fit the parameter; nothing about flags, ranges, status or author can be sent", async () => {
    const { item } = await collectedOrder();
    const itemId = item(T.cbc);
    as("lab1", "lab_staff");
    const ok = fullCbc();
    const withValue = (parameterId: string, value: unknown) => ({ values: [...ok.values.filter((v) => v.parameterId !== parameterId), { parameterId, value }] });
    expect((await save(itemId, withValue(P.hgb, "abc"))).status).toBe(400);
    expect((await save(itemId, withValue(P.hgb, "12 3"))).status).toBe(400);
    expect((await save(itemId, withValue(P.kind, "maybe"))).status, "not one of the configured choices").toBe(400);
    expect((await save(itemId, withValue(P.remark, 5))).status, "text parameter, number typed").toBe(400);
    expect((await save(itemId, withValue(P.hgb, ""))).status).toBe(400);
    expect((await save(itemId, withValue(randomUUID(), 5))).status, "unknown parameter").toBe(400);
    expect((await save(itemId, withValue(P.gluc, 5))).status, "another test's parameter").toBe(400);
    expect((await save(itemId, { values: [{ parameterId: P.hgb, value: 1 }, { parameterId: P.hgb, value: 2 }] })).status, "the same parameter twice").toBe(400);
    expect((await save(itemId, { values: [] })).status).toBe(400);
    expect((await save(itemId, {})).status).toBe(400);
    for (const extra of [{ flag: "normal" }, { status: "verified" }, { enteredBy: users.lab2 }, { clinicId: clinicB }, { refLow: 0 }, { range: 1 }]) {
      expect((await save(itemId, { values: [{ parameterId: P.hgb, value: 1, ...extra }] })).status, JSON.stringify(extra)).toBe(400);
      expect((await save(itemId, { ...ok, ...extra })).status, JSON.stringify(extra)).toBe(400);
    }
    expect(await versionsOf(itemId)).toHaveLength(0);
  });

  it("a draft belongs to its author: nobody else edits or submits it; an incomplete result is not submitted", async () => {
    const { item } = await collectedOrder();
    const itemId = item(T.cbc);
    as("lab1", "lab_staff");
    const first = await save(itemId, { values: [{ parameterId: P.hgb, value: 130 }] });
    expect(first.status).toBe(200);
    expect(await move(first.body.data!.versionId, "submit")).toMatchObject({ status: 400, body: { code: "incomplete" } });
    as("lab2", "lab_staff");
    expect(await save(itemId, fullCbc())).toMatchObject({ status: 403, body: { code: "not_author" } });
    expect(await move(first.body.data!.versionId, "submit")).toMatchObject({ status: 403, body: { code: "not_author" } });
    as("lab1", "lab_staff");
    expect((await save(itemId, fullCbc())).status).toBe(200);
    expect((await move(first.body.data!.versionId, "submit")).body.data).toMatchObject({ status: "pending_verification", unchanged: false });
    expect((await move(first.body.data!.versionId, "submit")).body.data).toMatchObject({ unchanged: true });
    // Awaiting verification, a draft is not edited.
    expect(await save(itemId, fullCbc(140))).toMatchObject({ status: 409, body: { code: "awaiting_verification" } });
    expect((await versionsOf(itemId))[0]).toMatchObject({ status: "pending_verification", entered_by: users.lab1 });
  });

  // ------------------------------------------------------------------ verification

  it("verification: by default the clinic requires it; the order completes only when every test is verified; repeats are harmless and a second verifier is refused", async () => {
    await setPolicy(undefined);
    const { orderId, item } = await collectedOrder([T.cbc, T.glu]);
    as("lab1", "lab_staff");
    const a = await save(item(T.cbc), fullCbc());
    const b = await save(item(T.glu), { values: [{ parameterId: P.gluc, value: 5.1 }] });
    await move(a.body.data!.versionId, "submit");
    await move(b.body.data!.versionId, "submit");
    // Not final until verified: the header says so.
    expect((await sql<{ status: string }[]>`select status from public.lab_results where order_item_id = ${item(T.cbc)}`)[0].status).toBe("pending_verification");
    as("lab2", "lab_staff");
    expect((await move(a.body.data!.versionId, "verify")).body.data).toMatchObject({ status: "verified", unchanged: false });
    expect((await sql<{ status: string }[]>`select status from public.lab_orders where id = ${orderId}`)[0].status).toBe("in_progress");
    expect((await move(a.body.data!.versionId, "verify")).body.data).toMatchObject({ unchanged: true });
    as("lab3", "lab_staff");
    expect(await move(a.body.data!.versionId, "verify")).toMatchObject({ status: 409, body: { code: "already_verified" } });
    expect((await move(a.body.data!.versionId, "return")).status, "a verified version cannot be returned").toBe(409);
    expect((await move(b.body.data!.versionId, "verify")).status).toBe(200);
    expect((await sql<{ status: string }[]>`select status from public.lab_orders where id = ${orderId}`)[0].status).toBe("completed");
    const [v] = await versionsOf(item(T.cbc));
    expect(v).toMatchObject({ status: "verified", entered_by: users.lab1, verified_by: users.lab2 });
    // A verified result is not edited: a change is a correction.
    as("lab1", "lab_staff");
    expect(await save(item(T.cbc), fullCbc(150))).toMatchObject({ status: 409, body: { code: "already_verified" } });
  });

  it("a clinic can require a SEPARATE verifier: the person who entered a result cannot verify it, someone else can", async () => {
    await setPolicy({ required: true, separateVerifier: true });
    try {
      const { item } = await collectedOrder();
      as("lab1", "lab_staff");
      const saved = await save(item(T.cbc), fullCbc());
      await move(saved.body.data!.versionId, "submit");
      expect(await move(saved.body.data!.versionId, "verify")).toMatchObject({ status: 403, body: { code: "separate_verifier_required" } });
      expect((await versionsOf(item(T.cbc)))[0].status).toBe("pending_verification");
      const d = (await detail(item(T.cbc))).body.data!.detail;
      expect(d.working).toMatchObject({ canVerify: false, canReturn: true, mine: true });
      as("lab2", "lab_staff");
      expect((await detail(item(T.cbc))).body.data!.detail.working.canVerify).toBe(true);
      expect((await move(saved.body.data!.versionId, "verify")).status).toBe(200);
    } finally {
      await setPolicy(undefined);
    }
  });

  it("without the separate-verifier setting the same person may verify (allowed and recorded: who entered and who verified)", async () => {
    await setPolicy({ required: true, separateVerifier: false });
    const { item } = await collectedOrder();
    as("lab1", "lab_staff");
    const saved = await save(item(T.cbc), fullCbc());
    await move(saved.body.data!.versionId, "submit");
    expect((await move(saved.body.data!.versionId, "verify")).status).toBe(200);
    expect((await versionsOf(item(T.cbc)))[0]).toMatchObject({ entered_by: users.lab1, verified_by: users.lab1 });
    await setPolicy(undefined);
  });

  it("a clinic that does not require verification: submitting finalises the result, still recording who and when", async () => {
    await setPolicy({ required: false, separateVerifier: false });
    try {
      const { item } = await collectedOrder();
      as("lab1", "lab_staff");
      const saved = await save(item(T.cbc), fullCbc());
      expect((await move(saved.body.data!.versionId, "submit")).body.data).toMatchObject({ status: "verified" });
      const [v] = await sql<{ status: string; verified_by: string; verified_at: string }[]>`select status, verified_by, verified_at from public.lab_result_versions where id = ${saved.body.data!.versionId}`;
      expect(v).toMatchObject({ status: "verified", verified_by: users.lab1 });
      expect(v.verified_at).toBeTruthy();
      expect(await sql`select 1 from public.audit_events where action = 'lab_result_verified' and entity_id = ${saved.body.data!.versionId}`).toHaveLength(1);
    } finally {
      await setPolicy(undefined);
    }
    // A damaged setting is never read as "no verification needed".
    for (const broken of [{ required: "no" }, "text", { separateVerifier: 1 }]) {
      await setPolicy(broken);
      const { item } = await collectedOrder();
      as("lab1", "lab_staff");
      const saved = await save(item(T.cbc), fullCbc());
      expect((await move(saved.body.data!.versionId, "submit")).body.data, JSON.stringify(broken)).toMatchObject({ status: "pending_verification" });
    }
    await setPolicy(undefined);
  });

  it("returned to draft: any laboratory member can send a submitted result back; then only its author edits it again", async () => {
    const { item } = await collectedOrder();
    as("lab1", "lab_staff");
    const saved = await save(item(T.cbc), fullCbc());
    expect((await move(saved.body.data!.versionId, "return")).body.data, "a draft is already a draft").toMatchObject({ unchanged: true });
    await move(saved.body.data!.versionId, "submit");
    as("lab2", "lab_staff");
    expect((await move(saved.body.data!.versionId, "return")).body.data).toMatchObject({ status: "draft", unchanged: false });
    expect(await save(item(T.cbc), fullCbc(133))).toMatchObject({ status: 403, body: { code: "not_author" } });
    as("lab1", "lab_staff");
    expect((await save(item(T.cbc), fullCbc(133))).status).toBe(200);
    expect(await versionsOf(item(T.cbc))).toHaveLength(1);
  });

  it("two people verifying at the same moment end in exactly one verification", async () => {
    for (let i = 0; i < 4; i++) {
      const { item } = await collectedOrder();
      as("lab1", "lab_staff");
      const saved = await save(item(T.cbc), fullCbc());
      await move(saved.body.data!.versionId, "submit");
      const verifyAs = (user: string) => {
        as(user, "lab_staff");
        return move(saved.body.data!.versionId, "verify");
      };
      const [a, b] = await Promise.all([verifyAs("lab2"), verifyAs("lab3")]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect([a, b].find((r) => r.status === 409)!.body.code).toBe("already_verified");
      const [v] = await versionsOf(item(T.cbc));
      expect(v.status).toBe("verified");
      expect([users.lab2, users.lab3]).toContain(v.verified_by);
      expect(await sql`select 1 from public.audit_events where action = 'lab_result_verified' and entity_id = ${v.id}`).toHaveLength(1);
    }
  });

  // ------------------------------------------------------------------ corrections

  it("a correction is a NEW version: the old one stays verified and intact, the author of each version is kept, and the old one is superseded only when the new one is verified", async () => {
    const { itemId, versionId } = await verifiedResult(130);
    as("lab3", "lab_staff");
    expect(await correct(itemId, { expectedVersion: 1 })).toMatchObject({ status: 400 });
    expect(await correct(itemId, { expectedVersion: 1, reason: "x" })).toMatchObject({ status: 400 });
    expect(await correct(itemId, { expectedVersion: 1, reason: REASON, entered_by: users.lab1 })).toMatchObject({ status: 400 });
    expect(await correct(itemId, { expectedVersion: 0, reason: REASON })).toMatchObject({ status: 400 });
    const made = await correct(itemId, { expectedVersion: 1, reason: REASON });
    expect(made).toMatchObject({ status: 201, body: { data: { version: 2, correctsVersion: 1 } } });
    // Both exist; version 1 is untouched and still the verified one.
    const [v1, v2] = await versionsOf(itemId);
    expect(v1).toMatchObject({ id: versionId, status: "verified", entered_by: users.lab1, verified_by: users.lab2 });
    expect(v2).toMatchObject({ version: 2, status: "draft", entered_by: users.lab3, corrects_version_id: v1.id, verified_by: null });
    let d = (await detail(itemId)).body.data!.detail;
    expect(d.verified.values.find((v: { code: string }) => v.code === "HGB").value).toBe(130);
    expect(d.working).toMatchObject({ version: 2, correctsVersion: 1, correctionReason: REASON, enteredBy: { id: users.lab3 } });
    expect(d.working.values).toHaveLength(6); // started from the verified values
    expect(d.canCorrect).toBe(false); // one correction at a time
    // Only the corrector edits it.
    as("lab1", "lab_staff");
    expect((await detail(itemId)).body.data!.detail.canEnter, "someone else's correction draft").toBe(false);
    expect(await save(itemId, fullCbc(131))).toMatchObject({ status: 403, body: { code: "not_author" } });
    as("lab3", "lab_staff");
    expect((await detail(itemId)).body.data!.detail.canEnter, "the corrector's own draft is editable").toBe(true);
    expect((await save(itemId, fullCbc(131))).status).toBe(200);
    expect((await versionsOf(itemId))[0].status, "still verified while the correction is a draft").toBe("verified");
    await move(v2.id, "submit");
    expect((await versionsOf(itemId))[0].status, "…and while it awaits verification").toBe("verified");
    as("lab2", "lab_staff");
    await move(v2.id, "verify");
    const after = await versionsOf(itemId);
    expect(after.map((v) => v.status)).toEqual(["superseded", "verified"]);
    expect(after[0]).toMatchObject({ entered_by: users.lab1, verified_by: users.lab2 }); // the original authors survive
    expect(after[1]).toMatchObject({ entered_by: users.lab3, verified_by: users.lab2 });
    d = (await detail(itemId)).body.data!.detail;
    expect(d.verified.version).toBe(2);
    expect(d.verified.values.find((v: { code: string }) => v.code === "HGB").value).toBe(131);
    expect(d.history.map((h: { version: number; status: string }) => `${h.version}:${h.status}`)).toEqual(["1:superseded", "2:verified"]);
    expect(d.canCorrect).toBe(true);
    // The superseded version's values are still stored, unchanged.
    expect((await sql<{ value_numeric: string }[]>`select value_numeric::text from public.lab_result_values where version_id = ${versionId} and parameter_code = 'HGB'`)[0].value_numeric).toBe("130");
  });

  it("a stale correction is refused; two simultaneous corrections end in exactly one open draft", async () => {
    const { itemId } = await verifiedResult();
    // Two at once, both having seen version 1.
    const correctAs = (user: string) => {
      as(user, "lab_staff");
      return correct(itemId, { expectedVersion: 1, reason: REASON });
    };
    const [a, b] = await Promise.all([correctAs("lab1"), correctAs("lab3")]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(["correction_in_progress", "stale_version"]).toContain([a, b].find((r) => r.status === 409)!.body.code);
    const open = (await versionsOf(itemId)).filter((v) => v.status === "draft" || v.status === "pending_verification");
    expect(open).toHaveLength(1);
    // Finish it, then a late correction that still names version 1 is stale.
    const winner = [a, b].find((r) => r.status === 201)!;
    const author = open[0].entered_by === users.lab1 ? "lab1" : "lab3";
    as(author, "lab_staff");
    await save(itemId, fullCbc(140));
    await move(winner.body.data!.versionId, "submit");
    as("lab2", "lab_staff");
    await move(winner.body.data!.versionId, "verify");
    as("lab3", "lab_staff");
    expect(await correct(itemId, { expectedVersion: 1, reason: REASON })).toMatchObject({ status: 409, body: { code: "stale_version" } });
    expect((await correct(itemId, { expectedVersion: 2, reason: REASON })).status).toBe(201);
    expect(await versionsOf(itemId)).toHaveLength(3);
    // Only a verified result is corrected.
    const { item } = await collectedOrder();
    as("lab1", "lab_staff");
    const draft = await save(item(T.cbc), fullCbc());
    expect(draft.status).toBe(200);
    expect(await correct(item(T.cbc), { expectedVersion: 1, reason: REASON })).toMatchObject({ status: 409 });
    expect(await correct(randomUUID(), { expectedVersion: 1, reason: REASON })).toMatchObject({ status: 404 });
  });

  it("a doctor cannot write a laboratory result — their different reading is their own clinical record, and the routes say no", async () => {
    const { itemId, versionId } = await verifiedResult();
    as("doc", "doctor");
    for (const attempt of [
      () => save(itemId, fullCbc(150)),
      () => move(versionId, "return"),
      () => move(versionId, "verify"),
      () => correct(itemId, { expectedVersion: 1, reason: REASON }),
    ]) {
      expect((await attempt()).status).toBe(403);
    }
    expect((await versionsOf(itemId)).map((v) => v.status)).toEqual(["verified"]);
    // The database agrees: the doctor's own token has no grant on the result tables at all.
    const err = await tokenResult(users.doc, (tx) => tx`update public.lab_result_versions set status = 'draft' where id = ${versionId}`);
    expect(err).toBe("42501");
  });

  // ------------------------------------------------------------------ closed work, list, audit

  it("a cancelled order takes no more results or corrections", async () => {
    const { orderId, item } = await collectedOrder();
    as("lab1", "lab_staff");
    const saved = await save(item(T.cbc), fullCbc());
    await sql`update public.lab_orders set status = 'cancelled', cancelled_by = ${users.owner}, cancel_reason = 'test' where id = ${orderId}`;
    expect(await save(item(T.cbc), fullCbc(131))).toMatchObject({ status: 409, body: { code: "order_closed" } });
    expect((await move(saved.body.data!.versionId, "submit")).status).toBe(409);
    const d = (await detail(item(T.cbc))).body.data!.detail;
    expect(d.canEnter).toBe(false);
    expect((await list()).body.data!.items.some((i: { itemId: string }) => i.itemId === item(T.cbc))).toBe(false);
  });

  it("the result list shows states, never a value: to do, to review, verified; urgent first; only this clinic", async () => {
    const todo = await collectedOrder();
    const review = await collectedOrder();
    as("lab1", "lab_staff");
    const r = await save(review.item(T.cbc), fullCbc(117.31));
    await move(r.body.data!.versionId, "submit");
    const done = await verifiedResult(118.77);
    const find = (items: Array<{ itemId: string; state: string }>, id: string) => items.find((i) => i.itemId === id);
    as("lab2", "lab_staff");
    const all = (await list("all")).body.data!.items;
    expect(find(all, todo.item(T.cbc))).toMatchObject({ state: "none", sampleCollected: true, patientName: `Results patient ${suffix}`, testName: "Complete blood count" });
    expect(find(all, review.item(T.cbc))).toMatchObject({ state: "pending_verification", enteredBy: "Person lab1" });
    expect(find(all, done.itemId)).toMatchObject({ state: "verified" });
    expect(find((await list("todo")).body.data!.items, todo.item(T.cbc))).toBeTruthy();
    expect(find((await list("todo")).body.data!.items, review.item(T.cbc))).toBeFalsy();
    expect(find((await list("review")).body.data!.items, review.item(T.cbc))).toBeTruthy();
    expect(find((await list("verified")).body.data!.items, done.itemId)).toBeTruthy();
    const text = JSON.stringify(all);
    expect(text).not.toMatch(/117\.31|118\.77/);
    expect(text).not.toContain(NOTE);
  });

  it("the audit trail records each step with who and which result — and no value, reason or note", async () => {
    const { itemId, versionId } = await verifiedResult(117.31);
    as("lab3", "lab_staff");
    const made = await correct(itemId, { expectedVersion: 1, reason: REASON });
    as("lab3", "lab_staff");
    await save(itemId, fullCbc(119.44));
    await move(made.body.data!.versionId, "submit");
    as("lab2", "lab_staff");
    await move(made.body.data!.versionId, "verify");
    await detail(itemId); // an access event
    const trail = await sql<{ action: string; actor_id: string | null; patient_id: string | null; entity_id: string; new_values: unknown; metadata: unknown }[]>`
      select action, actor_id, patient_id, entity_id, new_values, metadata from public.audit_events
       where entity_id in (${versionId}, ${made.body.data!.versionId}, ${itemId}) and action like 'lab_result%' order by created_at`;
    const actions = trail.map((t) => t.action);
    expect(actions).toEqual(expect.arrayContaining(["lab_result_entered", "lab_result_submitted", "lab_result_verified", "lab_result_version_created", "lab_result_version_superseded", "lab_result_viewed"]));
    expect(trail.find((t) => t.action === "lab_result_entered")).toMatchObject({ actor_id: users.lab1, patient_id: patient });
    expect(trail.find((t) => t.action === "lab_result_version_created")).toMatchObject({ actor_id: users.lab3 });
    expect(trail.filter((t) => t.action === "lab_result_verified").map((t) => t.actor_id)).toEqual([users.lab2, users.lab2]);
    expect(trail.find((t) => t.action === "lab_result_viewed")).toMatchObject({ actor_id: users.lab2, patient_id: patient });
    const text = JSON.stringify(trail);
    for (const secret of ["117.31", "119.44", REASON, NOTE, "clear", "negative"]) expect(text, secret).not.toContain(secret);
  });
});
