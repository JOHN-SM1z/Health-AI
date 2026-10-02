import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import postgres from "postgres";
import { cleanupTestClinics } from "@/test/cleanup-clinics";
import { localDbAvailable } from "@/test/local-db";

/**
 * Finalised laboratory results in the patient's longitudinal record, and result documents (phase 7), through the REAL routes, guards,
 * database and private storage: a doctor with a legitimate relationship (by the existing clinical access decision) reads every doctor's
 * FINALISED results - never work in progress - and changes none; documents are stored privately and reachable only through routes that
 * re-check clinic, patient, authorisation and the document-to-result relationship on every request.
 *
 * Mocked: only the staff session lookup (getStaffContext).
 */

const session = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/staff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/staff")>();
  return { ...actual, getStaffContext: async () => session.ctx };
});

import * as resultsList from "@/app/api/doctor/patients/[id]/lab/results/route";
import * as resultsDetail from "@/app/api/doctor/patients/[id]/lab/results/[itemId]/route";
import * as doctorDoc from "@/app/api/doctor/patients/[id]/lab/documents/[docId]/route";
import * as workspaceRoute from "@/app/api/doctor/patients/[id]/route";
import * as labUpload from "@/app/api/lab/results/[itemId]/documents/route";
import * as labDoc from "@/app/api/lab/documents/[docId]/route";
import * as labResultItem from "@/app/api/lab/results/[itemId]/route";
import * as labVersion from "@/app/api/lab/results/versions/[versionId]/route";
import * as labCorrection from "@/app/api/lab/results/[itemId]/correction/route";

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const describeDb = describe.skipIf(!localDbAvailable());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = { ok: boolean; data?: Record<string, any>; code?: string; error?: string };
type Role = "doctor" | "owner" | "receptionist" | "lab_staff";

const PDF = (extra = "") => new TextEncoder().encode(`%PDF-1.4\n% lab report ${extra}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF`);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);

describeDb("finalised laboratory results in the longitudinal record, and result documents", () => {
  let sql: postgres.Sql;
  const suffix = Date.now().toString(36) + Math.floor(Math.random() * 1e4);
  const clinicA = randomUUID();
  const clinicB = randomUUID();
  const users: Record<string, string> = Object.fromEntries(["a", "b", "c", "d", "k", "lab1", "lab2", "labB", "owner", "rec"].map((k) => [k, randomUUID()]));
  const doc: Record<string, string> = { a: randomUUID(), b: randomUUID(), c: randomUUID(), d: randomUUID(), k: randomUUID() };
  const svcA = randomUUID();
  const svcB = randomUUID();
  const patient = { x: randomUUID(), y: randomUUID(), k: randomUUID() };
  const T: Record<string, string> = {};
  const P: Record<string, string> = {};
  const created: string[] = [];
  let consultA = "";
  let day = 0;

  const as = (user: string, role: Role, clinic = clinicA) => {
    session.ctx = { profileId: users[user], clinicId: clinic, clinicName: "Lab", clinicTimezone: "Asia/Tashkent", roles: [role], platformAdmin: false };
  };
  const read = async (res: Response): Promise<{ status: number; body: Json }> => ({ status: res.status, body: (await res.json()) as Json });
  const req = (method: string, path: string, body?: BodyInit | unknown, headers: Record<string, string> = {}) =>
    new NextRequest(`http://localhost${path}`, {
      method,
      headers: body instanceof FormData ? headers : { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = (params: Record<string, string>): any => ({ params: Promise.resolve(params) });

  const list = async (pid: string) => read(await resultsList.GET(req("GET", `/api/doctor/patients/${pid}/lab/results`), ctx({ id: pid })));
  const detail = async (pid: string, itemId: string) => read(await resultsDetail.GET(req("GET", `/x`), ctx({ id: pid, itemId })));
  const docAs = (pid: string, docId: string) => doctorDoc.GET(req("GET", `/x`), ctx({ id: pid, docId }));
  const labDocGet = (docId: string) => labDoc.GET(req("GET", `/x`), ctx({ docId }));
  const upload = async (itemId: string, file: { bytes: Uint8Array | string; name?: string; type?: string } | null, fields: Record<string, string> = { kind: "report" }) => {
    const form = new FormData();
    if (file) form.set("file", new File([file.bytes as BlobPart], file.name ?? "report.pdf", { type: file.type ?? "application/pdf" }));
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    return read(await labUpload.POST(req("POST", `/api/lab/results/${itemId}/documents`, form), ctx({ itemId })));
  };
  const labMove = async (versionId: string, action: string) =>
    read(await labVersion.POST(req("POST", `/x`, { action }), ctx({ versionId })));
  const labCorrect = async (itemId: string, expectedVersion: number) =>
    read(await labCorrection.POST(req("POST", `/x`, { expectedVersion, reason: "Typing mistake" }), ctx({ itemId })));

  const rpc = async <R,>(fn: string, ...args: unknown[]): Promise<R> => {
    const rows = await sql.unsafe(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args as never[]);
    return (rows[0] as unknown as { r: R }).r;
  };
  const sqlJson = (v: unknown) => sql.json(v as never);

  async function visit(clinic: string, pt: string, doctor: string, status: string, service = svcA) {
    const start = new Date(Date.UTC(2035, 0, 2 + day++, 5, 0));
    const [row] = await sql<{ id: string }[]>`insert into public.appointments ${sql({
      clinic_id: clinic, patient_id: pt, doctor_id: doctor, service_id: service, start_at: start,
      end_at: new Date(start.getTime() + 30 * 60_000), status, source: "walk_in",
    })} returning id`;
    return row.id;
  }

  /** An ordered CBC for patient X with its sample collected: results can be entered. */
  async function collectedItem(testId = T.cbc) {
    const { order_id } = await rpc<{ order_id: string }>("lab_create_order", clinicA, users.a, patient.x, doc.a, consultA, null, "routine", "Doctor note", randomUUID(), sqlJson([{ test_id: testId }]));
    await rpc("lab_create_samples", clinicA, users.lab1, order_id);
    const [sample] = await sql<{ id: string }[]>`select id from public.lab_samples where order_id = ${order_id}`;
    await rpc("lab_sample_transition", clinicA, users.lab1, sample.id, "collected", null);
    const [item] = await sql<{ id: string }[]>`select id from public.lab_order_items where order_id = ${order_id}`;
    return { orderId: order_id, itemId: item.id };
  }
  const values = (hgb: number) => sqlJson([{ parameter_id: P.hgb, value_numeric: hgb }, { parameter_id: P.wbc, value_numeric: 7.2 }]);
  /** Entered by lab1 and verified by lab2. */
  async function finalisedItem(hgb = 118.5) {
    const it = await collectedItem();
    const saved = await rpc<{ version_id: string }>("lab_result_save", clinicA, users.lab1, it.itemId, values(hgb));
    await rpc("lab_result_submit", clinicA, users.lab1, saved.version_id);
    await rpc("lab_result_verify", clinicA, users.lab2, saved.version_id);
    return { ...it, versionId: saved.version_id };
  }
  const storage = () => postgres(DB_URL, { max: 1 });

  beforeAll(async () => {
    sql = postgres(DB_URL, { max: 8, onnotice: () => {} });
    await sql`insert into public.clinics ${sql([
      { id: clinicA, name: `Lab Long A ${suffix}`, slug: `lab-long-a-${suffix}`, timezone: "Asia/Tashkent" },
      { id: clinicB, name: `Lab Long B ${suffix}`, slug: `lab-long-b-${suffix}`, timezone: "Asia/Tashkent" },
    ])}`;
    const rows = Object.entries(users).map(([k, id]) => ({ id, email: `lablong-${k}-${suffix}@test.local` }));
    await sql`insert into auth.users ${sql(rows)}`;
    await sql`insert into public.profiles ${sql(rows.map((x) => ({ id: x.id, full_name: `Person ${x.email.split("-")[1]}` })))}`;
    const roleRows: Array<Record<string, string>> = [
      ...(["a", "b", "c", "d"] as const).map((k) => ({ clinic_id: clinicA, profile_id: users[k], role: "doctor" })),
      { clinic_id: clinicB, profile_id: users.k, role: "doctor" },
      { clinic_id: clinicA, profile_id: users.lab1, role: "lab_staff" },
      { clinic_id: clinicA, profile_id: users.lab2, role: "lab_staff" },
      { clinic_id: clinicB, profile_id: users.labB, role: "lab_staff" },
      { clinic_id: clinicA, profile_id: users.owner, role: "owner" },
      { clinic_id: clinicA, profile_id: users.rec, role: "receptionist" },
    ];
    await sql`insert into public.staff_roles ${sql(roleRows)}`;
    const doctorRows: Array<Record<string, unknown>> = [
      ...(["a", "b", "c", "d"] as const).map((k) => ({ id: doc[k], clinic_id: clinicA, profile_id: users[k], name: `Dr ${k.toUpperCase()} ${suffix}`, active: true })),
      { id: doc.k, clinic_id: clinicB, profile_id: users.k, name: `Dr K ${suffix}`, active: true },
    ];
    await sql`insert into public.doctors ${sql(doctorRows as never)}`;
    await sql`insert into public.services ${sql([
      { id: svcA, clinic_id: clinicA, name: `Long ${suffix}`, duration_minutes: 30, price: 1000 },
      { id: svcB, clinic_id: clinicB, name: `Long B ${suffix}`, duration_minutes: 30, price: 1000 },
    ])}`;
    await sql`insert into public.doctor_working_hours ${sql(
      [...(["a", "b", "c", "d"] as const).map((k) => [clinicA, doc[k]]), [clinicB, doc.k]].flatMap(([clinic, doctor]) =>
        [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinic_id: clinic, doctor_id: doctor, weekday, start_time: "00:00", end_time: "23:59" })),
      ),
    )}`;
    await sql`insert into public.patients ${sql([
      { id: patient.x, clinic_id: clinicA, full_name: `Long patient X ${suffix}` },
      { id: patient.y, clinic_id: clinicA, full_name: `Long patient Y ${suffix}` },
      { id: patient.k, clinic_id: clinicB, full_name: `Long patient K ${suffix}` },
    ])}`;
    consultA = await visit(clinicA, patient.x, doc.a, "in_progress");
    await visit(clinicA, patient.x, doc.b, "completed"); // B: a treating relationship with X (not with Y)
    await visit(clinicA, patient.y, doc.c, "completed"); // C: a treating relationship with Y only
    await visit(clinicB, patient.k, doc.k, "in_progress", svcB);

    const ins = async (table: string, row: Record<string, unknown>) => (await sql<{ id: string }[]>`insert into ${sql(`public.${table}`)} ${sql(row as never)} returning id`)[0].id;
    T.cbc = await ins("lab_tests", { clinic_id: clinicA, code: `CBC-${suffix}`, name: "Complete blood count", price: 85000, sample_type: "blood" });
    P.hgb = await ins("lab_test_parameters", { clinic_id: clinicA, test_id: T.cbc, code: "HGB", name: "Hemoglobin", unit: "g/L", data_type: "numeric", display_order: 1 });
    P.wbc = await ins("lab_test_parameters", { clinic_id: clinicA, test_id: T.cbc, code: "WBC", name: "WBC", unit: "10^9/L", data_type: "numeric", display_order: 2 });
    await ins("lab_reference_ranges", { clinic_id: clinicA, parameter_id: P.hgb, low: 120, high: 160, critical_low: 70, critical_high: 200 });
    await ins("lab_reference_ranges", { clinic_id: clinicA, parameter_id: P.wbc, low: 4, high: 10 });
  });

  // Each case counts its own requests (buckets are per login, and this file makes many calls).
  beforeEach(async () => {
    await sql`delete from public.rate_limit_buckets where key like 'doctor-lab-%' or key like 'lab-doc%'`;
  });

  afterAll(async () => {
    if (!sql) return;
    // Stored objects of this run (the database rows are removed with the clinics).
    const admin = (await import("@/lib/supabase/admin")).createAdminClient();
    const paths = await sql<{ storage_path: string }[]>`select storage_path from public.lab_result_attachments where clinic_id in ${sql([clinicA, clinicB])}`;
    if (paths.length) await admin.storage.from("lab-documents").remove(paths.map((p) => p.storage_path));
    await cleanupTestClinics([clinicA, clinicB]);
    await sql`delete from auth.users where id in ${sql(Object.values(users))}`;
    await sql.end({ timeout: 5 });
    void created;
  });

  // ------------------------------------------------------------------ the record

  it("a doctor with a legitimate relationship reads every doctor's FINALISED results - dates, source, values, flags - and nobody else does", async () => {
    const f = await finalisedItem(118.5);
    // A ordered it; B has a treating relationship with the patient; both read it, as part of the same history.
    for (const [who, own] of [["a", true], ["b", false]] as const) {
      as(who, "doctor");
      const res = await list(patient.x);
      expect(res.status, who).toBe(200);
      const r = (res.body.data!.results as Array<Record<string, unknown>>).find((x) => x.itemId === f.itemId)!;
      expect(r, who).toMatchObject({
        testName: "Complete blood count", testCode: `CBC-${suffix}`, isOwnOrder: own, orderedBy: `Dr A ${suffix}`, verifiedBy: "Person lab2",
        version: 1, versionCount: 1, valueCount: 2, outsideCount: 1, documentCount: 0,
      });
      expect(Date.parse(r.orderedAt as string)).toBeLessThanOrEqual(Date.parse(r.collectedAt as string));
      expect(Date.parse(r.collectedAt as string)).toBeLessThanOrEqual(Date.parse(r.resultAt as string));
      const d = (await detail(patient.x, f.itemId)).body.data!.result;
      expect(d.current.verifiedBy).toBe("Person lab2");
      expect(d.current.enteredBy).toBe("Person lab1");
      expect(d.current.values.find((v: { code: string }) => v.code === "HGB")).toMatchObject({ value: 118.5, unit: "g/L", flag: "low", refLow: 120, refHigh: 160 });
      expect(d.current.values.find((v: { code: string }) => v.code === "WBC")).toMatchObject({ value: 7.2, flag: "normal" });
      expect(d.previous).toEqual([]);
      // Never the ordering doctor's note, and nothing that reads as an interpretation.
      expect(JSON.stringify(res.body) + JSON.stringify(d)).not.toMatch(/Doctor note|anemi|diagnos/i);
    }
    // No relationship (same clinic), another clinic, a made-up patient: the same refusal as every other clinical read.
    as("c", "doctor");
    expect(await list(patient.x)).toMatchObject({ status: 404, body: { code: "patient_not_found" } });
    expect((await detail(patient.x, f.itemId)).status).toBe(404);
    expect(await sql`select 1 from public.audit_events where action = 'unauthorized_clinical_access_attempt' and entity_id = ${patient.x} and actor_id = ${users.c}`).not.toHaveLength(0);
    as("k", "doctor", clinicB);
    expect((await list(patient.x)).status).toBe(404);
    expect((await detail(patient.x, f.itemId)).status).toBe(404);
    expect((await list(patient.k)).body.data!.results).toEqual([]);
    expect((await list(randomUUID())).status).toBe(404);
    expect((await list("not-a-uuid")).status).toBe(404);
    // Every read is in the audit trail, ids only.
    const trail = await sql<{ actor_id: string; metadata: Record<string, unknown> }[]>`select actor_id, metadata from public.audit_events where action = 'lab_result_viewed' and patient_id = ${patient.x} and actor_id = ${users.b}`;
    expect(trail.map((t) => t.metadata.via)).toEqual(expect.arrayContaining(["doctor_list", "doctor_detail"]));
    expect(JSON.stringify(trail)).not.toMatch(/118\.5/);
  });

  it("the record is one record: the same relationship rules (a referral opens it, a revoked one closes it), the patient workspace carries the results, and path ids cannot be mixed", async () => {
    const f = await finalisedItem(131.1);
    // Doctor D: no relationship → nothing. An open referral from A opens the patient's whole history, results included.
    as("d", "doctor");
    expect((await list(patient.x)).status).toBe(404);
    const [ref] = await sql<{ id: string }[]>`insert into public.referrals ${sql({
      clinic_id: clinicA, patient_id: patient.x, referring_doctor_id: doc.a, referred_to_doctor_id: doc.d,
      originating_appointment_id: consultA, reason: "see the patient", created_by: users.a,
    })} returning id`;
    expect((await list(patient.x)).body.data!.results.some((r: { itemId: string }) => r.itemId === f.itemId)).toBe(true);
    // The patient workspace (the doctor's one entry point to the record) carries the same finalised results.
    const ws = await read(await workspaceRoute.GET(req("GET", "/x"), ctx({ id: patient.x })));
    expect(ws.status).toBe(200);
    expect(ws.body.data!.record.labResults.some((r: { itemId: string }) => r.itemId === f.itemId)).toBe(true);
    expect(JSON.stringify(ws.body.data!.record.labResults)).not.toMatch(/131\.1/); // summaries: values are opened one result at a time
    expect(await sql`select 1 from public.audit_events where action = 'clinical_record_viewed' and actor_id = ${users.d} and metadata -> 'lab_result_item_ids' ? ${f.itemId}`).toHaveLength(1);
    // Revoked: the access ends, for results too (the existing lifecycle decides, not this feature).
    // Triggers are bypassed for this transaction only (a global `disable trigger` would break referral tests running in parallel).
    await sql.begin(async (tx) => {
      await tx.unsafe("set local session_replication_role = replica");
      await tx`update public.referrals set status = 'revoked', revoked_at = now(), revoked_by = ${users.a}, revoked_reason = 'test' where id = ${ref.id}`;
    });
    const after = await list(patient.x);
    expect([404, 410]).toContain(after.status);
    expect((await detail(patient.x, f.itemId)).status).toBeGreaterThanOrEqual(404);
    // A legitimate doctor of ANOTHER patient cannot reach patient X's result through their own patient's path (nor the reverse).
    as("c", "doctor");
    expect((await list(patient.y)).status).toBe(200);
    expect((await detail(patient.y, f.itemId))).toMatchObject({ status: 404, body: { code: "lab_not_found" } });
    as("b", "doctor");
    expect((await detail(patient.x, randomUUID())).status).toBe(404);
    expect((await detail(patient.x, "not-a-uuid")).status).toBe(404);
  });

  it("only finalised work is part of the record: drafts, submitted-unverified, abandoned drafts and a correction in preparation are invisible", async () => {
    // A draft, a submitted one and an abandoned one - none is a result.
    const draft = await collectedItem();
    await rpc("lab_result_save", clinicA, users.lab1, draft.itemId, values(101.01));
    const submitted = await collectedItem();
    const s = await rpc<{ version_id: string }>("lab_result_save", clinicA, users.lab1, submitted.itemId, values(102.02));
    await rpc("lab_result_submit", clinicA, users.lab1, s.version_id);
    const abandoned = await collectedItem();
    const a = await rpc<{ version_id: string }>("lab_result_save", clinicA, users.lab1, abandoned.itemId, values(103.03));
    await rpc("lab_result_abandon", clinicA, users.lab1, a.version_id, "Wrong sample");
    as("b", "doctor");
    const listed = (await list(patient.x)).body.data!.results as Array<{ itemId: string }>;
    for (const it of [draft, submitted, abandoned]) {
      expect(listed.some((r) => r.itemId === it.itemId)).toBe(false);
      expect((await detail(patient.x, it.itemId))).toMatchObject({ status: 404, body: { code: "lab_not_found" } });
    }
    expect(JSON.stringify(listed)).not.toMatch(/101\.01|102\.02|103\.03/);

    // A finalised result with a correction under way: the doctor still sees the standing version, and nothing of the draft.
    const f = await finalisedItem(110.11);
    as("lab1", "lab_staff");
    expect((await labCorrect(f.itemId, 1)).status).toBe(201);
    const [res] = await sql<{ id: string }[]>`select id from public.lab_results where order_item_id = ${f.itemId}`;
    const [v2] = await sql<{ id: string }[]>`select id from public.lab_result_versions where result_id = ${res.id} and status = 'draft'`;
    await rpc("lab_result_save", clinicA, users.lab1, f.itemId, values(150.15));
    as("b", "doctor");
    let d = (await detail(patient.x, f.itemId)).body.data!.result;
    expect(d.version).toBe(1);
    expect(d.current.values.find((v: { code: string }) => v.code === "HGB").value).toBe(110.11);
    expect(JSON.stringify(d)).not.toMatch(/150\.15|Typing mistake/);
    // Finalised again: the new version stands, the old one is kept as a previous version, with its own values and its authors.
    await rpc("lab_result_submit", clinicA, users.lab1, v2.id);
    await rpc("lab_result_verify", clinicA, users.lab2, v2.id);
    d = (await detail(patient.x, f.itemId)).body.data!.result;
    expect(d).toMatchObject({ version: 2, versionCount: 2 });
    expect(d.current).toMatchObject({ version: 2, correctsVersion: 1, correctionReason: "Typing mistake", enteredBy: "Person lab1", verifiedBy: "Person lab2" });
    expect(d.current.values.find((v: { code: string }) => v.code === "HGB").value).toBe(150.15);
    expect(d.previous).toHaveLength(1);
    expect(d.previous[0]).toMatchObject({ version: 1, status: "superseded", enteredBy: "Person lab1", verifiedBy: "Person lab2" });
    expect(d.previous[0].values.find((v: { code: string }) => v.code === "HGB")).toMatchObject({ value: 110.11, flag: "low" });
    // The summary list says the same.
    expect(((await list(patient.x)).body.data!.results as Array<{ itemId: string; version: number }>).find((r) => r.itemId === f.itemId)!.version).toBe(2);
  });

  it("a doctor cannot change a colleague's result: no write method exists on the doctor routes, the laboratory routes refuse doctors, and the tables refuse their token", async () => {
    const f = await finalisedItem();
    for (const mod of [resultsList, resultsDetail, doctorDoc]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect((mod as Record<string, unknown>)[method], method).toBeUndefined();
    }
    for (const who of ["a", "b"]) {
      as(who, "doctor");
      expect((await labCorrect(f.itemId, 1)).status, who).toBe(403);
      expect((await labMove(f.versionId, "return")).status, who).toBe(403);
      expect((await upload(f.itemId, { bytes: PDF() })).status, who).toBe(403);
      expect((await read(await labResultItem.PUT(req("PUT", "/x", { values: [{ parameterId: P.hgb, value: 1 }] }), ctx({ itemId: f.itemId })))).status, who).toBe(403);
    }
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
    expect(await tokenResult(users.b, (tx) => tx`update public.lab_result_versions set status = 'draft' where id = ${f.versionId}`)).toBe("42501");
    expect(await tokenResult(users.b, (tx) => tx`update public.lab_result_values set value_numeric = 1`)).toBe("42501");
    expect(await tokenResult(users.b, (tx) => tx`select * from public.lab_result_attachments`)).toBe("42501");
    expect(await tokenResult(users.b, (tx) => tx`insert into public.lab_result_attachments (clinic_id, result_id, storage_path, content_type, size_bytes, sha256, uploaded_by) values (${clinicA}, ${randomUUID()}, 'x', 'application/pdf', 1, ${"0".repeat(64)}, ${users.b})`)).toBe("42501");
    expect((await versionsStatuses(f.itemId))).toEqual(["verified"]);
  });
  const versionsStatuses = async (itemId: string) =>
    (await sql<{ status: string }[]>`select v.status from public.lab_result_versions v join public.lab_results r on r.id = v.result_id where r.order_item_id = ${itemId} order by v.version`).map((x) => x.status);

  // ------------------------------------------------------------------ documents

  it("upload: laboratory staff only; the type is decided by the file's own bytes; size, kind and fields are checked; the file is stored privately under the result's own folder", async () => {
    const f = await collectedItem();
    as("lab1", "lab_staff");
    expect((await upload(f.itemId, { bytes: PDF() })).status, "no result yet").toBe(404);
    await rpc("lab_result_save", clinicA, users.lab1, f.itemId, values(125));
    const res = await upload(f.itemId, { bytes: PDF("a"), name: "John Smith lab report.pdf" }, { kind: "scan" });
    expect(res.status).toBe(201);
    const d = res.body.data!.document;
    expect(d).toMatchObject({ kind: "scan", contentType: "application/pdf" });
    expect(JSON.stringify(res.body)).not.toMatch(/John|Smith/); // the file name is never kept
    const [row] = await sql<{ storage_path: string; sha256: string; size_bytes: string; uploaded_by: string; content_type: string }[]>`select storage_path, sha256, size_bytes::text, uploaded_by, content_type from public.lab_result_attachments where id = ${d.id}`;
    const [{ rid, pid }] = await sql<{ rid: string; pid: string }[]>`select id as rid, patient_id as pid from public.lab_results where order_item_id = ${f.itemId}`;
    expect(row.storage_path).toBe(`${clinicA}/${pid}/${rid}/${d.id}.pdf`);
    expect(row).toMatchObject({ uploaded_by: users.lab1, content_type: "application/pdf", sha256: createHash("sha256").update(PDF("a")).digest("hex") });
    expect(Number(row.size_bytes)).toBe(PDF("a").length);
    // The object is really in the private bucket, and the bucket is not public.
    const admin = (await import("@/lib/supabase/admin")).createAdminClient();
    expect((await admin.storage.from("lab-documents").download(row.storage_path)).error).toBeNull();
    const [bucket] = await sql<{ public: boolean; file_size_limit: string }[]>`select public, file_size_limit::text from storage.buckets where id = 'lab-documents'`;
    expect(bucket).toMatchObject({ public: false, file_size_limit: "10485760" });
    // The upload is audited by the database, ids and the content type only.
    expect(await sql`select 1 from public.audit_events where action = 'lab_attachment_added' and actor_id = ${users.lab1}`).not.toHaveLength(0);

    // The type is the bytes', never the client's claim: a PDF sent as an image is stored as a PDF; text sent as a PDF is refused.
    const liar = await upload(f.itemId, { bytes: PDF("b"), name: "x.png", type: "image/png" });
    expect(liar.body.data!.document.contentType).toBe("application/pdf");
    expect((await upload(f.itemId, { bytes: "just some text", name: "report.pdf", type: "application/pdf" })).status).toBe(415);
    expect((await upload(f.itemId, { bytes: "<html><script>alert(1)</script></html>", name: "r.pdf", type: "application/pdf" })).status).toBe(415);
    expect((await upload(f.itemId, { bytes: new Uint8Array([0x4d, 0x5a, 0x90, 0]), name: "r.pdf" })).status, "an executable").toBe(415);
    expect((await upload(f.itemId, { bytes: new Uint8Array([]) })).status).toBe(400);
    expect((await upload(f.itemId, { bytes: PNG, type: "image/png", name: "s.png" }, { kind: "image" })).body.data!.document.contentType).toBe("image/png");
    expect((await upload(f.itemId, { bytes: JPEG, type: "image/jpeg", name: "s.jpg" }, { kind: "imported" })).body.data!.document.contentType).toBe("image/jpeg");
    // Size limit: 10 MB is the most.
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(PDF());
    expect(await upload(f.itemId, { bytes: big })).toMatchObject({ status: 413, body: { code: "file_too_large" } });
    // Kind and fields.
    expect((await upload(f.itemId, { bytes: PDF("c") }, { kind: "prescription" })).status).toBe(400);
    expect((await upload(f.itemId, { bytes: PDF("c") }, {})).status).toBe(400);
    expect((await upload(f.itemId, { bytes: PDF("c") }, { kind: "report", patientId: patient.y })).status, "no patient or path can be named").toBe(400);
    expect((await upload(f.itemId, { bytes: PDF("c") }, { kind: "report", storage_path: "../../x" })).status).toBe(400);
    expect((await upload(f.itemId, null)).status).toBe(400);
    expect((await upload("not-a-uuid", { bytes: PDF() })).status).toBe(404);
    // Roles, sessions and clinics.
    for (const [user, role] of [["owner", "owner"], ["rec", "receptionist"], ["a", "doctor"]] as const) {
      as(user, role);
      expect((await upload(f.itemId, { bytes: PDF("z") })).status, role).toBe(403);
    }
    session.ctx = null;
    expect((await upload(f.itemId, { bytes: PDF("z") })).status).toBe(401);
    as("labB", "lab_staff", clinicB);
    expect((await upload(f.itemId, { bytes: PDF("z") })).status).toBe(404);
    // A rejected insert leaves no stray object: only the accepted files are stored for this result.
    const stored = await admin.storage.from("lab-documents").list(`${clinicA}/${pid}/${rid}`);
    const rows = await sql<{ n: number }[]>`select count(*)::int as n from public.lab_result_attachments where result_id = ${rid}`;
    expect(stored.data?.length).toBe(rows[0].n);
  });

  it("a finalised result takes no new document until it is corrected; at most 20 per result; a database row cannot point outside its own result's folder", async () => {
    const f = await finalisedItem();
    as("lab1", "lab_staff");
    expect(await upload(f.itemId, { bytes: PDF("late") })).toMatchObject({ status: 409, body: { code: "already_verified" } });
    expect((await labCorrect(f.itemId, 1)).status).toBe(201);
    expect((await upload(f.itemId, { bytes: PDF("with-correction") })).status).toBe(201);
    const [{ rid }] = await sql<{ rid: string }[]>`select id as rid from public.lab_results where order_item_id = ${f.itemId}`;
    // The database rule, by itself: a path of another result / patient is refused.
    const bad = await sql`insert into public.lab_result_attachments (clinic_id, result_id, storage_path, content_type, size_bytes, sha256, uploaded_by)
      values (${clinicA}, ${rid}, ${`${clinicA}/${patient.y}/${randomUUID()}/x.pdf`}, 'application/pdf', 1, ${"0".repeat(64)}, ${users.lab1})`.then(() => "inserted", (e: postgres.PostgresError) => e.message);
    expect(bad).toMatch(/own folder/);
    // The 20-document ceiling.
    const g = await collectedItem();
    await rpc("lab_result_save", clinicA, users.lab1, g.itemId, values(130));
    for (let i = 0; i < 20; i++) expect((await upload(g.itemId, { bytes: PDF(String(i)) })).status, String(i)).toBe(201);
    expect(await upload(g.itemId, { bytes: PDF("21") })).toMatchObject({ status: 409, body: { code: "too_many_documents" } });
  });

  it("download: no URL works by itself - clinic, patient, authorisation and the document-to-result relationship are checked on every request, and the read is audited", async () => {
    const f = await finalisedItem();
    // Documents attached while the result was in work are part of the finalised result.
    const g = await collectedItem();
    as("lab1", "lab_staff");
    const saved = await rpc<{ version_id: string }>("lab_result_save", clinicA, users.lab1, g.itemId, values(140));
    const up = await upload(g.itemId, { bytes: PDF("in-work") }, { kind: "report" });
    const docId = up.body.data!.document.id as string;
    const bytes = new Uint8Array(await (await labDocGet(docId)).arrayBuffer());
    expect(Buffer.from(bytes).equals(Buffer.from(PDF("in-work")))).toBe(true);
    const labRes = await labDocGet(docId);
    expect(labRes.headers.get("content-type")).toBe("application/pdf");
    expect(labRes.headers.get("cache-control")).toBe("private, no-store");
    expect(labRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(labRes.headers.get("content-security-policy")).toMatch(/sandbox/);
    expect(labRes.headers.get("content-disposition")).toMatch(/^inline; filename="lab-document-[0-9a-f]{8}\.pdf"$/);

    // While the result is not finalised no doctor sees the document or the result.
    as("b", "doctor");
    expect((await docAs(patient.x, docId)).status).toBe(404);
    // Finalised: doctors with the relationship read it; the summary and the detail list it.
    await rpc("lab_result_submit", clinicA, users.lab1, saved.version_id);
    await rpc("lab_result_verify", clinicA, users.lab2, saved.version_id);
    for (const who of ["a", "b"]) {
      as(who, "doctor");
      const ok = await docAs(patient.x, docId);
      expect(ok.status, who).toBe(200);
      expect(Buffer.from(new Uint8Array(await ok.arrayBuffer())).equals(Buffer.from(PDF("in-work")))).toBe(true);
      expect(ok.headers.get("cache-control")).toBe("private, no-store");
      const d = (await detail(patient.x, g.itemId)).body.data!.result;
      expect(d.documentCount).toBe(1);
      expect(d.documents[0]).toMatchObject({ id: docId, kind: "report", contentType: "application/pdf" });
    }
    expect(await sql`select 1 from public.audit_events where action = 'lab_document_downloaded' and entity_id = ${docId} and actor_id = ${users.b} and patient_id = ${patient.x}`).toHaveLength(1);
    expect(await sql`select 1 from public.audit_events where action = 'lab_document_downloaded' and entity_id = ${docId} and actor_id = ${users.lab1}`).toHaveLength(2); // the bench read it twice above

    // Refusals: no relationship; another clinic; the right document under the wrong patient; a made-up / malformed / another result's id.
    as("c", "doctor");
    expect(await read(await docAs(patient.x, docId))).toMatchObject({ status: 404, body: { code: "patient_not_found" } });
    expect((await docAs(patient.y, docId)).status, "C is legitimate for Y, but the document is not Y's").toBe(404);
    as("k", "doctor", clinicB);
    expect((await docAs(patient.x, docId)).status).toBe(404);
    expect((await docAs(patient.k, docId)).status, "a clinic-B doctor's own patient, a clinic-A document").toBe(404);
    as("b", "doctor");
    expect((await docAs(patient.x, randomUUID())).status).toBe(404);
    expect((await docAs(patient.x, "not-a-uuid")).status).toBe(404);
    expect((await docAs("not-a-uuid", docId)).status).toBe(404);
    // Laboratory side: roles, sessions, clinics.
    for (const [user, role] of [["owner", "owner"], ["rec", "receptionist"], ["b", "doctor"]] as const) {
      as(user, role);
      expect((await labDocGet(docId)).status, role).toBe(403);
    }
    as("labB", "lab_staff", clinicB);
    expect((await labDocGet(docId)).status).toBe(404);
    session.ctx = null;
    expect((await labDocGet(docId)).status).toBe(401);
    expect((await docAs(patient.x, docId)).status).toBe(401);
    void f;
  });

  it("a document added during a correction stays invisible to doctors until the correction is verified; the old version's documents keep showing", async () => {
    const f = await finalisedItem();
    as("lab1", "lab_staff");
    const first = await rpc<{ version_id: string }>("lab_result_correct", clinicA, users.lab1, (await sql<{ id: string }[]>`select id from public.lab_results where order_item_id = ${f.itemId}`)[0].id, 1, "Typing mistake");
    const doc2 = (await upload(f.itemId, { bytes: PDF("correction-scan") }, { kind: "scan" })).body.data!.document.id as string;
    as("b", "doctor");
    expect((await docAs(patient.x, doc2)).status).toBe(404);
    expect((await detail(patient.x, f.itemId)).body.data!.result.documents).toEqual([]);
    await rpc("lab_result_submit", clinicA, users.lab1, first.version_id);
    await rpc("lab_result_verify", clinicA, users.lab2, first.version_id);
    expect((await docAs(patient.x, doc2)).status).toBe(200);
    expect((await detail(patient.x, f.itemId)).body.data!.result.documents).toHaveLength(1);
  });

  it("no public, signed or anonymous way to the bytes exists, and a tampered object is never served", async () => {
    const g = await collectedItem();
    as("lab1", "lab_staff");
    await rpc("lab_result_save", clinicA, users.lab1, g.itemId, values(122));
    const up = await upload(g.itemId, { bytes: PDF("secret-report") });
    const docId = up.body.data!.document.id as string;
    const [row] = await sql<{ storage_path: string }[]>`select storage_path from public.lab_result_attachments where id = ${docId}`;
    // Storage over HTTP without the server's key: the public endpoint, and the authenticated endpoint with only the anon key.
    const base = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (base && anon) {
      const publicTry = await fetch(`${base}/storage/v1/object/public/lab-documents/${row.storage_path}`);
      expect(publicTry.status).not.toBe(200);
      const anonTry = await fetch(`${base}/storage/v1/object/lab-documents/${row.storage_path}`, { headers: { apikey: anon, Authorization: `Bearer ${anon}` } });
      expect(anonTry.status).not.toBe(200);
      const signTry = await fetch(`${base}/storage/v1/object/sign/lab-documents/${row.storage_path}`, { method: "POST", headers: { apikey: anon, Authorization: `Bearer ${anon}`, "content-type": "application/json" }, body: JSON.stringify({ expiresIn: 60 }) });
      expect(signTry.status).not.toBe(200);
    }
    // The storage rows are closed to every signed-in token (no staff read policy, unlike voice files).
    const policies = await sql<{ policyname: string; roles: string[] }[]>`select policyname, roles from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname ilike 'lab-documents%'`;
    expect(policies.map((p) => p.policyname)).toEqual(["lab-documents service role access"]);
    expect(policies[0].roles).toEqual(["service_role"]);
    // Tampering with the stored object is detected by the checksum - the bytes are not served.
    const admin = (await import("@/lib/supabase/admin")).createAdminClient();
    const swap = await admin.storage.from("lab-documents").update(row.storage_path, PDF("tampered"), { contentType: "application/pdf" });
    expect(swap.error).toBeNull();
    const res = await labDocGet(docId);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toMatch(/tampered/);
    void storage;
  });
});
