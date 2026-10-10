import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { localDbAvailable } from "@/test/local-db";

/**
 * Verification and corrections (Phase 9) through the real routes, guards and
 * database: second person, the clinic's verifier setting, return for rework,
 * corrections as new versions with history, doctor ownership (a doctor reads
 * but never changes someone else's result), and tenancy.
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
import { GET as getQueue } from "./queue/route";
import { GET as doctorResult } from "../doctor/patients/[id]/lab-results/[itemId]/route";

const describeDb = describe.skipIf(!localDbAvailable());

type Body = { ok: boolean; data?: Record<string, unknown>; code?: string };
type Entry = {
  result: { id: string; status: string; version: number; correctionReason: string | null; enteredByName: string | null; verifiedByName: string | null } | null;
  parameters: Array<{ code: string; value: { numeric: string | null } | null }>;
  versions: Array<{ id: string; version: number; status: string; verifiedByName: string | null; values: Array<{ parameter: string; value: string }> }>;
  can: { verify: boolean; giveBack: boolean; correct: boolean };
};

const json = (url: string, method: string, body: unknown) =>
  new NextRequest(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Body });

describeDb("lab result verification routes (real database)", () => {
  let admin: SupabaseClient;
  const suffix = Date.now().toString(36);
  const clinicA = randomUUID();
  const clinicB = randomUUID();
  const people = {
    owner: randomUUID(), reception: randomUUID(), tech: randomUUID(), reviewer: randomUUID(),
    drA: randomUUID(), drC: randomUUID(), labB: randomUUID(),
  };
  const doctors = { a: randomUUID(), c: randomUUID() };
  const service = randomUUID();
  let test = "";
  let hgb = "";
  let day = 0;

  const as = (profileId: string, role: string, clinicId = clinicA) => {
    session.ctx = { profileId, clinicId, clinicName: "Verify", clinicTimezone: "Asia/Tashkent", roles: [role], platformAdmin: false };
  };
  const entry = async (itemId: string) => {
    const res = await read(await getEntry(new NextRequest(`http://localhost/api/lab/items/${itemId}/result`), { params: Promise.resolve({ id: itemId }) }));
    return { status: res.status, entry: res.body.data?.entry as Entry };
  };
  const save = async (itemId: string, value: string) =>
    read(await saveEntry(json(`http://localhost/api/lab/items/${itemId}/result`, "PUT", { values: [{ parameterId: hgb, value }] }), { params: Promise.resolve({ id: itemId }) }));
  const act = async (resultId: string, body: Record<string, unknown>) =>
    read(await resultAction(json(`http://localhost/api/lab/results/${resultId}`, "POST", body), { params: Promise.resolve({ id: resultId }) }));
  const settings = (verifiers: string) =>
    admin.from("app_settings").upsert({ clinic_id: clinicA, key: "lab", value: { paymentPolicy: "not_required", releaseToPatient: true, verifiers } });

  async function receivedItem() {
    const { data: patient } = await admin.from("patients").insert({ clinic_id: clinicA, full_name: `Tasdiq bemor ${suffix} ${day++}`, date_of_birth: "1975-03-03" }).select("id").single();
    const { data: order } = await admin.rpc("create_lab_order", {
      p_clinic_id: clinicA, p_patient_id: patient!.id, p_ordered_by: people.reception, p_source: "walk_in", p_test_ids: [test], p_panel_ids: [],
    });
    const orderId = (order as Array<{ lab_order_id: string }>)[0].lab_order_id;
    const { data: item } = await admin.from("lab_order_items").select("id").eq("order_id", orderId).single();
    const { data: sample } = await admin.rpc("collect_lab_sample", { p_clinic_id: clinicA, p_order_id: orderId, p_item_ids: [item!.id], p_collected_by: people.reception });
    await admin.rpc("receive_lab_sample", { p_clinic_id: clinicA, p_sample_id: (sample as Array<{ lab_sample_id: string }>)[0].lab_sample_id, p_received_by: people.tech });
    return { itemId: item!.id as string, patientId: patient!.id as string, orderId };
  }

  /** The tech enters and submits HGB = value; returns the result id. */
  async function submitted(value = "140") {
    const r = await receivedItem();
    as(people.tech, "lab");
    const id = (await save(r.itemId, value)).body.data!.resultId as string;
    expect((await act(id, { action: "submit" })).status).toBe(200);
    return { ...r, id };
  }

  async function visit(patientId: string, doctorId: string) {
    const start = new Date(Date.UTC(2026, 5, 4, 5, 0) + day++ * 86_400_000);
    const { error } = await admin.from("appointments").insert({
      clinic_id: clinicA, patient_id: patientId, doctor_id: doctorId, service_id: service,
      start_at: start.toISOString(), end_at: new Date(start.getTime() + 30 * 60_000).toISOString(), status: "completed", source: "walk_in",
    });
    if (error) throw new Error(error.message);
  }

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    await admin.from("clinics").insert([
      { id: clinicA, name: `Verify A ${suffix}`, slug: `verify-a-${suffix}`, timezone: "Asia/Tashkent" },
      { id: clinicB, name: `Verify B ${suffix}`, slug: `verify-b-${suffix}`, timezone: "Asia/Tashkent" },
    ]);
    for (const [name, id] of Object.entries(people)) {
      const { error } = await admin.auth.admin.createUser({ id, email: `verify-${name}-${suffix}@test.local`, email_confirm: true, password: `Pw-${randomUUID()}` });
      if (error) throw new Error(error.message);
      await admin.from("profiles").insert({ id, full_name: name });
    }
    await admin.from("staff_roles").insert([
      { clinic_id: clinicA, profile_id: people.owner, role: "owner" },
      { clinic_id: clinicA, profile_id: people.reception, role: "receptionist" },
      { clinic_id: clinicA, profile_id: people.tech, role: "lab" },
      { clinic_id: clinicA, profile_id: people.reviewer, role: "lab" },
      { clinic_id: clinicA, profile_id: people.drA, role: "doctor" },
      { clinic_id: clinicA, profile_id: people.drC, role: "doctor" },
      { clinic_id: clinicB, profile_id: people.labB, role: "lab" },
    ]);
    await admin.from("doctors").insert([
      { id: doctors.a, clinic_id: clinicA, profile_id: people.drA, name: `Dr A ${suffix}`, active: true },
      { id: doctors.c, clinic_id: clinicA, profile_id: people.drC, name: `Dr C ${suffix}`, active: true },
    ]);
    await admin.from("services").insert({ id: service, clinic_id: clinicA, name: `Verify consult ${suffix}`, duration_minutes: 30, price: 1 });
    await admin.from("doctor_working_hours").insert(
      [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinic_id: clinicA, doctor_id: doctors.a, weekday, start_time: "00:00", end_time: "23:59" })),
    );
    const { data: t } = await admin.from("lab_tests").insert({ clinic_id: clinicA, code: `VER${suffix}`, name: `Tasdiq HB ${suffix}`, sample_type: "Qon", price: 1000 }).select("id").single();
    test = t!.id;
    const { data: p } = await admin.from("lab_test_parameters").insert({ clinic_id: clinicA, test_id: test, code: "HGB", name: "Gemoglobin", value_type: "numeric", unit: "g/L" }).select("id").single();
    hgb = p!.id;
    await admin.from("lab_reference_ranges").insert({ clinic_id: clinicA, parameter_id: hgb, low: 120, high: 160 });
  });

  afterAll(async () => {
    if (!admin) return;
    await admin.from("clinics").delete().in("id", [clinicA, clinicB]);
    for (const id of Object.values(people)) await admin.auth.admin.deleteUser(id);
  });

  beforeEach(async () => {
    as(people.reviewer, "lab");
    await admin.from("app_settings").delete().eq("clinic_id", clinicA).eq("key", "lab");
  });

  it("a second person verifies; the author cannot; the order completes and stays visible as recently completed", async () => {
    const { id, itemId, orderId } = await submitted();
    expect((await entry(itemId)).entry.can).toEqual({ verify: false, giveBack: true, correct: false }); // the author
    expect((await act(id, { action: "verify" })).body.code).toBe("second_person_required");

    as(people.reviewer, "lab");
    expect((await entry(itemId)).entry.can).toEqual({ verify: true, giveBack: true, correct: false });
    expect((await act(id, { action: "verify" })).body.data).toEqual({ changed: true });
    expect((await act(id, { action: "verify" })).body.data).toEqual({ changed: false });
    const view = (await entry(itemId)).entry;
    expect(view.result).toMatchObject({ status: "verified", enteredByName: "tech", verifiedByName: "reviewer" });
    expect(view.can.correct).toBe(true);
    const { data: order } = await admin.from("lab_orders").select("status").eq("id", orderId).single();
    expect(order!.status).toBe("completed");
    const queue = (await read(await getQueue())).body.data!.orders as Array<{ id: string; status: string }>;
    expect(queue.find((o) => o.id === orderId)).toMatchObject({ status: "completed" });
  });

  it("operational roles cannot verify, return or correct", async () => {
    const { id } = await submitted();
    for (const [p, role] of [[people.owner, "owner"], [people.reception, "receptionist"]] as const) {
      as(p, role);
      for (const action of ["verify", "return"]) expect((await act(id, { action })).status, `${role} ${action}`).toBe(403);
    }
    session.ctx = null;
    expect((await act(id, { action: "verify" })).status).toBe(401);
  });

  it("follows the clinic's verifier setting; a doctor verifies only for their own patient", async () => {
    const { id, patientId } = await submitted();
    as(people.drA, "doctor");
    expect((await act(id, { action: "verify" })).status).toBe(404); // no relationship
    await visit(patientId, doctors.a);

    await settings("lab_only");
    expect((await act(id, { action: "verify" })).body.code).toBe("verifier_not_allowed");
    await settings("doctor_only");
    as(people.reviewer, "lab");
    expect((await act(id, { action: "verify" })).body.code).toBe("verifier_not_allowed");
    as(people.drA, "doctor");
    expect((await act(id, { action: "verify" })).body.data).toEqual({ changed: true });
  });

  it("returns a submitted result for rework; the author fixes and resubmits", async () => {
    const { id, itemId } = await submitted("1400");
    as(people.reviewer, "lab");
    expect((await act(id, { action: "return" })).body.data).toEqual({ changed: true });
    expect((await entry(itemId)).entry.result!.status).toBe("draft");
    expect((await save(itemId, "141")).body.code).toBe("draft_owned");
    as(people.tech, "lab");
    await save(itemId, "141");
    await act(id, { action: "submit" });
    expect((await act(id, { action: "return" })).body.data).toEqual({ changed: true }); // the author takes it back
    expect((await act(id, { action: "submit" })).status).toBe(200);
  });

  it("corrects a verified result as a new version; the previous one is preserved and shown in the history", async () => {
    const { id: v1, itemId, patientId } = await submitted("140");
    as(people.reviewer, "lab");
    await act(v1, { action: "verify" });

    expect((await act(v1, { action: "correct", reason: "" })).status).toBe(400);
    const started = await act(v1, { action: "correct", reason: "Noto‘g‘ri namuna" });
    expect(started.status).toBe(201);
    const v2 = started.body.data!.resultId as string;
    let view = (await entry(itemId)).entry;
    expect(view.result).toMatchObject({ id: v2, status: "draft", version: 2, correctionReason: "Noto‘g‘ri namuna" });
    expect(view.parameters[0].value!.numeric).toBe("140");
    expect(view.versions).toEqual([expect.objectContaining({ id: v1, version: 1, status: "verified", verifiedByName: "reviewer" })]);
    const queued = async () =>
      ((await read(await getQueue())).body.data!.orders as Array<{ items: Array<{ id: string; status: string; correction: string | null }> }>)
        .flatMap((o) => o.items)
        .find((i) => i.id === itemId);
    expect(await queued()).toMatchObject({ status: "verified", correction: "draft" });

    // The reviewer enters the correction, so someone else verifies it.
    await save(itemId, "120");
    await act(v2, { action: "submit" });
    expect(await queued()).toMatchObject({ status: "verified", correction: "submitted" });
    as(people.tech, "lab");
    await act(v2, { action: "verify" });
    view = (await entry(itemId)).entry;
    expect(view.result).toMatchObject({ id: v2, status: "verified", version: 2 });
    expect(view.versions).toEqual([expect.objectContaining({ id: v1, status: "superseded", values: [{ parameter: "Gemoglobin", value: "140", unit: "g/L", flag: "normal" }] })]);

    // The doctor's verified view shows the corrected version with its reason.
    await visit(patientId, doctors.a);
    as(people.drA, "doctor");
    const res = await read(await doctorResult(new NextRequest("http://localhost"), { params: Promise.resolve({ id: patientId, itemId }) }));
    expect(res.body.data!.result).toMatchObject({ version: 2, correctionReason: "Noto‘g‘ri namuna", values: [expect.objectContaining({ value: "120" })] });
  });

  it("a doctor who can read a result cannot correct someone else's; only their own", async () => {
    const lab = await submitted("150");
    as(people.reviewer, "lab");
    await act(lab.id, { action: "verify" });
    await visit(lab.patientId, doctors.a);
    as(people.drA, "doctor");
    expect((await entry(lab.itemId)).entry.can.correct).toBe(false);
    expect((await act(lab.id, { action: "correct", reason: "Men tuzataman" })).body.code).toBe("correction_not_allowed");

    // A result the doctor entered themselves.
    const own = await receivedItem();
    await visit(own.patientId, doctors.a);
    as(people.drA, "doctor");
    const id = (await save(own.itemId, "130")).body.data!.resultId as string;
    await act(id, { action: "submit" });
    as(people.reviewer, "lab");
    await act(id, { action: "verify" });
    as(people.drA, "doctor");
    expect((await act(id, { action: "correct", reason: "O‘z xatoim" })).status).toBe(201);
    // Another doctor of the clinic without a relationship gets nothing.
    as(people.drC, "doctor");
    expect((await entry(own.itemId)).status).toBe(404);
  });

  it("never crosses clinics", async () => {
    const { id, itemId } = await submitted();
    as(people.labB, "lab", clinicB);
    for (const body of [{ action: "verify" }, { action: "return" }, { action: "correct", reason: "x" }]) {
      expect((await act(id, body)).status).toBe(404);
    }
    expect((await entry(itemId)).status).toBe(404);
    const { data } = await admin.from("lab_results").select("status").eq("id", id).single();
    expect(data!.status).toBe("submitted");
  });
});
