import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { localDbAvailable } from "@/test/local-db";

/**
 * Structured prescribing through the real routes and the real database
 * (specification §9.2–9.3): the real guards (requireLinkedDoctor,
 * requireRoles, doctor_patient_access) run with only the session stubbed.
 *
 * Covers the clinic formulary (owner/administrator only), drug search,
 * allergies, a draft that is blocked by a recorded allergy and signed once
 * the doctor gives a reason, the read with its audit row, the national
 * number, the printed document and its public verification, cancelling,
 * templates — and that a doctor without a relationship, a doctor of another
 * clinic and operational staff get nothing.
 *
 * Every medicine is a made-up fixture name ("Qr…") kept as the test clinic's
 * own entry, so it disappears with the clinic.
 */

const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const session = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/staff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/staff")>();
  return { ...actual, getStaffContext: async () => session.ctx };
});

import { GET as searchDrugs } from "./drugs/route";
import { GET as getAllergies, POST as postAllergy } from "./patients/[id]/allergies/route";
import { PATCH as patchAllergy } from "./patients/[id]/allergies/[allergyId]/route";
import { GET as getPrescriptions, POST as postPrescription } from "./patients/[id]/prescriptions/route";
import { GET as getDocument, DELETE as deleteDraft } from "./prescriptions/[id]/route";
import { POST as signRoute } from "./prescriptions/[id]/sign/route";
import { POST as cancelRoute } from "./prescriptions/[id]/cancel/route";
import { PUT as putNationalNumber } from "./prescriptions/[id]/national-number/route";
import { GET as getTemplates, POST as postTemplate } from "./prescription-templates/route";
import { DELETE as deleteTemplate } from "./prescription-templates/[id]/route";
import { GET as getFormulary, POST as postFormulary } from "../admin/formulary/route";
import { PATCH as patchFormulary, DELETE as deleteFormulary } from "../admin/formulary/[drugId]/route";
import { verifyPrescriptionCode } from "@/lib/prescribing/prescriptions";

const describeDb = describe.skipIf(!localDbAvailable());

type Body = { ok: boolean; data?: Record<string, unknown>; code?: string; error?: string; details?: Record<string, unknown> };
type Handler = (request: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

describeDb("structured prescribing (real routes, real database)", () => {
  let admin: SupabaseClient;
  const suffix = Date.now().toString(36);
  const clinicA = randomUUID();
  const clinicB = randomUUID();
  const service = randomUUID();
  const people = { drA: randomUUID(), drC: randomUUID(), drK: randomUUID(), owner: randomUUID(), manager: randomUUID(), reception: randomUUID() };
  const doctors = { a: randomUUID(), c: randomUUID(), k: randomUUID() };
  const drug = { rx: "", otc: "", controlled: "" };
  let day = 0;

  const as = (profileId: string, role: string, clinicId = clinicA) => {
    session.ctx = { profileId, clinicId, clinicName: "Rx", clinicTimezone: "Asia/Tashkent", roles: [role], platformAdmin: false };
  };
  const asDrA = () => as(people.drA, "doctor");

  async function call(
    handler: unknown,
    opts: { method?: string; params?: Record<string, string>; body?: unknown; query?: string } = {},
  ): Promise<{ status: number; body: Body }> {
    const method = opts.method ?? (opts.body === undefined ? "GET" : "POST");
    const res = await (handler as Handler)(
      new NextRequest(`http://localhost/api/x${opts.query ? `?${opts.query}` : ""}`, {
        method,
        headers: { "content-type": "application/json" },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      }),
      { params: Promise.resolve(opts.params ?? {}) },
    );
    return { status: res.status, body: (await res.json()) as Body };
  }

  async function patient(clinicId = clinicA) {
    const { data, error } = await admin.from("patients").insert({ clinic_id: clinicId, full_name: `Rx route patient ${suffix}` }).select("id").single();
    if (error) throw new Error(error.message);
    return data.id as string;
  }

  async function visit(patientId: string, doctorId: string, status = "in_progress") {
    const start = new Date(Date.UTC(2026, 7, 3, 5, 0) + day++ * 86_400_000);
    const { data, error } = await admin
      .from("appointments")
      .insert({
        clinic_id: clinicA,
        patient_id: patientId,
        doctor_id: doctorId,
        service_id: service,
        start_at: start.toISOString(),
        end_at: new Date(start.getTime() + 30 * 60_000).toISOString(),
        status,
        source: "walk_in",
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return data.id as string;
  }

  const item = (drugId: string, extra: Record<string, unknown> = {}) => ({
    drugId,
    dose: 1,
    doseUnit: "tabletka",
    route: "ichishga",
    frequency: "3×1",
    timing: "after_food",
    days: 5,
    quantity: 15,
    ...extra,
  });

  const save = (patientId: string, appointmentId: string, items: unknown[], extra: Record<string, unknown> = {}) =>
    call(postPrescription, { params: { id: patientId }, body: { idempotencyKey: randomUUID(), appointmentId, items, ...extra } });
  const sign = (id: string, body: Record<string, unknown> = {}) => call(signRoute, { params: { id }, body });

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    await admin.from("clinics").insert([
      { id: clinicA, name: `Rx route A ${suffix}`, slug: `rx-route-a-${suffix}`, timezone: "Asia/Tashkent" },
      { id: clinicB, name: `Rx route B ${suffix}`, slug: `rx-route-b-${suffix}`, timezone: "Asia/Tashkent" },
    ]);
    for (const [name, id] of Object.entries(people)) {
      const { error } = await admin.auth.admin.createUser({ id, email: `rx-route-${name}-${suffix}@test.local`, email_confirm: true, password: `Pw-${randomUUID()}` });
      if (error) throw new Error(error.message);
      await admin.from("profiles").insert({ id, full_name: name });
    }
    await admin.from("staff_roles").insert([
      { clinic_id: clinicA, profile_id: people.drA, role: "doctor" },
      { clinic_id: clinicA, profile_id: people.drC, role: "doctor" },
      { clinic_id: clinicB, profile_id: people.drK, role: "doctor" },
      { clinic_id: clinicA, profile_id: people.owner, role: "owner" },
      { clinic_id: clinicA, profile_id: people.manager, role: "manager" },
      { clinic_id: clinicA, profile_id: people.reception, role: "receptionist" },
    ]);
    await admin.from("doctors").insert([
      { id: doctors.a, clinic_id: clinicA, profile_id: people.drA, name: `Dr A ${suffix}`, active: true },
      { id: doctors.c, clinic_id: clinicA, profile_id: people.drC, name: `Dr C ${suffix}`, active: true },
      { id: doctors.k, clinic_id: clinicB, profile_id: people.drK, name: `Dr K ${suffix}`, active: true },
    ]);
    await admin.from("services").insert([{ id: service, clinic_id: clinicA, name: `Rx route consult ${suffix}`, duration_minutes: 30, price: 1 }]);
    await admin.from("doctor_working_hours").insert(
      [doctors.a, doctors.c].flatMap((doctor_id) =>
        [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinic_id: clinicA, doctor_id, weekday, start_time: "00:00", end_time: "23:59" })),
      ),
    );

    // The clinic's own formulary, entered by its owner through the real route.
    as(people.owner, "owner");
    const create = async (body: Record<string, unknown>) => {
      const res = await call(postFormulary, { body: { aliases: [], sortOrder: 0, ...body } });
      if (res.status !== 201) throw new Error(`formulary fixture failed: ${res.status} ${res.body.error}`);
      return String(res.body.data!.drugId);
    };
    drug.rx = await create({ inn: "Qrseftriakson", tradeName: "Qrotsef", form: "flakon", strength: "1 g", drugClass: "Qrsefalosporinlar", rxOnly: true, controlled: false });
    drug.otc = await create({ inn: "Qrparatsetamol", tradeName: "Qrpanadol", form: "tabletka", strength: "500 mg", rxOnly: false, controlled: false });
    drug.controlled = await create({ inn: "Qrtramadol", form: "ampula", strength: "50 mg/ml", rxOnly: true, controlled: true });
  });

  afterAll(async () => {
    if (!admin) return;
    await admin.from("clinics").delete().in("id", [clinicA, clinicB]);
    for (const id of Object.values(people)) await admin.auth.admin.deleteUser(id);
  });

  beforeEach(asDrA);

  it("lets only the owner or administrator maintain the formulary", async () => {
    as(people.manager, "manager");
    expect((await call(getFormulary)).status).toBe(403);
    expect((await call(postFormulary, { body: { inn: "Qrbegona", aliases: [], rxOnly: false, controlled: false, sortOrder: 0 } })).status).toBe(403);
    asDrA();
    expect((await call(getFormulary)).status).toBe(403);

    as(people.owner, "owner");
    const list = await call(getFormulary);
    expect(list.status).toBe(200);
    const entries = list.body.data!.entries as Array<{ drugId: string; inn: string; controlled: boolean; clinicOwned: boolean; inFormulary: boolean; sortOrder: number }>;
    expect(entries.map((e) => e.inn).sort()).toEqual(["Qrparatsetamol", "Qrseftriakson", "Qrtramadol"]);
    expect(entries.every((e) => e.clinicOwned && e.inFormulary)).toBe(true);
    expect((list.body.data!.catalogue as { clinicEntries: number }).clinicEntries).toBe(3);

    // The legal flags are never defaulted: a body without them is refused.
    expect((await call(postFormulary, { body: { inn: "Qrbelgisiz", aliases: [], sortOrder: 0 } })).status).toBe(400);
    // Reordering; an unknown medicine and another clinic's are both simply not found.
    expect((await call(patchFormulary, { method: "PATCH", params: { drugId: drug.otc }, body: { sortOrder: 5 } })).status).toBe(200);
    expect((await call(patchFormulary, { method: "PATCH", params: { drugId: randomUUID() }, body: { sortOrder: 5 } })).status).toBe(404);

    // Removing the clinic's own entry retires it: gone from search, still there for old prescriptions.
    const extra = await call(postFormulary, { body: { inn: "Qrvaqtinchalik", aliases: [], rxOnly: false, controlled: false, sortOrder: 0 } });
    const extraId = String(extra.body.data!.drugId);
    expect((await call(deleteFormulary, { method: "DELETE", params: { drugId: extraId } })).status).toBe(200);
    const { data: retired } = await admin.from("drug_catalog").select("active").eq("id", extraId).single();
    expect(retired!.active).toBe(false);
    asDrA();
    expect(((await call(searchDrugs, { query: "q=qrvaqt" })).body.data!.drugs as unknown[]).length).toBe(0);
  });

  it("searches the catalogue for a doctor, with the legal flags, and for nobody else", async () => {
    const res = await call(searchDrugs, { query: `q=${encodeURIComponent("қрсеф")}` }); // Cyrillic typing, Latin entry
    expect(res.status).toBe(200);
    const drugs = res.body.data!.drugs as Array<{ id: string; inn: string; rxOnly: boolean; controlled: boolean; inFormulary: boolean }>;
    expect(drugs).toHaveLength(1);
    expect(drugs[0]).toMatchObject({ id: drug.rx, inn: "Qrseftriakson", rxOnly: true, controlled: false, inFormulary: true });

    const controlled = (await call(searchDrugs, { query: "q=qrtram" })).body.data!.drugs as Array<{ controlled: boolean }>;
    expect(controlled[0].controlled).toBe(true); // listed, so the screen can explain why it cannot be prescribed

    expect(((await call(searchDrugs, { query: "q=q" })).body.data!.drugs as unknown[]).length).toBe(0);
    as(people.reception, "receptionist");
    expect((await call(searchDrugs, { query: "q=qrsef" })).status).toBe(403);
    // Another clinic's doctor does not see this clinic's own entries.
    as(people.drK, "doctor", clinicB);
    expect(((await call(searchDrugs, { query: "q=qrsef" })).body.data!.drugs as unknown[]).length).toBe(0);
  });

  it("records, lists and retires allergies only for a doctor who treats the patient", async () => {
    const p = await patient();
    await visit(p, doctors.a);
    const key = randomUUID();
    const body = { idempotencyKey: key, substance: "Qrsefalosporinlar", substanceKind: "class", reaction: "Qr-toshma", severity: "severe" };

    const created = await call(postAllergy, { params: { id: p }, body });
    expect(created.status).toBe(201);
    const replay = await call(postAllergy, { params: { id: p }, body });
    expect(replay.status).toBe(200);
    expect((replay.body.data!.allergy as { id: string }).id).toBe((created.body.data!.allergy as { id: string }).id);
    expect((await call(postAllergy, { params: { id: p }, body: { ...body, substance: "Boshqa modda" } })).body.code).toBe("idempotency_key_reused");

    const list = await call(getAllergies, { params: { id: p } });
    expect(list.status).toBe(200);
    const allergies = list.body.data!.allergies as Array<{ id: string; substance: string; active: boolean; mine: boolean; severity: string; recordedBy: { name: string } }>;
    expect(allergies).toHaveLength(1);
    expect(allergies[0]).toMatchObject({ substance: "Qrsefalosporinlar", active: true, mine: true, severity: "severe" });
    expect(allergies[0].recordedBy.name).toBe(`Dr A ${suffix}`);

    // The read is audited by id; the substance and the reaction never reach the trail.
    const { data: audit } = await admin.from("audit_events").select("action, metadata, new_values").eq("clinic_id", clinicA).eq("patient_id", p);
    expect(audit!.map((a) => a.action)).toEqual(expect.arrayContaining(["patient_allergy_recorded", "patient_allergies_viewed"]));
    expect(JSON.stringify(audit)).not.toContain("Qrsefalosporinlar");
    expect(JSON.stringify(audit)).not.toContain("Qr-toshma");

    // No relationship, another clinic, operational staff: nothing — and a patient id cannot be probed.
    as(people.drC, "doctor");
    expect((await call(getAllergies, { params: { id: p } })).status).toBe(404);
    expect((await call(postAllergy, { params: { id: p }, body: { ...body, idempotencyKey: randomUUID() } })).status).toBe(404);
    as(people.drK, "doctor", clinicB);
    expect((await call(getAllergies, { params: { id: p } })).status).toBe(404);
    as(people.owner, "owner");
    expect((await call(getAllergies, { params: { id: p } })).status).toBe(403);
    as(people.reception, "receptionist");
    expect((await call(getAllergies, { params: { id: p } })).status).toBe(403);

    asDrA();
    const allergyId = allergies[0].id;
    expect((await call(patchAllergy, { method: "PATCH", params: { id: p, allergyId }, body: { reason: "x" } })).status).toBe(400);
    expect((await call(patchAllergy, { method: "PATCH", params: { id: p, allergyId }, body: { reason: "Tasdiqlanmadi" } })).status).toBe(200);
    expect((await call(patchAllergy, { method: "PATCH", params: { id: p, allergyId }, body: { reason: "Yana bir bor" } })).status).toBe(404);
    const after = (await call(getAllergies, { params: { id: p } })).body.data!.allergies as Array<{ active: boolean; inactiveReason: string }>;
    expect(after[0]).toMatchObject({ active: false, inactiveReason: "Tasdiqlanmadi" });
  });

  it("writes, blocks on an allergy, signs with a reason, and shows the prescription only where it may be read", async () => {
    const p = await patient();
    const appointment = await visit(p, doctors.a);
    await call(postAllergy, { params: { id: p }, body: { idempotencyKey: randomUUID(), substance: "Қрсефтриаксон", substanceKind: "inn", severity: "severe" } });
    const allergyId = ((await call(getAllergies, { params: { id: p } })).body.data!.allergies as Array<{ id: string }>)[0].id;

    // A controlled medicine cannot even be drafted.
    const refused = await save(p, appointment, [item(drug.otc), item(drug.controlled)]);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("controlled_not_allowed");
    expect(refused.body.details).toEqual({ positions: [2] });
    // Validation happens before anything is stored.
    expect((await save(p, appointment, [])).status).toBe(400);
    expect((await save(p, appointment, [item(drug.otc, { dose: -1 })])).status).toBe(400);
    expect((await save(p, appointment, [item(drug.otc, { days: 0 })])).status).toBe(400);

    const saved = await save(p, appointment, [item(drug.rx, { doseUnit: "g", route: "mushak ichiga", frequency: "2×1" }), item(drug.otc)]);
    expect(saved.status).toBe(200);
    const id = String((saved.body.data!.prescription as { id: string }).id);

    // Signing is blocked by the recorded allergy and says which item and which allergy.
    const blocked = await sign(id);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("allergy_conflict");
    expect(blocked.body.details).toEqual({ conflicts: [{ position: 1, drugId: drug.rx, allergyIds: [allergyId] }] });

    // Other doctors cannot sign, overwrite or even see the draft.
    as(people.drC, "doctor");
    expect((await sign(id)).status).toBe(404);
    expect((await call(getPrescriptions, { params: { id: p } })).status).toBe(404);
    asDrA();

    const resaved = await save(
      p,
      appointment,
      [item(drug.rx, { doseUnit: "g", route: "mushak ichiga", frequency: "2×1", allergyOverrideReason: "Qr-sabab: muqobil yo‘q" }), item(drug.otc)],
      { prescriptionId: id },
    );
    expect(resaved.status).toBe(200);
    const done = await sign(id);
    expect(done.status).toBe(200);
    expect(done.body.data!.prescription).toMatchObject({ id, nationalRxRequired: true, replacedId: null });
    expect((await sign(id)).body.code).toBe("not_a_draft");

    const list = await call(getPrescriptions, { params: { id: p } });
    expect(list.status).toBe(200);
    const [rx] = list.body.data!.prescriptions as Array<Record<string, unknown> & { items: Array<Record<string, unknown>> }>;
    expect(rx).toMatchObject({ id, status: "signed", mine: true, nationalRxRequired: true, nationalRxNumber: null, appointmentId: appointment });
    expect((rx.author as { name: string }).name).toBe(`Dr A ${suffix}`);
    expect(rx.items.map((i) => [i.position, i.inn, i.rxOnly, i.dose, i.doseUnit, i.frequency, i.days, i.quantity])).toEqual([
      [1, "Qrseftriakson", true, 1, "g", "2×1", 5, 15],
      [2, "Qrparatsetamol", false, 1, "tabletka", "3×1", 5, 15],
    ]);
    expect(rx.items[0]).toMatchObject({ tradeName: "Qrotsef", allergyOverrideReason: "Qr-sabab: muqobil yo‘q", allergyIds: [allergyId] });
    expect((list.body.data!.catalogue as { clinicEntries: number }).clinicEntries).toBeGreaterThanOrEqual(3);

    // The signed prescription is the doctor's clinical record of that consultation.
    const { data: records } = await admin.from("clinical_records").select("record_type, author_doctor_id, summary").eq("appointment_id", appointment);
    expect(records).toEqual([{ record_type: "prescription", author_doctor_id: doctors.a, summary: "Retsept: Qrseftriakson 1 g; Qrparatsetamol 500 mg" }]);

    // Read and write are audited with ids only.
    const { data: audit } = await admin.from("audit_events").select("action, metadata, new_values").eq("clinic_id", clinicA).eq("patient_id", p);
    expect(audit!.map((a) => a.action)).toEqual(
      expect.arrayContaining(["prescription_signed", "prescription_allergy_override", "patient_prescriptions_viewed"]),
    );
    for (const secret of ["Qrseftriakson", "Qrparatsetamol", "Qr-sabab", "mushak"]) expect(JSON.stringify(audit)).not.toContain(secret);
    // Dr C's refused attempts above were logged too (by the probed id, never as a patient reference).
    const { data: denied } = await admin.from("audit_events").select("actor_id").eq("clinic_id", clinicA).eq("action", "patient_clinical_access_denied").eq("entity_id", p);
    expect(denied!.some((d) => d.actor_id === people.drC)).toBe(true);

    // Nobody without a clinical relationship reads it: another doctor, another clinic, management, reception.
    as(people.drC, "doctor");
    expect((await call(getPrescriptions, { params: { id: p } })).status).toBe(404);
    expect((await call(getDocument, { params: { id } })).status).toBe(404);
    as(people.drK, "doctor", clinicB);
    expect((await call(getPrescriptions, { params: { id: p } })).status).toBe(404);
    expect((await call(getDocument, { params: { id } })).status).toBe(404);
    as(people.owner, "owner");
    expect((await call(getPrescriptions, { params: { id: p } })).status).toBe(403);
    as(people.reception, "receptionist");
    expect((await call(getPrescriptions, { params: { id: p } })).status).toBe(403);
    expect((await sign(id)).status).toBe(403);
  });

  it("records the national number, prints with a verifiable code, and cancels", async () => {
    const p = await patient();
    const appointment = await visit(p, doctors.a, "completed");
    const saved = await save(p, appointment, [item(drug.rx)]);
    const id = String((saved.body.data!.prescription as { id: string }).id);

    // A draft has no document; a draft can be discarded, a signed prescription cannot.
    expect((await call(getDocument, { params: { id } })).body.code).toBe("not_signed");
    expect((await sign(id)).status).toBe(200);
    expect((await call(deleteDraft, { method: "DELETE", params: { id } })).body.code).toBe("not_a_draft");

    expect((await call(putNationalNumber, { method: "PUT", params: { id }, body: { number: "!" } })).status).toBe(400);
    expect((await call(putNationalNumber, { method: "PUT", params: { id }, body: { number: "er-2026/0007" } })).status).toBe(200);

    const doc = await call(getDocument, { params: { id } });
    expect(doc.status).toBe(200);
    const document = doc.body.data!.document as {
      prescription: { status: string; nationalRxNumber: string; nationalRxRequired: boolean; items: unknown[] };
      clinic: { name: string };
      patient: { fullName: string };
      verificationPath: string;
    };
    expect(document.prescription).toMatchObject({ status: "signed", nationalRxNumber: "ER-2026/0007", nationalRxRequired: false });
    expect(document.clinic.name).toBe(`Rx route A ${suffix}`);
    expect(document.patient.fullName).toBe(`Rx route patient ${suffix}`);
    expect(document.verificationPath).toMatch(/^\/v\/[A-Za-z0-9_-]{20}$/);

    // The public check: genuine and current — and nothing about medicines or the patient.
    const code = document.verificationPath.slice(3);
    const verified = await verifyPrescriptionCode(code);
    expect(verified).toMatchObject({ clinicName: `Rx route A ${suffix}`, doctorName: `Dr A ${suffix}`, status: "valid", clinicTimezone: "Asia/Tashkent" });
    expect(Object.keys(verified!).sort()).toEqual(["clinicName", "clinicTimezone", "doctorName", "signedAt", "status"]);
    expect(await verifyPrescriptionCode(`${code.slice(0, 19)}${code.endsWith("A") ? "B" : "A"}`)).toBeNull();
    expect(await verifyPrescriptionCode("../../etc/passwd")).toBeNull();

    expect((await call(cancelRoute, { params: { id }, body: { reason: "x" } })).status).toBe(400);
    as(people.drC, "doctor");
    expect((await call(cancelRoute, { params: { id }, body: { reason: "Boshqa shifokor" } })).status).toBe(404);
    asDrA();
    expect((await call(cancelRoute, { params: { id }, body: { reason: "Bemor rad etdi" } })).status).toBe(200);
    expect((await verifyPrescriptionCode(code))!.status).toBe("cancelled");
    expect((await call(putNationalNumber, { method: "PUT", params: { id }, body: { number: "ER-2026/0008" } })).body.code).toBe("not_current");

    const [rx] = (await call(getPrescriptions, { params: { id: p } })).body.data!.prescriptions as Array<Record<string, unknown>>;
    expect(rx).toMatchObject({ status: "cancelled", cancelReason: "Bemor rad etdi" });

    // A draft of the doctor's own can be discarded.
    const draft = await save(p, appointment, [item(drug.otc)]);
    const draftId = String((draft.body.data!.prescription as { id: string }).id);
    expect((await call(deleteDraft, { method: "DELETE", params: { id: draftId } })).status).toBe(200);
    expect(((await call(getPrescriptions, { params: { id: p } })).body.data!.prescriptions as unknown[]).length).toBe(1);
  });

  it("replaces a signed prescription only with a reason", async () => {
    const p = await patient();
    const appointment = await visit(p, doctors.a);
    const first = String(((await save(p, appointment, [item(drug.otc)])).body.data!.prescription as { id: string }).id);
    expect((await sign(first)).status).toBe(200);

    const next = String(((await save(p, appointment, [item(drug.otc, { days: 3, quantity: 9 })], { replacesId: first })).body.data!.prescription as { id: string }).id);
    expect((await sign(next)).body.code).toBe("replace_reason_required");
    const done = await sign(next, { replaceReason: "Kurs qisqartirildi" });
    expect(done.status).toBe(200);
    expect((done.body.data!.prescription as { replacedId: string }).replacedId).toBe(first);

    const list = (await call(getPrescriptions, { params: { id: p } })).body.data!.prescriptions as Array<Record<string, unknown>>;
    expect(list.find((r) => r.id === first)).toMatchObject({ status: "replaced", replacedById: next });
    expect(list.find((r) => r.id === next)).toMatchObject({ status: "signed", replacesId: first, replaceReason: "Kurs qisqartirildi" });
  });

  it("keeps templates to the doctor who made them", async () => {
    const name = `Qr shablon ${suffix}`;
    const saved = await call(postTemplate, { body: { name, items: [item(drug.otc)] } });
    expect(saved.status).toBe(201);
    const templateId = String((saved.body.data!.template as { id: string }).id);
    // Saving under the same name replaces it; a controlled medicine never goes into a template.
    expect(String(((await call(postTemplate, { body: { name: name.toUpperCase(), items: [item(drug.otc), item(drug.rx)] } })).body.data!.template as { id: string }).id)).toBe(templateId);
    expect((await call(postTemplate, { body: { name: "Qr nazorat", items: [item(drug.controlled)] } })).body.code).toBe("controlled_not_allowed");

    const mine = (await call(getTemplates)).body.data!.templates as Array<{ id: string; items: Array<{ inn: string; available: boolean }> }>;
    expect(mine).toHaveLength(1);
    expect(mine[0].items.map((i) => [i.inn, i.available])).toEqual([
      ["Qrparatsetamol", true],
      ["Qrseftriakson", true],
    ]);

    as(people.drC, "doctor");
    expect((await call(getTemplates)).body.data!.templates).toEqual([]);
    expect((await call(deleteTemplate, { method: "DELETE", params: { id: templateId } })).status).toBe(404);
    as(people.reception, "receptionist");
    expect((await call(getTemplates)).status).toBe(403);
    asDrA();
    expect((await call(deleteTemplate, { method: "DELETE", params: { id: templateId } })).status).toBe(200);
  });
});
