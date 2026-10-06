import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { localDbAvailable } from "@/test/local-db";

/**
 * Structured result entry (Phase 8) through the real routes, guards and
 * database: who may enter (lab; a doctor only for their own / referred
 * patient), typed values validated on the server, flags from configuration
 * only, the audited read, submit / discard, and tenancy.
 */

const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const session = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/staff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/staff")>();
  return { ...actual, getStaffContext: async () => session.ctx };
});

import { GET as getEntry, PUT as saveEntry } from "./items/[id]/result/route";
import { POST as resultAction } from "./results/[id]/route";

const describeDb = describe.skipIf(!localDbAvailable());

type Body = { ok: boolean; data?: Record<string, unknown>; code?: string; error?: string };
type Entry = {
  item: { status: string };
  patient: { fullName: string; sex: string | null };
  result: { id: string; status: string; mine: boolean; labComment: string | null } | null;
  parameters: Array<{ id: string; code: string; unit: string | null; range: { low: number | null; high: number | null } | null; value: { numeric: string | null; boolean: boolean | null; text: string | null; flag: string } | null }>;
};

const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Body });

describeDb("lab result entry routes (real database)", () => {
  let admin: SupabaseClient;
  const suffix = Date.now().toString(36);
  const clinicA = randomUUID();
  const clinicB = randomUUID();
  const people = { owner: randomUUID(), reception: randomUUID(), lab: randomUUID(), lab2: randomUUID(), drA: randomUUID(), drC: randomUUID(), labB: randomUUID() };
  const doctors = { a: randomUUID(), c: randomUUID() };
  const service = randomUUID();
  let test = "";
  const p = { hgb: "", pos: "", color: "" };
  let day = 0;

  const as = (profileId: string, role: string, clinicId = clinicA) => {
    session.ctx = { profileId, clinicId, clinicName: "Results", clinicTimezone: "Asia/Tashkent", roles: [role], platformAdmin: false };
  };
  const entry = async (itemId: string) =>
    read(await getEntry(new NextRequest(`http://localhost/api/lab/items/${itemId}/result`), { params: Promise.resolve({ id: itemId }) }));
  const save = async (itemId: string, body: unknown) =>
    read(
      await saveEntry(
        new NextRequest(`http://localhost/api/lab/items/${itemId}/result`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        { params: Promise.resolve({ id: itemId }) },
      ),
    );
  const action = async (resultId: string, a: string) =>
    read(
      await resultAction(
        new NextRequest(`http://localhost/api/lab/results/${resultId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: a }) }),
        { params: Promise.resolve({ id: resultId }) },
      ),
    );

  /** A patient of clinic A with the test ordered, collected and received. */
  async function receivedItem() {
    const { data: patient } = await admin.from("patients").insert({ clinic_id: clinicA, full_name: `Natija bemor ${suffix} ${day}`, date_of_birth: "1988-02-02", sex: "male" }).select("id").single();
    const { data: order, error } = await admin.rpc("create_lab_order", {
      p_clinic_id: clinicA, p_patient_id: patient!.id, p_ordered_by: people.reception, p_source: "walk_in", p_test_ids: [test], p_panel_ids: [],
    });
    if (error) throw new Error(error.message);
    const orderId = (order as Array<{ lab_order_id: string }>)[0].lab_order_id;
    const { data: item } = await admin.from("lab_order_items").select("id").eq("order_id", orderId).single();
    const { data: sample } = await admin.rpc("collect_lab_sample", { p_clinic_id: clinicA, p_order_id: orderId, p_item_ids: [item!.id], p_collected_by: people.reception });
    await admin.rpc("receive_lab_sample", { p_clinic_id: clinicA, p_sample_id: (sample as Array<{ lab_sample_id: string }>)[0].lab_sample_id, p_received_by: people.lab2 });
    return { itemId: item!.id as string, patientId: patient!.id as string };
  }

  async function visit(patientId: string, doctorId: string) {
    const start = new Date(Date.UTC(2026, 4, 4, 5, 0) + day++ * 86_400_000);
    const { error } = await admin.from("appointments").insert({
      clinic_id: clinicA, patient_id: patientId, doctor_id: doctorId, service_id: service,
      start_at: start.toISOString(), end_at: new Date(start.getTime() + 30 * 60_000).toISOString(), status: "completed", source: "walk_in",
    });
    if (error) throw new Error(error.message);
  }

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    await admin.from("clinics").insert([
      { id: clinicA, name: `Results A ${suffix}`, slug: `results-a-${suffix}`, timezone: "Asia/Tashkent" },
      { id: clinicB, name: `Results B ${suffix}`, slug: `results-b-${suffix}`, timezone: "Asia/Tashkent" },
    ]);
    for (const [name, id] of Object.entries(people)) {
      const { error } = await admin.auth.admin.createUser({ id, email: `results-${name}-${suffix}@test.local`, email_confirm: true, password: `Pw-${randomUUID()}` });
      if (error) throw new Error(error.message);
      await admin.from("profiles").insert({ id, full_name: name });
    }
    await admin.from("staff_roles").insert([
      { clinic_id: clinicA, profile_id: people.owner, role: "owner" },
      { clinic_id: clinicA, profile_id: people.reception, role: "receptionist" },
      { clinic_id: clinicA, profile_id: people.lab, role: "lab" },
      { clinic_id: clinicA, profile_id: people.lab2, role: "lab" },
      { clinic_id: clinicA, profile_id: people.drA, role: "doctor" },
      { clinic_id: clinicA, profile_id: people.drC, role: "doctor" },
      { clinic_id: clinicB, profile_id: people.labB, role: "lab" },
    ]);
    await admin.from("doctors").insert([
      { id: doctors.a, clinic_id: clinicA, profile_id: people.drA, name: `Dr A ${suffix}`, active: true },
      { id: doctors.c, clinic_id: clinicA, profile_id: people.drC, name: `Dr C ${suffix}`, active: true },
    ]);
    await admin.from("services").insert({ id: service, clinic_id: clinicA, name: `Results consult ${suffix}`, duration_minutes: 30, price: 1 });
    await admin.from("doctor_working_hours").insert(
      [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinic_id: clinicA, doctor_id: doctors.a, weekday, start_time: "00:00", end_time: "23:59" })),
    );
    const { data: t } = await admin.from("lab_tests").insert({ clinic_id: clinicA, code: `RCBC${suffix}`, name: `Natija CBC ${suffix}`, sample_type: "Qon", price: 1000 }).select("id").single();
    test = t!.id;
    const { data: params } = await admin
      .from("lab_test_parameters")
      .insert(
        [
          { clinic_id: clinicA, test_id: test, code: "HGB", name: "Gemoglobin", value_type: "numeric", unit: "g/L", decimals: 0, choices: null, sort_order: 1 },
          { clinic_id: clinicA, test_id: test, code: "POS", name: "Antigen", value_type: "boolean", unit: null, decimals: null, choices: null, sort_order: 2 },
          { clinic_id: clinicA, test_id: test, code: "COLOR", name: "Rangi", value_type: "choice", unit: null, decimals: null, choices: ["Sariq", "Qizil"], sort_order: 3 },
        ],
      )
      .select("id, code");
    for (const row of params!) p[row.code.toLowerCase() as keyof typeof p] = row.id;
    await admin.from("lab_reference_ranges").insert([
      { clinic_id: clinicA, parameter_id: p.hgb, sex: "male", low: 130, high: 170, normal_text: null, critical_low: 70, critical_high: 200 },
      { clinic_id: clinicA, parameter_id: p.pos, sex: null, low: null, high: null, normal_text: "false", critical_low: null, critical_high: null },
    ]);
  });

  afterAll(async () => {
    if (!admin) return;
    await admin.from("clinics").delete().in("id", [clinicA, clinicB]);
    for (const id of Object.values(people)) await admin.auth.admin.deleteUser(id);
  });

  beforeEach(() => as(people.lab, "lab"));

  it("is for lab staff and linked doctors only; operational roles get no values", async () => {
    const { itemId } = await receivedItem();
    for (const [id, role] of [[people.owner, "owner"], [people.reception, "receptionist"]] as const) {
      as(id, role);
      expect((await entry(itemId)).status, role).toBe(403);
      expect((await save(itemId, { values: [] })).status, role).toBe(403);
    }
    session.ctx = null;
    expect((await entry(itemId)).status).toBe(401);
  });

  it("shows parameters with the patient's configured range, saves typed values and returns the database's flags", async () => {
    const { itemId } = await receivedItem();
    const before = (await entry(itemId)).body.data!.entry as Entry;
    expect(before.result).toBeNull();
    expect(before.patient.sex).toBe("male");
    expect(before.parameters.map((x) => x.code)).toEqual(["HGB", "POS", "COLOR"]);
    expect(before.parameters[0]).toMatchObject({ unit: "g/L", range: { low: 130, high: 170 }, value: null });

    const saved = await save(itemId, {
      values: [
        { parameterId: p.hgb, value: "118" },
        { parameterId: p.pos, value: true },
      ],
      labComment: "Lipemik namuna",
    });
    expect(saved.status).toBe(201);
    const after = (await entry(itemId)).body.data!.entry as Entry;
    expect(after.result).toMatchObject({ status: "draft", mine: true, labComment: "Lipemik namuna" });
    const byCode = Object.fromEntries(after.parameters.map((x) => [x.code, x]));
    expect(byCode.HGB.value).toMatchObject({ numeric: "118", flag: "low" });
    expect(byCode.POS.value).toMatchObject({ boolean: true, flag: "abnormal" });
    expect(byCode.COLOR.value).toBeNull();

    // Reading values is audited, with no values in the audit row.
    const { data: audit } = await admin.from("audit_events").select("actor_id, metadata").eq("action", "lab_result_viewed").eq("entity_id", after.result!.id);
    expect(audit!.length).toBe(1);
    expect(audit![0].actor_id).toBe(people.lab);
    expect(JSON.stringify(audit)).not.toContain("118");
  });

  it("refuses invalid values on the server (nothing stored)", async () => {
    const { itemId } = await receivedItem();
    for (const values of [
      [{ parameterId: p.hgb, value: "baland" }],
      [{ parameterId: p.hgb, value: "118.5" }],
      [{ parameterId: p.pos, value: "ha" }],
      [{ parameterId: p.color, value: "Ko‘k" }],
      [{ parameterId: randomUUID(), value: "1" }],
    ]) {
      const res = await save(itemId, { values });
      expect(res.status, JSON.stringify(values)).toBe(400);
      expect(res.body.code).toBe("invalid_value");
    }
    expect((await save(itemId, { values: [{ parameterId: "x", value: "1" }] })).status).toBe(400);
    const { count } = await admin.from("lab_results").select("id", { count: "exact", head: true }).eq("order_item_id", itemId);
    expect(count).toBe(0);
  });

  it("submits a complete draft for verification; then it cannot be edited or discarded", async () => {
    const { itemId } = await receivedItem();
    const id = (await save(itemId, { values: [{ parameterId: p.hgb, value: "150" }] })).body.data!.resultId as string;
    expect((await action(id, "submit")).body.code).toBe("result_incomplete");
    await save(itemId, { values: [{ parameterId: p.pos, value: false }, { parameterId: p.color, value: "Sariq" }] });

    as(people.lab2, "lab");
    expect((await save(itemId, { values: [{ parameterId: p.hgb, value: "151" }] })).body.code).toBe("draft_owned");
    expect((await action(id, "submit")).body.code).toBe("draft_owned");

    as(people.lab, "lab");
    expect((await action(id, "submit")).body.data).toEqual({ changed: true });
    expect((await admin.from("lab_order_items").select("status").eq("id", itemId).single()).data!.status).toBe("resulted");
    expect((await save(itemId, { values: [{ parameterId: p.hgb, value: "152" }] })).body.code).toBe("result_submitted");
    expect((await action(id, "discard")).body.code).toBe("result_submitted");
  });

  it("lets a colleague discard a draft, then enter their own", async () => {
    const { itemId } = await receivedItem();
    const id = (await save(itemId, { values: [{ parameterId: p.hgb, value: "140" }] })).body.data!.resultId as string;
    as(people.lab2, "lab");
    expect((await action(id, "discard")).body.data).toEqual({ changed: true });
    expect((await save(itemId, { values: [{ parameterId: p.hgb, value: "141" }] })).status).toBe(201);
    const view = (await entry(itemId)).body.data!.entry as Entry;
    expect(view.result).toMatchObject({ mine: true });
  });

  it("waits for the lab to receive the sample", async () => {
    const { data: patient } = await admin.from("patients").insert({ clinic_id: clinicA, full_name: `Kutilmoqda ${suffix}`, date_of_birth: "1990-01-01" }).select("id").single();
    const { data: order } = await admin.rpc("create_lab_order", {
      p_clinic_id: clinicA, p_patient_id: patient!.id, p_ordered_by: people.reception, p_source: "walk_in", p_test_ids: [test], p_panel_ids: [],
    });
    const { data: item } = await admin.from("lab_order_items").select("id").eq("order_id", (order as Array<{ lab_order_id: string }>)[0].lab_order_id).single();
    expect((await save(item!.id, { values: [{ parameterId: p.hgb, value: "140" }] })).body.code).toBe("sample_not_received");
  });

  it("admits a doctor only for their own patient", async () => {
    const { itemId, patientId } = await receivedItem();
    as(people.drA, "doctor");
    expect((await entry(itemId)).status).toBe(404); // no relationship yet
    expect((await save(itemId, { values: [{ parameterId: p.hgb, value: "140" }] })).status).toBe(404);
    await visit(patientId, doctors.a);
    expect((await entry(itemId)).status).toBe(200);
    expect((await save(itemId, { values: [{ parameterId: p.hgb, value: "140" }] })).status).toBe(201);
    as(people.drC, "doctor");
    expect((await entry(itemId)).status).toBe(404);
  });

  it("never crosses clinics", async () => {
    const { itemId } = await receivedItem();
    const id = (await save(itemId, { values: [{ parameterId: p.hgb, value: "140" }] })).body.data!.resultId as string;
    as(people.labB, "lab", clinicB);
    expect((await entry(itemId)).status).toBe(404);
    expect((await save(itemId, { values: [{ parameterId: p.hgb, value: "1" }] })).status).toBe(404);
    expect((await action(id, "discard")).status).toBe(404);
    expect((await action(id, "submit")).status).toBe(404);
    const { data } = await admin.from("lab_results").select("status").eq("id", id).single();
    expect(data!.status).toBe("draft");
  });
});
