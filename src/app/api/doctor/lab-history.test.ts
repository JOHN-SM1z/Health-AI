import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { localDbAvailable } from "@/test/local-db";

/**
 * Laboratory history in the longitudinal record (Phase 10), through the real
 * routes and database: the patient's own doctor and a referred doctor see
 * every verified result (whoever ordered it); an unrelated doctor, a doctor
 * whose referral was revoked and another clinic's doctor see nothing; drafts
 * and results awaiting review never appear; history is read-only (a referred
 * doctor cannot correct another person's result, versions stay as they
 * were); attachments open through an audited, short-lived link.
 */

const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const session = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/staff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/staff")>();
  return { ...actual, getStaffContext: async () => session.ctx };
});

import { GET as getHistory } from "./patients/[id]/lab-history/route";
import { GET as getDocument } from "./patients/[id]/lab-documents/[documentId]/route";
import { POST as resultAction } from "../lab/results/[id]/route";

const describeDb = describe.skipIf(!localDbAvailable());

type Body = { ok: boolean; data?: Record<string, unknown>; code?: string };
type History = Array<{
  resultId: string;
  itemId: string;
  testName: string;
  source: string;
  orderSource: string;
  orderedAt: string;
  orderedByName: string | null;
  collectedAt: string | null;
  verifiedAt: string;
  verifiedByName: string | null;
  version: number;
  correctionReason: string | null;
  values: Array<{ parameterCode: string; numeric: number | null; display: string; unit: string | null; flag: string; rangeLow: number | null; rangeHigh: number | null }>;
  documents: Array<{ id: string; kind: string; mimeType: string }>;
}>;

const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Body });

describeDb("doctor lab history (real database)", () => {
  let admin: SupabaseClient;
  const suffix = Date.now().toString(36);
  const clinicA = randomUUID();
  const clinicB = randomUUID();
  const people = { reception: randomUUID(), tech: randomUUID(), reviewer: randomUUID(), drA: randomUUID(), drB: randomUUID(), drC: randomUUID(), drK: randomUUID() };
  const doctors = { a: randomUUID(), b: randomUUID(), c: randomUUID(), k: randomUUID() };
  const service = randomUUID();
  let test = "";
  let hgb = "";
  let patient = "";
  let visit = "";
  let referral = "";
  let day = 0;
  const results: { first: string; second: string; correction: string; pendingItem: string; firstItem: string } = { first: "", second: "", correction: "", pendingItem: "", firstItem: "" };
  const docs: { live: string; withdrawn: string; unverified: string } = { live: "", withdrawn: "", unverified: "" };

  const asDoctor = (profileId: string, clinicId = clinicA) => {
    session.ctx = { profileId, clinicId, clinicName: "History", clinicTimezone: "Asia/Tashkent", roles: ["doctor"], platformAdmin: false };
  };
  const history = async (patientId = patient) =>
    read(await getHistory(new NextRequest(`http://localhost/api/doctor/patients/${patientId}/lab-history`), { params: Promise.resolve({ id: patientId }) }));
  const documentLink = async (documentId: string, patientId = patient) =>
    read(await getDocument(new NextRequest("http://localhost"), { params: Promise.resolve({ id: patientId, documentId }) }));
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await admin.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  };

  /** Orders, collects, receives and enters HGB; verifies unless told otherwise. Returns item and result ids. */
  async function result(value: number, opts: { verify?: boolean; orderedBy?: string; doctorId?: string } = {}) {
    const order = (await rpc("create_lab_order", {
      p_clinic_id: clinicA, p_patient_id: patient, p_ordered_by: opts.orderedBy ?? people.reception, p_source: "walk_in",
      p_test_ids: [test], p_panel_ids: [], p_ordering_doctor_id: opts.doctorId,
    })) as Array<{ lab_order_id: string }>;
    const orderId = order[0].lab_order_id;
    const { data: item } = await admin.from("lab_order_items").select("id").eq("order_id", orderId).single();
    const sample = (await rpc("collect_lab_sample", { p_clinic_id: clinicA, p_order_id: orderId, p_item_ids: [item!.id], p_collected_by: people.reception })) as Array<{ lab_sample_id: string }>;
    await rpc("receive_lab_sample", { p_clinic_id: clinicA, p_sample_id: sample[0].lab_sample_id, p_received_by: people.tech });
    const saved = (await rpc("save_lab_result_draft", {
      p_clinic_id: clinicA, p_order_item_id: item!.id, p_entered_by: people.tech, p_values: [{ parameter_id: hgb, value_numeric: value }],
    })) as Array<{ lab_result_id: string }>;
    const id = saved[0].lab_result_id;
    await rpc("submit_lab_result", { p_clinic_id: clinicA, p_result_id: id, p_submitted_by: people.tech });
    if (opts.verify !== false) await rpc("verify_lab_result", { p_clinic_id: clinicA, p_result_id: id, p_verified_by: people.reviewer });
    return { itemId: item!.id as string, resultId: id };
  }

  async function document(resultId: string, opts: { withdrawn?: boolean } = {}) {
    const id = randomUUID();
    const path = `${clinicA}/${id}`;
    const bytes = new TextEncoder().encode(`%PDF-1.4 lab report ${suffix}`);
    const { error: upErr } = await admin.storage.from("lab-documents").upload(path, bytes, { contentType: "application/pdf" });
    if (upErr) throw new Error(upErr.message);
    const { data: orderRow } = await admin.from("lab_results").select("lab_order_items!lab_results_item_fkey(order_id)").eq("id", resultId).single();
    const orderId = (orderRow as unknown as { lab_order_items: { order_id: string } }).lab_order_items.order_id;
    const { error } = await admin.from("lab_documents").insert({
      id, clinic_id: clinicA, patient_id: patient, order_id: orderId, result_id: resultId, kind: "report",
      storage_path: path, mime_type: "application/pdf", size_bytes: bytes.length, sha256: "a".repeat(64), uploaded_by: people.tech,
    });
    if (error) throw new Error(error.message);
    if (opts.withdrawn) {
      await admin.from("lab_documents").update({ withdrawn_by: people.reviewer, withdraw_reason: "Noto‘g‘ri fayl", withdrawn_at: new Date().toISOString() }).eq("id", id);
    }
    return id;
  }

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    await admin.from("clinics").insert([
      { id: clinicA, name: `History A ${suffix}`, slug: `history-a-${suffix}`, timezone: "Asia/Tashkent" },
      { id: clinicB, name: `History B ${suffix}`, slug: `history-b-${suffix}`, timezone: "Asia/Tashkent" },
    ]);
    for (const [name, id] of Object.entries(people)) {
      const { error } = await admin.auth.admin.createUser({ id, email: `history-${name}-${suffix}@test.local`, email_confirm: true, password: `Pw-${randomUUID()}` });
      if (error) throw new Error(error.message);
      await admin.from("profiles").insert({ id, full_name: name });
    }
    await admin.from("staff_roles").insert([
      { clinic_id: clinicA, profile_id: people.reception, role: "receptionist" },
      { clinic_id: clinicA, profile_id: people.tech, role: "lab" },
      { clinic_id: clinicA, profile_id: people.reviewer, role: "lab" },
      { clinic_id: clinicA, profile_id: people.drA, role: "doctor" },
      { clinic_id: clinicA, profile_id: people.drB, role: "doctor" },
      { clinic_id: clinicA, profile_id: people.drC, role: "doctor" },
      { clinic_id: clinicB, profile_id: people.drK, role: "doctor" },
    ]);
    await admin.from("doctors").insert([
      { id: doctors.a, clinic_id: clinicA, profile_id: people.drA, name: `Dr A ${suffix}`, active: true },
      { id: doctors.b, clinic_id: clinicA, profile_id: people.drB, name: `Dr B ${suffix}`, active: true },
      { id: doctors.c, clinic_id: clinicA, profile_id: people.drC, name: `Dr C ${suffix}`, active: true },
      { id: doctors.k, clinic_id: clinicB, profile_id: people.drK, name: `Dr K ${suffix}`, active: true },
    ]);
    await admin.from("services").insert({ id: service, clinic_id: clinicA, name: `History consult ${suffix}`, duration_minutes: 30, price: 1 });
    await admin.from("doctor_working_hours").insert(
      [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinic_id: clinicA, doctor_id: doctors.a, weekday, start_time: "00:00", end_time: "23:59" })),
    );
    const { data: t } = await admin.from("lab_tests").insert({ clinic_id: clinicA, code: `HIS${suffix}`, name: `Tarix HB ${suffix}`, sample_type: "Qon", price: 1000 }).select("id").single();
    test = t!.id;
    const { data: p } = await admin.from("lab_test_parameters").insert({ clinic_id: clinicA, test_id: test, code: "HGB", name: "Gemoglobin", value_type: "numeric", unit: "g/L" }).select("id").single();
    hgb = p!.id;
    await admin.from("lab_reference_ranges").insert({ clinic_id: clinicA, parameter_id: hgb, low: 120, high: 160 });

    // Dr A's patient (a completed visit), referred to Dr B.
    const { data: pt } = await admin.from("patients").insert({ clinic_id: clinicA, full_name: `Tarix bemor ${suffix}`, date_of_birth: "1980-01-01" }).select("id").single();
    patient = pt!.id;
    const start = new Date(Date.UTC(2026, 6, 1, 5, 0) + day++ * 86_400_000);
    const { data: appt, error: apptError } = await admin.from("appointments").insert({
      clinic_id: clinicA, patient_id: patient, doctor_id: doctors.a, service_id: service,
      start_at: start.toISOString(), end_at: new Date(start.getTime() + 30 * 60_000).toISOString(), status: "completed", source: "walk_in",
    }).select("id").single();
    if (apptError) throw new Error(apptError.message);
    visit = appt!.id;
    const { data: ref, error: refError } = await admin.from("referrals").insert({
      clinic_id: clinicA, patient_id: patient, referring_doctor_id: doctors.a, referred_to_doctor_id: doctors.b,
      originating_appointment_id: visit, reason: `Kardiolog maslahati (${suffix})`, created_by: people.drA,
    }).select("id").single();
    if (refError) throw new Error(refError.message);
    referral = ref!.id;

    // History: an older result ordered by Dr A (later corrected), a newer walk-in result, one awaiting review, one draft.
    const first = await result(130, { orderedBy: people.drA, doctorId: doctors.a });
    results.first = first.resultId;
    results.firstItem = first.itemId;
    results.second = (await result(110)).resultId;
    results.pendingItem = (await result(150, { verify: false })).itemId;
    const correction = (await rpc("start_lab_result_correction", { p_clinic_id: clinicA, p_result_id: results.first, p_by: people.tech, p_reason: "Qayta o‘lchandi" })) as Array<{ lab_result_id: string }>;
    results.correction = correction[0].lab_result_id;
    await rpc("save_lab_result_draft", { p_clinic_id: clinicA, p_order_item_id: first.itemId, p_entered_by: people.tech, p_values: [{ parameter_id: hgb, value_numeric: 128 }] });
    await rpc("submit_lab_result", { p_clinic_id: clinicA, p_result_id: results.correction, p_submitted_by: people.tech });
    await rpc("verify_lab_result", { p_clinic_id: clinicA, p_result_id: results.correction, p_verified_by: people.reviewer });

    docs.live = await document(results.second);
    docs.withdrawn = await document(results.second, { withdrawn: true });
    const pending = await admin.from("lab_results").select("id").eq("order_item_id", results.pendingItem).single();
    docs.unverified = await document(pending.data!.id);
  });

  afterAll(async () => {
    if (!admin) return;
    await admin.storage.from("lab-documents").remove([docs.live, docs.withdrawn, docs.unverified].filter(Boolean).map((id) => `${clinicA}/${id}`));
    await admin.from("clinics").delete().in("id", [clinicA, clinicB]);
    for (const id of Object.values(people)) await admin.auth.admin.deleteUser(id);
  });

  it("the patient's own doctor sees every verified result with its dates, source and values — newest first by clinical time, no drafts or pending reviews", async () => {
    asDoctor(people.drA);
    const res = await history();
    expect(res.status).toBe(200);
    const rows = res.body.data!.results as History;
    // The correction was verified last, but its sample was taken first: it keeps its place in the timeline.
    expect(rows.map((r) => r.resultId)).toEqual([results.second, results.correction]);
    const corrected = rows[1];
    expect(corrected).toMatchObject({
      version: 2, correctionReason: "Qayta o‘lchandi", source: "manual", orderSource: "walk_in", orderedByName: `Dr A ${suffix}`, verifiedByName: "reviewer",
      values: [{ parameterCode: "HGB", numeric: 128, display: "128", unit: "g/L", flag: "normal", rangeLow: 120, rangeHigh: 160 }],
    });
    expect(corrected.collectedAt).not.toBeNull();
    expect(new Date(corrected.orderedAt) <= new Date(corrected.collectedAt!)).toBe(true);
    expect(new Date(corrected.collectedAt!) <= new Date(corrected.verifiedAt)).toBe(true);
    expect(rows[0].values[0]).toMatchObject({ numeric: 110, flag: "low" });
    expect(rows.some((r) => r.itemId === results.pendingItem)).toBe(false);
    // Only the live document of a verified result is listed.
    expect(rows[0].documents.map((d) => d.id)).toEqual([docs.live]);

    const { data: audit } = await admin.from("audit_events").select("entity_id, metadata").eq("action", "lab_result_viewed").eq("actor_id", people.drA);
    expect(audit!.map((a) => a.entity_id).sort()).toEqual([results.correction, results.second].sort());
    expect(JSON.stringify(audit)).not.toMatch(/128|110/);
  });

  it("a referred doctor sees the same history, including results another doctor ordered", async () => {
    asDoctor(people.drB);
    const rows = (await history()).body.data!.results as History;
    expect(rows.map((r) => r.resultId)).toEqual([results.second, results.correction]);
    expect(rows[1].orderedByName).toBe(`Dr A ${suffix}`);
  });

  it("an unrelated doctor, another clinic's doctor and a doctor without a link see nothing", async () => {
    asDoctor(people.drC);
    expect([404, 410]).toContain((await history()).status);
    expect([404, 410]).toContain((await documentLink(docs.live)).status);
    asDoctor(people.drK, clinicB);
    expect([404, 410]).toContain((await history()).status);
    session.ctx = { profileId: people.tech, clinicId: clinicA, clinicName: "x", clinicTimezone: "Asia/Tashkent", roles: ["lab"], platformAdmin: false };
    expect((await history()).status).toBe(403); // the doctor workspace is for linked doctors
    session.ctx = null;
    expect((await history()).status).toBe(401);
  });

  it("history is read-only: a referred doctor cannot correct another person's result; versions keep their values", async () => {
    asDoctor(people.drB);
    const res = await read(
      await resultAction(
        new NextRequest(`http://localhost/api/lab/results/${results.correction}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "correct", reason: "Boshqa fikrdaman" }) }),
        { params: Promise.resolve({ id: results.correction }) },
      ),
    );
    expect(res.status).toBe(403);
    const { data: versions } = await admin
      .from("lab_results")
      .select("id, status, version, entered_by, verified_by, lab_result_values(value_numeric)")
      .eq("order_item_id", results.firstItem)
      .order("version");
    expect(versions).toMatchObject([
      { id: results.first, status: "superseded", version: 1, entered_by: people.tech, verified_by: people.reviewer, lab_result_values: [{ value_numeric: 130 }] },
      { id: results.correction, status: "verified", version: 2, entered_by: people.tech, verified_by: people.reviewer, lab_result_values: [{ value_numeric: 128 }] },
    ]);
    // Even the server cannot rewrite a verified or superseded version.
    const { error } = await admin.from("lab_results").update({ lab_comment: "o‘zgartirildi" }).eq("id", results.first);
    expect(error?.message).toMatch(/cannot be edited|only a draft/);
  });

  it("opens an attachment of a verified result through a short-lived, audited link; withdrawn and unverified ones stay closed", async () => {
    asDoctor(people.drB);
    const res = await documentLink(docs.live);
    expect(res.status).toBe(200);
    expect(res.body.data!.expiresIn).toBe(60);
    const file = await fetch(res.body.data!.url as string);
    expect(file.status).toBe(200);
    expect(await file.text()).toContain(`lab report ${suffix}`);
    const { data: audit } = await admin.from("audit_events").select("actor_id, entity_id").eq("action", "lab_document_viewed").eq("entity_id", docs.live);
    expect(audit).toEqual([{ actor_id: people.drB, entity_id: docs.live }]);

    expect((await documentLink(docs.withdrawn)).status).toBe(404);
    expect((await documentLink(docs.unverified)).status).toBe(404);
    expect((await documentLink(randomUUID())).status).toBe(404);
  });

  it("referral-based access ends when the referral is revoked", async () => {
    await admin.from("referrals").update({ status: "revoked", revoked_at: new Date().toISOString(), revoked_by: people.drA, revoked_reason: "Kerak emas" }).eq("id", referral);
    asDoctor(people.drB);
    expect([404, 410]).toContain((await history()).status);
    expect([404, 410]).toContain((await documentLink(docs.live)).status);
    asDoctor(people.drA);
    expect((await history()).status).toBe(200);
  });
});
