import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { localDbAvailable } from "@/test/local-db";

/**
 * Historical lab import (Phase 13) through the real routes and the real
 * database: valid data, malformed rows, duplicate patients, duplicate
 * results, unmatched patients, mixed valid/invalid rows, partial failures
 * and retry, the dry run, second-person confirmation, and access attempts.
 */

const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

const session = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/staff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/staff")>();
  return { ...actual, getStaffContext: async () => session.ctx };
});

import { GET as listImports, POST as uploadImport } from "./imports/route";
import { GET as getImport, POST as importAction } from "./imports/[id]/route";
import { GET as getRows } from "./imports/[id]/rows/route";
import { GET as getReport } from "./imports/[id]/report/route";
import { GET as getQueue } from "./queue/route";
import { idFree } from "@/test/id-free";

const describeDb = describe.skipIf(!localDbAvailable());

type Body = { ok: boolean; data?: Record<string, unknown>; code?: string; error?: string };
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Body });

describeDb("historical lab import (real database)", () => {
  let admin: SupabaseClient;
  const suffix = Date.now().toString(36);
  const clinicA = randomUUID();
  const clinicB = randomUUID();
  const passwords = { lab: `Pw-${randomUUID()}` };
  const people = { lab: randomUUID(), reviewer: randomUUID(), owner: randomUUID(), reception: randomUUID(), doctor: randomUUID(), labB: randomUUID() };
  const tests = { cbc: "", glu: "", hgb: "", wbc: "", gluP: "" };
  const pts = { ali: "", nodira: "", twinA: "", twinB: "", tg: "" };
  // PINFLs unique to this run.
  const n = String(Date.now()).slice(-8);
  const pinfl = { ali: `301${n}001`, nodira: `302${n}002`, tg: `303${n}003` };

  const as = (profileId: string, role: string, clinicId = clinicA) => {
    session.ctx = { profileId, clinicId, clinicName: "Import", clinicTimezone: "Asia/Tashkent", roles: [role], platformAdmin: false };
  };
  const upload = async (csv: string | Uint8Array<ArrayBuffer>, opts: { source?: string; name?: string; origin?: string } = {}) => {
    const form = new FormData();
    form.set("file", new File([typeof csv === "string" ? new TextEncoder().encode(csv) as Uint8Array<ArrayBuffer> : csv], opts.name ?? `history-${randomUUID()}.csv`));
    form.set("sourceSystem", opts.source ?? "MedPlus");
    const headers: Record<string, string> = { host: "localhost" };
    if (opts.origin) headers.origin = opts.origin;
    return read(await uploadImport(new NextRequest("http://localhost/api/lab/imports", { method: "POST", body: form, headers })));
  };
  const act = async (id: string, body: Record<string, unknown>) =>
    read(
      await importAction(new NextRequest(`http://localhost/api/lab/imports/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), {
        params: Promise.resolve({ id }),
      }),
    );
  const detail = async (id: string) => read(await getImport(new NextRequest(`http://localhost/api/lab/imports/${id}`), { params: Promise.resolve({ id }) }));
  const rows = async (id: string, filter = "all") =>
    read(await getRows(new NextRequest(`http://localhost/api/lab/imports/${id}/rows?filter=${filter}`), { params: Promise.resolve({ id }) }));
  const statuses = async (id: string) => {
    const { data } = await admin.from("lab_import_rows").select("row_number, status, errors").eq("batch_id", id).order("row_number");
    return (data ?? []).map((r) => [r.row_number, r.status, r.errors]);
  };

  const HEAD = "PINFL;Telefon;Tug'ilgan sana;F.I.Sh.;Tahlil;Ko'rsatkich;Natija;Birlik;Sana;Buyurtma\n";
  /** Upload as the preparer and analyse with the suggested mapping. */
  async function prepared(lines: string[]) {
    as(people.lab, "lab");
    const up = await upload(HEAD + lines.join("\n") + "\n");
    expect(up.status).toBe(201);
    const id = up.body.data!.id as string;
    const analysed = await act(id, { action: "analyse", mapping: up.body.data!.mapping });
    expect(analysed.status).toBe(200);
    return id;
  }

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    await admin.from("clinics").insert([
      { id: clinicA, name: `Import A ${suffix}`, slug: `import-a-${suffix}`, timezone: "Asia/Tashkent" },
      { id: clinicB, name: `Import B ${suffix}`, slug: `import-b-${suffix}`, timezone: "Asia/Tashkent" },
    ]);
    for (const [name, id] of Object.entries(people)) {
      const { error } = await admin.auth.admin.createUser({ id, email: `import-${name}-${suffix}@test.local`, email_confirm: true, password: (passwords as Record<string, string>)[name] ?? `Pw-${randomUUID()}` });
      if (error) throw new Error(error.message);
      await admin.from("profiles").insert({ id, full_name: name });
    }
    await admin.from("staff_roles").insert([
      { clinic_id: clinicA, profile_id: people.lab, role: "lab" },
      { clinic_id: clinicA, profile_id: people.reviewer, role: "lab" },
      { clinic_id: clinicA, profile_id: people.owner, role: "owner" },
      { clinic_id: clinicA, profile_id: people.reception, role: "receptionist" },
      { clinic_id: clinicA, profile_id: people.doctor, role: "doctor" },
      { clinic_id: clinicB, profile_id: people.labB, role: "lab" },
    ]);
    const { data: cbc } = await admin.from("lab_tests").insert({ clinic_id: clinicA, code: "CBC", name: "Umumiy qon tahlili", sample_type: "Qon", price: 50000 }).select("id").single();
    const { data: glu } = await admin.from("lab_tests").insert({ clinic_id: clinicA, code: "GLU", name: "Glyukoza", sample_type: "Qon", price: 20000 }).select("id").single();
    tests.cbc = cbc!.id;
    tests.glu = glu!.id;
    const { data: params } = await admin
      .from("lab_test_parameters")
      .insert([
        { clinic_id: clinicA, test_id: tests.cbc, code: "HGB", name: "Gemoglobin", value_type: "numeric", unit: "g/L", decimals: 0, sort_order: 1 },
        { clinic_id: clinicA, test_id: tests.cbc, code: "WBC", name: "Leykotsitlar", value_type: "numeric", unit: "10^9/L", decimals: 1, sort_order: 2 },
        { clinic_id: clinicA, test_id: tests.glu, code: "GLU", name: "Glyukoza", value_type: "numeric", unit: "mmol/L", decimals: 1, sort_order: 1 },
      ])
      .select("id, code");
    tests.hgb = params!.find((p) => p.code === "HGB")!.id;
    tests.wbc = params!.find((p) => p.code === "WBC")!.id;
    tests.gluP = params!.find((p) => p.code === "GLU")!.id;
    await admin.from("lab_reference_ranges").insert({ clinic_id: clinicA, parameter_id: tests.gluP, low: 3.9, high: 6.1 });

    const { data: ps } = await admin
      .from("patients")
      .insert([
        { clinic_id: clinicA, full_name: "Ali Karimov", pinfl: pinfl.ali, date_of_birth: "1990-01-30", sex: "male", phone: "+998901234567" },
        { clinic_id: clinicA, full_name: "Nodira Saidova", pinfl: pinfl.nodira, date_of_birth: "1985-06-01", phone: "+998901112233" },
        { clinic_id: clinicA, full_name: "Aziz Rahimov", date_of_birth: "2000-05-05", phone: "+998935555555" },
        { clinic_id: clinicA, full_name: "Aziz Rahimov", date_of_birth: "2000-05-05", phone: "+998935555555" },
        { clinic_id: clinicA, full_name: "Telegram Bemor", pinfl: pinfl.tg, date_of_birth: "1970-01-01", telegram_user_id: 900_000_000 + Math.floor(Math.random() * 1e6) },
      ])
      .select("id, full_name, pinfl");
    pts.ali = ps!.find((p) => p.pinfl === pinfl.ali)!.id;
    pts.nodira = ps!.find((p) => p.pinfl === pinfl.nodira)!.id;
    [pts.twinA, pts.twinB] = ps!.filter((p) => p.full_name === "Aziz Rahimov").map((p) => p.id);
    pts.tg = ps!.find((p) => p.pinfl === pinfl.tg)!.id;
  });

  afterAll(async () => {
    if (!admin) return;
    await admin.from("clinics").delete().in("id", [clinicA, clinicB]);
    for (const id of Object.values(people)) await admin.auth.admin.deleteUser(id);
  });

  beforeEach(() => as(people.lab, "lab"));

  it("imports valid historical data end to end with two people, keeping date and source", async () => {
    const id = await prepared([
      `${pinfl.ali};;30.01.1990;Ali Karimov;CBC;HGB;135;g/L;01.03.2024;MP-1`,
      `${pinfl.ali};;30.01.1990;Ali Karimov;CBC;WBC;6,2;10^9/L;01.03.2024;MP-1`,
      `${pinfl.ali};;;;GLU;;7.2;mmol/L;2024-03-05 08:30;MP-2`,
      `${pinfl.tg};;;;GLU;;5.0;;10.03.2024;MP-3`,
    ]);
    expect(await statuses(id)).toEqual([
      [1, "ready", []],
      [2, "ready", []],
      [3, "ready", []],
      [4, "ready", []],
    ]);
    const d = (await detail(id)).body.data!;
    expect(d).toMatchObject({ status: "analysed", summary: { readyResults: 3, readyPatients: 2 }, can: { confirm: false, analyse: true }, preparer: true });

    // The preparer cannot confirm their own import.
    expect((await act(id, { action: "confirm" })).body.code).toBe("second_person_required");

    // Dry run: everything would import, nothing is written.
    as(people.reviewer, "lab");
    const dry = await act(id, { action: "dry_run" });
    expect(dry.body.data).toMatchObject({ checked: 3, wouldImport: 3, failed: 0, complete: true });
    const { count: none } = await admin.from("lab_orders").select("id", { count: "exact", head: true }).eq("clinic_id", clinicA).eq("source", "external_import");
    expect(none).toBe(0);

    // A second lab staff member confirms; the import runs.
    const run = await act(id, { action: "confirm" });
    expect(run.status).toBe(200);
    expect(run.body.data).toMatchObject({ imported: 3, failed: 0, duplicate: 0, remaining: 0, status: "completed" });
    expect((await statuses(id)).map((r) => r[1])).toEqual(["imported", "imported", "imported", "imported"]);

    const { data: results } = await admin
      .from("lab_results")
      .select("id, status, source, version, entered_by, submitted_by, verified_by, performed_at, patient_id, lab_order_items!lab_results_item_fkey(test_id, status, lab_orders!lab_order_items_order_fkey(source, status, ordered_by, external_reference)), lab_result_values(parameter_id, value_numeric, flag, unit_snapshot)")
      .eq("clinic_id", clinicA)
      .eq("source", "import")
      .order("performed_at");
    expect(results).toHaveLength(3);
    const cbcResult = results!.find((r) => (r.lab_order_items as unknown as { test_id: string }).test_id === tests.cbc)!;
    expect(cbcResult).toMatchObject({ status: "verified", source: "import", version: 1, entered_by: people.lab, submitted_by: people.lab, verified_by: people.reviewer, patient_id: pts.ali });
    // The historical date is kept (midday Tashkent when no time is given).
    expect(new Date(cbcResult.performed_at!).toISOString()).toBe("2024-03-01T07:00:00.000Z");
    expect((cbcResult.lab_order_items as unknown as { status: string; lab_orders: Record<string, unknown> }).lab_orders).toMatchObject({
      source: "external_import",
      status: "completed",
      ordered_by: people.lab,
    });
    const glu = results!.find((r) => r.patient_id === pts.ali && (r.lab_order_items as unknown as { test_id: string }).test_id === tests.glu)!;
    expect(glu.lab_result_values).toEqual([{ parameter_id: tests.gluP, value_numeric: 7.2, flag: "high", unit_snapshot: "mmol/L" }]);

    // Historical results never notify the patient (the Telegram patient got none).
    const ids = results!.map((r) => r.id);
    const { count: jobs } = await admin.from("notification_jobs").select("id", { count: "exact", head: true }).in("lab_result_id", ids);
    expect(jobs).toBe(0);

    // No payment, not lab work: absent from the queue.
    const { count: payments } = await admin.from("payments").select("id", { count: "exact", head: true }).eq("clinic_id", clinicA).not("lab_order_id", "is", null);
    expect(payments).toBe(0);
    const queue = await read(await getQueue());
    expect((queue.body.data!.orders as unknown[]).length).toBe(0);

    // Audit: ids, counts and codes — never cells, values or identifiers.
    const { data: audit } = await admin.from("audit_events").select("action, metadata, new_values").eq("clinic_id", clinicA).like("action", "lab_import%");
    expect(audit!.map((a) => a.action)).toEqual(expect.arrayContaining(["lab_import_uploaded", "lab_import_analysed", "lab_import_dry_run", "lab_import_confirmed", "lab_import_run"]));
    const text = idFree(audit);
    for (const secret of [pinfl.ali, "135", "7.2", "Ali Karimov", "MP-1", "history-"]) expect(text).not.toContain(secret);

    // The same file cannot be uploaded again; the same data in another file is a duplicate.
    as(people.lab, "lab");
    const again = await upload(HEAD + `${pinfl.ali};;;;GLU;;7.2;mmol/L;2024-03-05 08:30;MP-2\n`);
    const reId = again.body.data!.id as string;
    await act(reId, { action: "analyse", mapping: again.body.data!.mapping });
    expect(await statuses(reId)).toEqual([[1, "duplicate", ["existing_result"]]]);
  });

  it("reports malformed and invalid rows and imports the valid ones (mixed file, partial import)", async () => {
    const id = await prepared([
      `${pinfl.nodira};;;;GLU;;5.1;;01.04.2024;`,
      `${pinfl.nodira};;;;GLU;;abc;;02.04.2024;`,
      `${pinfl.nodira};;;`,
      `${pinfl.nodira};;;;XYZ;;1;;03.04.2024;`,
      `${pinfl.nodira};;;;GLU;;5.1;mg/dL;04.04.2024;`,
      `${pinfl.nodira};;;;GLU;;5.1;;31.02.2024;`,
      `${pinfl.nodira};;;;CBC;HGB;130;;05.04.2024;`,
      `${pinfl.nodira};;;;CBC;WBC;;;05.04.2024;`,
    ]);
    expect(await statuses(id)).toEqual([
      [1, "ready", []],
      [2, "invalid", ["invalid_value"]],
      [3, "invalid", ["malformed_row"]],
      [4, "invalid", ["unknown_test"]],
      [5, "invalid", ["unit_mismatch"]],
      [6, "invalid", ["invalid_date"]],
      [7, "invalid", ["group_has_errors"]],
      [8, "invalid", ["missing_value"]],
    ]);
    as(people.reviewer, "lab");
    expect((await act(id, { action: "confirm" })).body.data).toMatchObject({ imported: 1, failed: 0, status: "completed" });
    const report = await getReport(new NextRequest(`http://localhost/api/lab/imports/${id}/report`), { params: Promise.resolve({ id }) });
    const csv = await report.text();
    expect(report.headers.get("content-type")).toContain("text/csv");
    expect(csv).toContain("1;Import qilindi;");
    expect(csv).toContain("2;Xato;Qiymat ko‘rsatkich sozlamalariga mos emas");
    expect(csv).not.toContain(pinfl.nodira);
    expect(csv).not.toContain("abc");
  });

  it("never imports for unmatched, duplicate or contradicting patients, and never by name alone", async () => {
    const id = await prepared([
      `99999999999999;;;;GLU;;5.1;;01.05.2024;`, // unknown PINFL
      `;;;Ali Karimov;GLU;;5.1;;01.05.2024;`, // a name alone
      `;+998 93 555 55 55;05.05.2000;Aziz Rahimov;GLU;;5.1;;01.05.2024;`, // two patient records fit
      `${pinfl.ali};;30.01.1991;;GLU;;5.1;;01.05.2024;`, // date of birth contradicts the PINFL's patient
    ]);
    expect(await statuses(id)).toEqual([
      [1, "unmatched", ["no_candidate"]],
      [2, "invalid", ["no_identifiers"]],
      [3, "conflict", ["several_patients"]],
      [4, "conflict", ["dob_differs"]],
    ]);
    const page = await rows(id, "problems");
    const twins = (page.body.data!.rows as Array<{ rowNumber: number; candidates: Array<{ id: string }> }>).find((r) => r.rowNumber === 3)!;
    expect(twins.candidates.map((c) => c.id).sort()).toEqual([pts.twinA, pts.twinB].sort());
    as(people.reviewer, "lab");
    expect((await act(id, { action: "confirm" })).body.code).toBe("nothing_to_import");
    // No patient was created, changed or merged.
    const { count } = await admin.from("patients").select("id", { count: "exact", head: true }).eq("clinic_id", clinicA);
    expect(count).toBe(5);
  });

  it("detects duplicate rows in the file and existing results in the clinic, and never replaces them", async () => {
    // An existing manual result for Nodira, glucose, 01.06.2024.
    const { data: order } = await admin.rpc("create_lab_order", { p_clinic_id: clinicA, p_patient_id: pts.nodira, p_ordered_by: people.reception, p_source: "walk_in", p_test_ids: [tests.glu], p_panel_ids: [] });
    const orderId = (order as Array<{ lab_order_id: string }>)[0].lab_order_id;
    const { data: item } = await admin.from("lab_order_items").select("id").eq("order_id", orderId).single();
    const s = await admin.rpc("collect_lab_sample", { p_clinic_id: clinicA, p_order_id: orderId, p_item_ids: [item!.id], p_collected_by: people.lab });
    await admin.rpc("receive_lab_sample", { p_clinic_id: clinicA, p_sample_id: (s.data as Array<{ lab_sample_id: string }>)[0].lab_sample_id, p_received_by: people.lab });
    const r = await admin.rpc("save_lab_result_draft", { p_clinic_id: clinicA, p_order_item_id: item!.id, p_entered_by: people.lab, p_values: [{ parameter_id: tests.gluP, value_numeric: 6.6 }], p_performed_at: "2024-06-01T05:00:00Z" });
    const existingId = (r.data as Array<{ lab_result_id: string }>)[0].lab_result_id;

    const id = await prepared([
      `${pinfl.nodira};;;;GLU;;6.6;;01.06.2024;`, // same as existing → duplicate
      `${pinfl.ali};;;;GLU;;5.5;;02.06.2024;`,
      `${pinfl.ali};;;;GLU;;5.50;;02.06.2024;`, // same line twice
      `${pinfl.ali};;;;CBC;HGB;140;;03.06.2024;`,
      `${pinfl.ali};;;;CBC;HGB;141;;03.06.2024;`, // two values for one parameter
    ]);
    expect(await statuses(id)).toEqual([
      [1, "duplicate", ["existing_result"]],
      [2, "ready", []],
      [3, "duplicate", ["duplicate_in_file"]],
      [4, "conflict", ["conflicting_in_file"]],
      [5, "conflict", ["conflicting_in_file"]],
    ]);

    const other = await prepared([`${pinfl.nodira};;;;GLU;;9.9;;01.06.2024;`]);
    expect(await statuses(other)).toEqual([[1, "conflict", ["existing_result_differs"]]]);

    as(people.reviewer, "lab");
    expect((await act(id, { action: "confirm" })).body.data).toMatchObject({ imported: 1 });
    const { data: still } = await admin.from("lab_results").select("status, source, lab_result_values(value_numeric)").eq("id", existingId).single();
    expect(still).toMatchObject({ status: "draft", source: "manual", lab_result_values: [{ value_numeric: 6.6 }] });
  });

  it("waits for the preparer to confirm a weak patient match", async () => {
    const id = await prepared([`;+998 90 111 22 33;01.06.1985;Saidova Nodira;GLU;;4.8;;01.07.2024;`]);
    expect(await statuses(id)).toEqual([[1, "possible_match", ["confirm_patient"]]]);
    const page = await rows(id, "possible_match");
    const row = (page.body.data!.rows as Array<{ patientKey: string; candidates: Array<{ id: string; name: string }> }>)[0];
    expect(row.candidates).toEqual([expect.objectContaining({ id: pts.nodira, name: "Nodira Saidova" })]);

    // Only a suggested patient, and only by the preparer.
    expect((await act(id, { action: "confirm_match", patientKey: row.patientKey, patientId: pts.ali })).body.code).toBe("match_not_offered");
    as(people.reviewer, "lab");
    expect((await act(id, { action: "confirm_match", patientKey: row.patientKey, patientId: pts.nodira })).body.code).toBe("not_preparer");
    as(people.lab, "lab");
    expect((await act(id, { action: "confirm_match", patientKey: row.patientKey, patientId: pts.nodira })).status).toBe(200);
    const { data: stored } = await admin.from("lab_import_rows").select("status, patient_id, match_kind, match_confirmed_by").eq("batch_id", id).single();
    expect(stored).toEqual({ status: "ready", patient_id: pts.nodira, match_kind: "staff_confirmed", match_confirmed_by: people.lab });
    const { data: audit } = await admin.from("audit_events").select("patient_id, actor_id").eq("action", "lab_import_match_confirmed").eq("entity_id", id).single();
    expect(audit).toEqual({ patient_id: pts.nodira, actor_id: people.lab });
  });

  it("imports what it can when some results fail, and retries the failed ones", async () => {
    const id = await prepared([
      `${pinfl.ali};;;;GLU;;5.2;;01.08.2024;`,
      `${pinfl.nodira};;;;GLU;;5.3;;01.08.2024;`,
    ]);
    // Between preview and import, Nodira gets a result that day (entered by hand): that group must not import.
    const { data: order } = await admin.rpc("create_lab_order", { p_clinic_id: clinicA, p_patient_id: pts.nodira, p_ordered_by: people.reception, p_source: "walk_in", p_test_ids: [tests.glu], p_panel_ids: [] });
    const orderId = (order as Array<{ lab_order_id: string }>)[0].lab_order_id;
    const { data: item } = await admin.from("lab_order_items").select("id").eq("order_id", orderId).single();
    const s = await admin.rpc("collect_lab_sample", { p_clinic_id: clinicA, p_order_id: orderId, p_item_ids: [item!.id], p_collected_by: people.lab });
    await admin.rpc("receive_lab_sample", { p_clinic_id: clinicA, p_sample_id: (s.data as Array<{ lab_sample_id: string }>)[0].lab_sample_id, p_received_by: people.lab });
    await admin.rpc("save_lab_result_draft", { p_clinic_id: clinicA, p_order_item_id: item!.id, p_entered_by: people.lab, p_values: [{ parameter_id: tests.gluP, value_numeric: 5.3 }], p_performed_at: "2024-08-01T06:00:00Z" });
    // And the GLU parameter gets one decimal fewer: Ali's value now fails the database check.
    await admin.from("lab_test_parameters").update({ decimals: 0 }).eq("id", tests.gluP);

    as(people.reviewer, "lab");
    const run = await act(id, { action: "confirm" });
    expect(run.body.data).toMatchObject({ imported: 0, duplicate: 1, failed: 1, byCode: { existing_result: 1, value_rejected: 1 }, status: "confirmed" });
    expect(await statuses(id)).toEqual([
      [1, "failed", ["value_rejected"]],
      [2, "duplicate", ["existing_result"]],
    ]);

    await admin.from("lab_test_parameters").update({ decimals: 1 }).eq("id", tests.gluP);
    // The preparer may not run it; the reviewer retries.
    as(people.lab, "lab");
    expect((await act(id, { action: "retry_failed" })).body.code).toBe("second_person_required");
    as(people.reviewer, "lab");
    expect((await act(id, { action: "retry_failed" })).body.data).toMatchObject({ imported: 1, failed: 0, status: "completed" });
    const { data: row } = await admin.from("lab_import_rows").select("status, attempts").eq("batch_id", id).eq("row_number", 1).single();
    expect(row).toEqual({ status: "imported", attempts: 2 });
  });

  it("is lab work in one clinic, and the tables and functions are server-only", async () => {
    const id = await prepared([`${pinfl.ali};;;;GLU;;5.2;;01.09.2024;`]);
    for (const [who, role] of [[people.owner, "owner"], [people.reception, "receptionist"], [people.doctor, "doctor"]] as const) {
      as(who, role);
      expect((await read(await listImports())).status).toBe(403);
      expect((await detail(id)).status).toBe(403);
      expect((await rows(id)).status).toBe(403);
      expect((await act(id, { action: "confirm" })).status).toBe(403);
    }
    as(people.labB, "lab", clinicB);
    expect((await detail(id)).status).toBe(404);
    expect((await rows(id)).status).toBe(404);
    expect((await act(id, { action: "confirm" })).status).toBe(404);
    expect(((await read(await listImports())).body.data!.batches as unknown[]).length).toBe(0);

    // Cross-site upload and unsupported files are refused.
    as(people.lab, "lab");
    expect((await upload(HEAD + "x\n", { origin: "https://evil.example" })).status).toBe(403);
    expect((await upload(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]))).body.code).toBe("file_xlsx_not_supported");
    expect((await upload("%PDF-1.4 x")).body.code).toBe("file_pdf_not_supported");
    expect((await upload('a,b\n"x')).body.code).toBe("file_unterminated_quote");
    expect((await upload(HEAD.replace(";", ";;") + "1\n")).body.code).toBe("file_bad_header");

    // Signed-in and anonymous clients see nothing and cannot run the functions.
    const anon = createClient(URL, ANON_KEY, { auth: { persistSession: false } });
    const signed = createClient(URL, ANON_KEY, { auth: { persistSession: false } });
    const { error: signInError } = await signed.auth.signInWithPassword({ email: `import-lab-${suffix}@test.local`, password: passwords.lab });
    expect(signInError).toBeNull();
    for (const client of [anon, signed]) {
      for (const table of ["lab_import_batches", "lab_import_rows"]) {
        const { data, error } = await client.from(table).select("*").limit(1);
        expect(error !== null || (data ?? []).length === 0).toBe(true);
      }
      const { error } = await client.rpc("run_lab_import", { p_clinic_id: clinicA, p_batch_id: id, p_actor: people.reviewer, p_dry_run: false });
      expect(error).not.toBeNull();
      const { error: e2 } = await client.rpc("store_lab_import_analysis", { p_clinic_id: clinicA, p_batch_id: id, p_actor: people.lab, p_mapping: {}, p_summary: {}, p_rows: [] });
      expect(e2).not.toBeNull();
    }

    // The database itself refuses a confirmation by the preparer.
    const { error: selfConfirm } = await admin.from("lab_import_batches").update({ status: "confirmed", confirmed_by: people.lab, confirmed_at: new Date().toISOString() }).eq("id", id);
    expect(selfConfirm?.message).toMatch(/lab_import_batches_confirm_check/);
    const { error: selfRun } = await admin.rpc("run_lab_import", { p_clinic_id: clinicA, p_batch_id: id, p_actor: people.lab, p_dry_run: false });
    expect(selfRun?.message).toMatch(/lab_import_not_confirmed|lab_import_second_person/);

    // Cancelling stops it for good.
    expect((await act(id, { action: "cancel" })).body.data).toEqual({ status: "cancelled" });
    as(people.reviewer, "lab");
    expect((await act(id, { action: "confirm" })).status).toBe(409);
    expect(await statuses(id)).toEqual([[1, "skipped", []]]);
  });
});
