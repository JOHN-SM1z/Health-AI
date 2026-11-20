import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { localDbAvailable } from "@/test/local-db";

/**
 * Patient merge (Phase 14) through the real routes and database, including
 * adversarial cases: a complete preview, nothing recorded is moved, changed
 * or deleted, authorship and audit history intact, no clinic crossing, the
 * longitudinal record reads as one (doctor workspace, lab history, Mini
 * App), contradictions and live work block the merge, a stale preview is
 * refused, concurrent merges end in one, a merged record takes no new work,
 * and an unmerge restores what it can and reports the rest.
 */

const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

const session = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/staff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/staff")>();
  return { ...actual, getStaffContext: async () => session.ctx };
});

import { GET as preview, POST as merge } from "./patients/merge/route";
import { GET as duplicates } from "./patients/duplicates/route";
import { GET as mergeLog } from "./patients/merges/route";
import { POST as mergeAction } from "./patients/merges/[id]/route";
import { GET as patientsList } from "./patients/route";
import { POST as bookAdmin } from "./appointments/route";
import { GET as workspace } from "../doctor/patients/[id]/route";
import { GET as labHistory } from "../doctor/patients/[id]/lab-history/route";
import { GET as doctorPatients } from "../doctor/patients/route";
import { listPatientLabResults } from "@/lib/labs/patient-results";
import { getOrCreatePatient } from "@/lib/patients/identity";
import { idFree } from "@/test/id-free";

const describeDb = describe.skipIf(!localDbAvailable());

type Body = { ok: boolean; data?: Record<string, unknown>; code?: string; error?: string; details?: { blockers?: string[] } };
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Body });
type Preview = {
  canonical: { id: string; counts: Record<string, number> };
  duplicate: { id: string; counts: Record<string, number> };
  plan: Record<string, string>;
  doctors_gaining_access: Array<{ doctor_id: string; from: string }>;
  blockers: string[];
  warnings: string[];
  fingerprint: string;
};

describeDb("patient merge (real database)", () => {
  let admin: SupabaseClient;
  const suffix = Date.now().toString(36);
  const clinicA = randomUUID();
  const clinicB = randomUUID();
  const passwords = { owner: `Pw-${randomUUID()}` };
  const people = { owner: randomUUID(), adminUser: randomUUID(), manager: randomUUID(), reception: randomUUID(), lab: randomUUID(), lab2: randomUUID(), drA: randomUUID(), drB: randomUUID(), drC: randomUUID(), ownerB: randomUUID() };
  const doctors = { a: randomUUID(), b: randomUUID(), c: randomUUID() };
  const service = randomUUID();
  let test = "";
  let param = "";
  let day = 0;
  let tg = 800_000_000 + Math.floor(Math.random() * 1e6);
  let pin = Number(String(Date.now()).slice(-9));

  const as = (profileId: string, role: string, clinicId = clinicA) => {
    session.ctx = { profileId, clinicId, clinicName: "Merge", clinicTimezone: "Asia/Tashkent", roles: [role], platformAdmin: false };
  };
  const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const getPreview = async (c: string, d: string) => read(await preview(new NextRequest(`http://localhost/api/admin/patients/merge?canonical=${c}&duplicate=${d}`)));
  const doMerge = async (c: string, d: string, fingerprint: string, reason = "Bir odam, pasport bilan tekshirildi") =>
    read(await merge(new NextRequest("http://localhost/api/admin/patients/merge", json({ canonicalId: c, duplicateId: d, reason, fingerprint, confirmSamePerson: true }))));
  const previewAndMerge = async (c: string, d: string) => {
    const p = await getPreview(c, d);
    expect(p.body.data!.blockers).toEqual([]);
    const m = await doMerge(c, d, p.body.data!.fingerprint as string);
    expect(m.status).toBe(201);
    return m;
  };
  const unmerge = async (id: string, reason = "Xato birlashtirilgan") =>
    read(await mergeAction(new NextRequest(`http://localhost/api/admin/patients/merges/${id}`, json({ action: "unmerge", reason })), { params: Promise.resolve({ id }) }));
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await admin.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  };

  const patient = async (fields: Record<string, unknown> = {}) => {
    const { data, error } = await admin.from("patients").insert({ clinic_id: clinicA, full_name: `Bemor ${suffix}`, ...fields }).select("id").single();
    if (error) throw new Error(error.message);
    return data!.id as string;
  };
  const visit = async (patientId: string, doctorId: string, status = "completed") => {
    const start = new Date(Date.UTC(2025, 0, 1, 5, 0) + day++ * 86_400_000);
    const { data, error } = await admin
      .from("appointments")
      .insert({ clinic_id: clinicA, patient_id: patientId, doctor_id: doctorId, service_id: service, start_at: start.toISOString(), end_at: new Date(start.getTime() + 1_800_000).toISOString(), status, source: "walk_in" })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return data!.id as string;
  };
  const record = async (patientId: string, appointmentId: string, doctorId: string, profileId: string) => {
    const { data, error } = await admin
      .from("clinical_records")
      .insert({ clinic_id: clinicA, patient_id: patientId, appointment_id: appointmentId, author_doctor_id: doctorId, record_type: "consultation_note", summary: `Yozuv ${suffix}`, created_by: profileId })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return data!.id as string;
  };
  /** A verified lab result for the patient (walk-in order through the real functions). */
  const verifiedResult = async (patientId: string, value: number) => {
    const o = (await rpc("create_lab_order", { p_clinic_id: clinicA, p_patient_id: patientId, p_ordered_by: people.reception, p_source: "walk_in", p_test_ids: [test], p_panel_ids: [] })) as Array<{ lab_order_id: string }>;
    const { data: item } = await admin.from("lab_order_items").select("id").eq("order_id", o[0].lab_order_id).single();
    const s = (await rpc("collect_lab_sample", { p_clinic_id: clinicA, p_order_id: o[0].lab_order_id, p_item_ids: [item!.id], p_collected_by: people.lab })) as Array<{ lab_sample_id: string }>;
    await rpc("receive_lab_sample", { p_clinic_id: clinicA, p_sample_id: s[0].lab_sample_id, p_received_by: people.lab });
    const r = (await rpc("save_lab_result_draft", { p_clinic_id: clinicA, p_order_item_id: item!.id, p_entered_by: people.lab, p_values: [{ parameter_id: param, value_numeric: value }] })) as Array<{ lab_result_id: string }>;
    await rpc("submit_lab_result", { p_clinic_id: clinicA, p_result_id: r[0].lab_result_id, p_submitted_by: people.lab });
    await rpc("verify_lab_result", { p_clinic_id: clinicA, p_result_id: r[0].lab_result_id, p_verified_by: people.lab2 });
    return { resultId: r[0].lab_result_id, itemId: item!.id as string, orderId: o[0].lab_order_id };
  };
  const snapshot = async (patientId: string) => {
    const tables = ["appointments", "payments", "clinical_records", "referrals", "lab_orders", "lab_order_items", "lab_results", "conversations", "audit_events"];
    const out: Record<string, unknown> = {};
    for (const t of tables) {
      const { data } = await admin.from(t).select("*").eq("patient_id", patientId).order("id");
      out[t] = data;
    }
    return out;
  };

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    await admin.from("clinics").insert([
      { id: clinicA, name: `Merge A ${suffix}`, slug: `merge-a-${suffix}`, timezone: "Asia/Tashkent" },
      { id: clinicB, name: `Merge B ${suffix}`, slug: `merge-b-${suffix}`, timezone: "Asia/Tashkent" },
    ]);
    for (const [name, id] of Object.entries(people)) {
      const { error } = await admin.auth.admin.createUser({ id, email: `merge-${name}-${suffix}@test.local`, email_confirm: true, password: (passwords as Record<string, string>)[name] ?? `Pw-${randomUUID()}` });
      if (error) throw new Error(error.message);
      await admin.from("profiles").insert({ id, full_name: name });
    }
    await admin.from("staff_roles").insert([
      { clinic_id: clinicA, profile_id: people.owner, role: "owner" },
      { clinic_id: clinicA, profile_id: people.adminUser, role: "admin" },
      { clinic_id: clinicA, profile_id: people.manager, role: "manager" },
      { clinic_id: clinicA, profile_id: people.reception, role: "receptionist" },
      { clinic_id: clinicA, profile_id: people.lab, role: "lab" },
      { clinic_id: clinicA, profile_id: people.lab2, role: "lab" },
      { clinic_id: clinicA, profile_id: people.drA, role: "doctor" },
      { clinic_id: clinicA, profile_id: people.drB, role: "doctor" },
      { clinic_id: clinicA, profile_id: people.drC, role: "doctor" },
      { clinic_id: clinicB, profile_id: people.ownerB, role: "owner" },
    ]);
    await admin.from("doctors").insert([
      { id: doctors.a, clinic_id: clinicA, profile_id: people.drA, name: `Dr A ${suffix}`, active: true },
      { id: doctors.b, clinic_id: clinicA, profile_id: people.drB, name: `Dr B ${suffix}`, active: true },
      { id: doctors.c, clinic_id: clinicA, profile_id: people.drC, name: `Dr C ${suffix}`, active: true },
    ]);
    await admin.from("services").insert({ id: service, clinic_id: clinicA, name: `Merge consult ${suffix}`, duration_minutes: 30, price: 1000 });
    await admin.from("doctor_working_hours").insert(
      Object.values(doctors).flatMap((doctor_id) => [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinic_id: clinicA, doctor_id, weekday, start_time: "00:00", end_time: "23:59" }))),
    );
    const { data: t } = await admin.from("lab_tests").insert({ clinic_id: clinicA, code: `MRG${suffix}`, name: `Birlashtirish HB ${suffix}`, sample_type: "Qon", price: 1000 }).select("id").single();
    test = t!.id;
    const { data: p } = await admin.from("lab_test_parameters").insert({ clinic_id: clinicA, test_id: test, code: "HGB", name: "Gemoglobin", value_type: "numeric", unit: "g/L" }).select("id").single();
    param = p!.id;
  });

  afterAll(async () => {
    if (!admin) return;
    await admin.from("clinics").delete().in("id", [clinicA, clinicB]);
    for (const id of Object.values(people)) await admin.auth.admin.deleteUser(id);
  });

  beforeEach(() => as(people.owner, "owner"));

  it("previews completely, merges as a link, and the longitudinal record reads as one — nothing recorded is changed", async () => {
    // Desk record (Dr A's patient) and a Telegram record of the same person (Dr B's patient).
    const pinfl = String(pin++).padStart(14, "3");
    const telegram = tg++;
    const desk = await patient({ full_name: "Karimov Ali", phone: "+998 90 123 45 67", date_of_birth: "1990-01-30" });
    const bot = await patient({ full_name: "Ali Karimov", phone: "+998901234567", date_of_birth: "1990-01-30", sex: "male", pinfl, telegram_user_id: telegram, consent_given: true, consent_given_at: new Date().toISOString() });
    const deskVisit = await visit(desk, doctors.a);
    const deskNote = await record(desk, deskVisit, doctors.a, people.drA);
    const botVisit = await visit(bot, doctors.b);
    const botNote = await record(bot, botVisit, doctors.b, people.drB);
    const deskLab = await verifiedResult(desk, 130);
    const botLab = await verifiedResult(bot, 140);
    const before = await snapshot(bot);
    const beforeDesk = await snapshot(desk);

    const p = await getPreview(desk, bot);
    expect(p.status).toBe(200);
    const pv = p.body.data as unknown as Preview;
    expect(pv.blockers).toEqual([]);
    expect(pv.duplicate.counts).toMatchObject({ appointments: 1, clinical_records: 1, lab_orders: 1, lab_results: 1, payments: 1 });
    expect(pv.canonical.counts).toMatchObject({ appointments: 1, clinical_records: 1, lab_orders: 1, lab_results: 1 });
    expect(pv.plan).toMatchObject({ pinfl: "move", telegram_user_id: "move", date_of_birth: "same", sex: "copy", consent: "copy", full_name: "differs", phone: "differs" });
    expect(pv.warnings).toEqual(expect.arrayContaining(["name_differs", "doctor_access_extends"]));
    expect(pv.doctors_gaining_access.map((d) => [d.doctor_id, d.from]).sort()).toEqual([[doctors.a, "canonical"], [doctors.b, "duplicate"]].sort());
    // Counts and plan only: no identity values in the preview — an age, never the date of birth (owner decision 2026-10-08).
    expect(JSON.stringify(pv)).not.toContain(pinfl);
    expect(JSON.stringify(pv)).not.toContain(String(telegram));
    expect(JSON.stringify(pv)).not.toContain("1990-01-30");
    expect(pv.canonical).not.toHaveProperty("date_of_birth");
    expect(pv.duplicate).not.toHaveProperty("sex");
    expect(pv.duplicate).toMatchObject({ has_date_of_birth: true, has_sex: true });
    expect(typeof (pv.canonical as unknown as { age: unknown }).age).toBe("number");
    // The browser gets a server-keyed token, not the database's md5 (which hashes the date of birth).
    expect(pv.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    // Without the explicit confirmation, nothing happens.
    const noConfirm = await read(await merge(new NextRequest("http://localhost/api/admin/patients/merge", json({ canonicalId: desk, duplicateId: bot, reason: "x y z", fingerprint: pv.fingerprint }))));
    expect(noConfirm.status).toBe(400);

    const m = await doMerge(desk, bot, pv.fingerprint);
    expect(m.status).toBe(201);
    const mergeId = m.body.data!.mergeId as string;

    // The link, and the identity the person is reached by, on the canonical record.
    const { data: rows } = await admin.from("patients").select("id, merged_into_patient_id, pinfl, telegram_user_id, date_of_birth, sex, consent_given, full_name").in("id", [desk, bot]);
    const c = rows!.find((r) => r.id === desk)!;
    const d = rows!.find((r) => r.id === bot)!;
    expect(c).toMatchObject({ merged_into_patient_id: null, pinfl, telegram_user_id: telegram, date_of_birth: "1990-01-30", sex: "male", consent_given: true, full_name: "Karimov Ali" });
    expect(d).toMatchObject({ merged_into_patient_id: desk, pinfl: null, telegram_user_id: null, date_of_birth: "1990-01-30", full_name: "Ali Karimov" });

    // Nothing recorded for either record moved or changed — authorship, versions and audit history intact.
    const after = await snapshot(bot);
    const afterDesk = await snapshot(desk);
    for (const t of Object.keys(before)) {
      if (t === "audit_events") continue;
      expect(after[t]).toEqual(before[t]);
      expect(afterDesk[t]).toEqual(beforeDesk[t]);
    }
    const oldAudit = (before.audit_events as Array<{ id: string }>).map((a) => a.id);
    expect((after.audit_events as Array<{ id: string }>).map((a) => a.id)).toEqual(expect.arrayContaining(oldAudit));
    const { data: note } = await admin.from("clinical_records").select("patient_id, author_doctor_id").eq("id", botNote).single();
    expect(note).toEqual({ patient_id: bot, author_doctor_id: doctors.b });

    // Audited on both records: ids and field names, never values or the reason.
    const { data: audit } = await admin.from("audit_events").select("patient_id, actor_id, new_values").eq("action", "patient_merged").eq("entity_id", mergeId);
    expect(audit!.map((a) => a.patient_id).sort()).toEqual([desk, bot].sort());
    expect(audit!.every((a) => a.actor_id === people.owner)).toBe(true);
    const text = idFree(audit);
    for (const secret of [pinfl, String(telegram), "pasport bilan"]) expect(text).not.toContain(secret);

    // The longitudinal record: each doctor still sees only their own visits, now across both records.
    as(people.drB, "doctor");
    const wsB = await read(await workspace(new NextRequest(`http://localhost/api/doctor/patients/${desk}`), { params: Promise.resolve({ id: desk }) }));
    expect(wsB.status).toBe(200);
    const visibleB = wsB.body.data!.record as { patient: { id: string }; appointments: Array<{ id: string }>; records: Array<{ id: string }> };
    expect(visibleB.patient.id).toBe(desk);
    expect(visibleB.appointments.map((a) => a.id)).toEqual([botVisit]);
    expect(visibleB.records.map((r) => r.id)).toEqual([botNote]);
    as(people.drA, "doctor");
    const wsA = (await read(await workspace(new NextRequest(`http://localhost/api/doctor/patients/${bot}`), { params: Promise.resolve({ id: bot }) }))).body.data!.record as typeof visibleB;
    expect(wsA.patient.id).toBe(desk); // opening the old record shows the canonical one
    expect(wsA.appointments.map((a) => a.id)).toEqual([deskVisit]);
    expect(wsA.records.map((r) => r.id)).toEqual([deskNote]);
    // Lab results (O3: the patient's whole lab history) from both records.
    const hist = await read(await labHistory(new NextRequest(`http://localhost/api/doctor/patients/${desk}/lab-history`), { params: Promise.resolve({ id: desk }) }));
    expect((hist.body.data!.results as Array<{ resultId: string }>).map((r) => r.resultId).sort()).toEqual([deskLab.resultId, botLab.resultId].sort());
    // The doctor's patient list shows the person once, as the canonical record.
    const listA = (await read(await doctorPatients(new NextRequest("http://localhost/api/doctor/patients")))).body.data!.patients as Array<{ id: string }>;
    expect(listA.filter((x) => x.id === desk || x.id === bot).map((x) => x.id)).toEqual([desk]);
    // An unrelated doctor still sees nothing.
    as(people.drC, "doctor");
    expect((await read(await workspace(new NextRequest(`http://localhost/api/doctor/patients/${desk}`), { params: Promise.resolve({ id: desk }) }))).status).toBeOneOf([403, 404]);

    // The person's Telegram identity now opens the canonical record, with both records' results.
    const resolved = await getOrCreatePatient({ clinicId: clinicA, user: { id: telegram, first_name: "Ali" } });
    expect(resolved.id).toBe(desk);
    const mini = await listPatientLabResults(clinicA, desk);
    expect(mini.results.map((r) => r.itemId).sort()).toEqual([deskLab.itemId, botLab.itemId].sort());

    // The directory lists the person once.
    as(people.reception, "receptionist");
    const dir = (await read(await patientsList(new NextRequest(`http://localhost/api/admin/patients?q=${encodeURIComponent("Karimov")}`)))).body.data!.patients as Array<{ id: string }>;
    expect(dir.map((x) => x.id)).toContain(desk);
    expect(dir.map((x) => x.id)).not.toContain(bot);

    // The merge log, then the unmerge: identity goes back; the link is gone; access is as before.
    as(people.owner, "owner");
    const log = (await read(await mergeLog())).body.data!.merges as Array<{ id: string; movedFields: string[]; copiedFields: string[] }>;
    expect(log.find((x) => x.id === mergeId)).toMatchObject({ movedFields: expect.arrayContaining(["pinfl", "telegram_user_id"]) });
    expect(JSON.stringify(log)).not.toContain(pinfl);
    const u = await unmerge(mergeId);
    expect(u.status).toBe(200);
    expect(u.body.data).toMatchObject({ restored_fields: expect.arrayContaining(["telegram_user_id", "pinfl"]), left_on_canonical: [], copied_fields_kept: expect.arrayContaining(["sex", "consent_given"]) });
    const { data: back } = await admin.from("patients").select("id, merged_into_patient_id, pinfl, telegram_user_id").in("id", [desk, bot]);
    expect(back!.find((r) => r.id === bot)).toMatchObject({ merged_into_patient_id: null, pinfl, telegram_user_id: telegram });
    expect(back!.find((r) => r.id === desk)).toMatchObject({ pinfl: null, telegram_user_id: null });
    as(people.drB, "doctor");
    expect((await read(await workspace(new NextRequest(`http://localhost/api/doctor/patients/${desk}`), { params: Promise.resolve({ id: desk }) }))).status).toBeOneOf([403, 404]);
    as(people.owner, "owner");
    expect((await unmerge(mergeId)).body.code).toBe("already_undone");
    // The log keeps both facts and cannot be rewritten or deleted.
    const { error: rewrite } = await admin.from("patient_merges").update({ reason: "boshqa" }).eq("id", mergeId);
    expect(rewrite).not.toBeNull();
    const { error: del } = await admin.from("patient_merges").delete().eq("id", mergeId);
    expect(del).not.toBeNull();
  });

  it("stops on contradictions and on the duplicate's live work, and reports each", async () => {
    const cases: Array<[Record<string, unknown>, Record<string, unknown>, string]> = [
      [{ date_of_birth: "1990-01-01" }, { date_of_birth: "1991-01-01" }, "dob_differs"],
      [{ sex: "male" }, { sex: "female" }, "sex_differs"],
      [{ pinfl: String(pin++).padStart(14, "4") }, { pinfl: String(pin++).padStart(14, "5") }, "pinfl_differs"],
      [{ document_number: `AA${pin++}` }, { document_number: `AB${pin++}` }, "document_differs"],
      [{ telegram_user_id: tg++ }, { telegram_user_id: tg++ }, "telegram_differs"],
    ];
    for (const [a, b, code] of cases) {
      const c = await patient(a);
      const d = await patient(b);
      const p = await getPreview(c, d);
      expect(p.body.data!.blockers).toEqual([code]);
      const m = await doMerge(c, d, p.body.data!.fingerprint as string);
      expect(m.status).toBe(409);
      expect(m.body.details?.blockers).toEqual([code]);
    }

    // Live work on the duplicate must be finished first.
    const c = await patient();
    const d = await patient({ date_of_birth: "1970-01-01" });
    await visit(d, doctors.a, "confirmed");
    const o = (await rpc("create_lab_order", { p_clinic_id: clinicA, p_patient_id: d, p_ordered_by: people.reception, p_source: "walk_in", p_test_ids: [test], p_panel_ids: [] })) as Array<{ lab_order_id: string }>;
    await admin.from("conversations").insert({ clinic_id: clinicA, patient_id: d, channel: "telegram", status: "open" });
    const p = (await getPreview(c, d)).body.data as unknown as Preview;
    expect(p.blockers.sort()).toEqual(["duplicate_active_appointments", "duplicate_active_lab_orders", "duplicate_open_conversations"].sort());
    expect((await doMerge(c, d, p.fingerprint)).status).toBe(409);
    expect(o.length).toBe(1);

    // Same record, unknown record, another clinic's record.
    expect((await getPreview(c, c)).body.data!.blockers).toEqual(["same_patient"]);
    expect((await getPreview(c, randomUUID())).status).toBe(404);
    const { data: other } = await admin.from("patients").insert({ clinic_id: clinicB, full_name: "B bemor" }).select("id").single();
    expect((await getPreview(c, other!.id)).status).toBe(404);
    as(people.ownerB, "owner", clinicB);
    expect((await getPreview(other!.id, c)).status).toBe(404);
  });

  it("refuses a stale preview, chains, and concurrent merges (exactly one wins)", async () => {
    const c = await patient();
    const d = await patient();
    const stale = (await getPreview(c, d)).body.data as unknown as Preview;
    await visit(c, doctors.a); // the canonical record changed after the preview
    expect((await doMerge(c, d, stale.fingerprint)).body.code).toBe("preview_changed");
    expect((await doMerge(c, d, "0".repeat(32))).body.code).toBe("validation"); // a bare database fingerprint is not accepted
    expect((await doMerge(c, d, "0".repeat(64))).body.code).toBe("preview_changed");

    // Concurrent: the same duplicate into two records, and two records into each other.
    const x = await patient();
    const y = await patient();
    const z = await patient();
    const [px, pz] = [(await getPreview(x, y)).body.data as unknown as Preview, (await getPreview(z, y)).body.data as unknown as Preview];
    const results = await Promise.all([doMerge(x, y, px.fingerprint), doMerge(z, y, pz.fingerprint)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const { count: live } = await admin.from("patient_merges").select("id", { count: "exact", head: true }).eq("duplicate_patient_id", y).is("unmerged_at", null);
    expect(live).toBe(1);

    const q = await patient();
    const r = await patient();
    const [pq, pr] = [(await getPreview(q, r)).body.data as unknown as Preview, (await getPreview(r, q)).body.data as unknown as Preview];
    const both = await Promise.all([doMerge(q, r, pq.fingerprint), doMerge(r, q, pr.fingerprint)]);
    expect(both.map((x) => x.status).sort()).toEqual([201, 409]);

    // Chains: never into a merged record, never a record others were merged into.
    const winner = results.find((x) => x.status === 201)!;
    const canonical = winner === results[0] ? x : z;
    const fresh = await patient();
    expect((await getPreview(y, fresh)).body.data!.blockers).toEqual(["canonical_merged"]);
    expect((await getPreview(fresh, y)).body.data!.blockers).toEqual(["duplicate_merged"]);
    expect((await getPreview(fresh, canonical)).body.data!.blockers).toEqual(["duplicate_has_merged_records"]);
  });

  it("a merged record takes no new work; bookings at the desk go to the canonical record", async () => {
    const c = await patient();
    const d = await patient();
    await previewAndMerge(c, d);

    const start = new Date(Date.UTC(2031, 0, 6, 5, 0) + day++ * 86_400_000);
    const { error: direct } = await admin.from("appointments").insert({ clinic_id: clinicA, patient_id: d, doctor_id: doctors.a, service_id: service, start_at: start.toISOString(), end_at: new Date(start.getTime() + 1_800_000).toISOString(), status: "confirmed", source: "walk_in" });
    expect(direct?.message).toMatch(/patient_merged/);
    const { error: order } = await admin.rpc("create_lab_order", { p_clinic_id: clinicA, p_patient_id: d, p_ordered_by: people.reception, p_source: "walk_in", p_test_ids: [test], p_panel_ids: [] });
    expect(order?.message).toMatch(/patient_merged/);
    const { error: convo } = await admin.from("conversations").insert({ clinic_id: clinicA, patient_id: d, channel: "telegram", status: "open" });
    expect(convo?.message).toMatch(/patient_merged/);

    as(people.reception, "receptionist");
    const booked = await read(
      await bookAdmin(new NextRequest("http://localhost/api/admin/appointments", json({ patientId: d, patientName: "Bemor", doctorId: doctors.a, serviceId: service, startAt: start.toISOString(), source: "admin" }))),
    );
    expect(booked.body, JSON.stringify(booked.body)).toMatchObject({ ok: true });
    const { data: appt } = await admin.from("appointments").select("patient_id").eq("doctor_id", doctors.a).eq("start_at", start.toISOString()).single();
    expect(appt!.patient_id).toBe(c);
  });

  it("only the owner or an administrator merges; nobody reaches it around the server", async () => {
    const c = await patient();
    const d = await patient();
    for (const [who, role] of [[people.manager, "manager"], [people.reception, "receptionist"], [people.drA, "doctor"], [people.lab, "lab"]] as const) {
      as(who, role);
      expect((await getPreview(c, d)).status).toBe(403);
      expect((await doMerge(c, d, "0".repeat(32))).status).toBe(403);
      expect((await read(await duplicates())).status).toBe(403);
      expect((await read(await mergeLog())).status).toBe(403);
    }
    as(people.adminUser, "admin");
    expect((await getPreview(c, d)).status).toBe(200);

    // The database refuses an actor who is not owner/admin of the clinic, even from the server.
    const fp = (await getPreview(c, d)).body.data!.fingerprint as string;
    const { error: asReception } = await admin.rpc("merge_patients", { p_clinic_id: clinicA, p_canonical_id: c, p_duplicate_id: d, p_actor: people.reception, p_reason: "test", p_fingerprint: fp });
    expect(asReception?.message).toMatch(/patient_merge_forbidden/);
    const { error: asOtherOwner } = await admin.rpc("merge_patients", { p_clinic_id: clinicA, p_canonical_id: c, p_duplicate_id: d, p_actor: people.ownerB, p_reason: "test", p_fingerprint: fp });
    expect(asOtherOwner?.message).toMatch(/patient_merge_forbidden/);

    // Signed-in and anonymous clients: no table, no function.
    const anon = createClient(URL, ANON_KEY, { auth: { persistSession: false } });
    const signed = createClient(URL, ANON_KEY, { auth: { persistSession: false } });
    expect((await signed.auth.signInWithPassword({ email: `merge-owner-${suffix}@test.local`, password: passwords.owner })).error).toBeNull();
    for (const client of [anon, signed]) {
      const { data } = await client.from("patient_merges").select("*");
      expect(data ?? []).toEqual([]);
      for (const [fn, args] of [
        ["merge_patients", { p_clinic_id: clinicA, p_canonical_id: c, p_duplicate_id: d, p_actor: people.owner, p_reason: "test", p_fingerprint: fp }],
        ["unmerge_patients", { p_clinic_id: clinicA, p_merge_id: randomUUID(), p_actor: people.owner, p_reason: "test" }],
        ["patient_merge_preview", { p_clinic_id: clinicA, p_canonical_id: c, p_duplicate_id: d }],
        ["patient_record_group", { p_patient_id: c }],
        ["patient_duplicate_candidates", { p_clinic_id: clinicA }],
      ] as const) {
        expect((await client.rpc(fn, args)).error).not.toBeNull();
      }
      const { error: link } = await client.from("patients").update({ merged_into_patient_id: c }).eq("id", d);
      const { data: still } = await admin.from("patients").select("merged_into_patient_id").eq("id", d).single();
      expect(link !== null || still!.merged_into_patient_id === null).toBe(true);
      expect(still!.merged_into_patient_id).toBeNull();
    }
  });

  it("suggests possible duplicates for review, never merging them", async () => {
    const a = await patient({ full_name: `Saidova Nodira ${suffix}`, date_of_birth: "1985-06-01" });
    const b = await patient({ full_name: `Nodira Saidova ${suffix}`, date_of_birth: "1985-06-01", telegram_user_id: tg++ });
    const pairs = (await read(await duplicates())).body.data!.pairs as Array<{ a: { id: string }; b: { id: string }; reasons: string[] }>;
    const found = pairs.find((p) => [p.a.id, p.b.id].sort().join() === [a, b].sort().join());
    expect(found?.reasons).toEqual(["same_name_and_birth_date"]);
    const { data } = await admin.from("patients").select("merged_into_patient_id").in("id", [a, b]);
    expect(data!.every((x) => x.merged_into_patient_id === null)).toBe(true);
  });
});
