import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { localDbAvailable } from "@/test/local-db";
import { idFree } from "@/test/id-free";

/**
 * Laboratory dashboards (Phase 17) on the real database: who sees what.
 *
 *  * lab staff (and the other work-queue roles): the work by stage — status only;
 *  * doctors: only patients doctor_patient_access() admits (own patient or an
 *    active referral; a revoked referral removes them at once); values only for
 *    those patients; every result shown is audited;
 *  * managers: volume, workload, turnaround, cancellations, repeats — no money;
 *  * owner / admin: the same plus revenue from the payment records (never the
 *    catalog price).
 * No other clinic's data, and no patient name or value in the management or
 * lab views.
 */

const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const session = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/staff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/staff")>();
  return { ...actual, getStaffContext: async () => session.ctx };
});

import { GET as labDashboard } from "./dashboard/route";
import { GET as doctorDashboard } from "../doctor/lab/dashboard/route";
import { GET as managementAnalytics } from "../admin/analytics/lab/route";

const describeDb = describe.skipIf(!localDbAvailable());

type Body = { ok: boolean; data?: Record<string, unknown>; code?: string };
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Body });
const analytics = (query = "range=30") => managementAnalytics(new NextRequest(`http://localhost/api/admin/analytics/lab?${query}`));

describeDb("lab dashboards (real database)", () => {
  let admin: SupabaseClient;
  const suffix = Date.now().toString(36);
  const clinicA: string = randomUUID();
  const clinicB: string = randomUUID();
  const people = {
    reception: randomUUID(), lab1: randomUUID(), lab2: randomUUID(), owner: randomUUID(), adminUser: randomUUID(), manager: randomUUID(),
    drA: randomUUID(), drC: randomUUID(), labB: randomUUID(), unlinked: randomUUID(),
  };
  const doctors = { a: randomUUID(), c: randomUUID() };
  const service = randomUUID();
  const tests = { t: "", t2: "" };
  const params = { t: "", t2: "" };
  const patients = { p1: "", p2: "" };
  const names = { p1: `Dashboard Birinchi ${suffix}`, p2: `Dashboard Ikkinchi ${suffix}` };
  const results: Record<string, string> = {};
  let referral = "";
  let day = 0;

  const as = (profileId: string, role: string, clinicId = clinicA) => {
    session.ctx = { profileId, clinicId, clinicName: "Dash", clinicTimezone: "Asia/Tashkent", roles: [role], platformAdmin: false };
  };
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await admin.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  };
  async function visit(clinicId: string, patientId: string, doctorId: string) {
    const start = new Date(Date.UTC(2024, 0, 1, 5, 0) + day++ * 86_400_000);
    const { data, error } = await admin
      .from("appointments")
      .insert({ clinic_id: clinicId, patient_id: patientId, doctor_id: doctorId, service_id: service, start_at: start.toISOString(), end_at: new Date(start.getTime() + 1_800_000).toISOString(), status: "completed", source: "walk_in" })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return data!.id as string;
  }
  async function order(opts: { patientId: string; testIds: string[]; byDoctorA?: boolean; clinicId?: string; orderedBy?: string }) {
    const clinicId = opts.clinicId ?? clinicA;
    const args: Record<string, unknown> = {
      p_clinic_id: clinicId, p_patient_id: opts.patientId, p_ordered_by: opts.orderedBy ?? people.reception, p_source: "walk_in", p_test_ids: opts.testIds, p_panel_ids: [],
    };
    if (opts.byDoctorA) {
      Object.assign(args, { p_ordered_by: people.drA, p_source: "consultation", p_ordering_doctor_id: doctors.a, p_appointment_id: await visit(clinicA, opts.patientId, doctors.a) });
    }
    const o = (await rpc("create_lab_order", args)) as Array<{ lab_order_id: string }>;
    const { data: items } = await admin.from("lab_order_items").select("id, test_id").eq("order_id", o[0].lab_order_id);
    const itemOf = (testId: string) => items!.find((i) => i.test_id === testId)!.id as string;
    return { orderId: o[0].lab_order_id, itemOf };
  }
  async function collect(orderId: string, itemIds: string[], clinicId = clinicA, by = people.reception) {
    const s = (await rpc("collect_lab_sample", { p_clinic_id: clinicId, p_order_id: orderId, p_item_ids: itemIds, p_collected_by: by })) as Array<{ lab_sample_id: string }>;
    return s[0].lab_sample_id;
  }
  async function draft(itemId: string, paramId: string, value: number, clinicId = clinicA, by = people.lab1) {
    const r = (await rpc("save_lab_result_draft", { p_clinic_id: clinicId, p_order_item_id: itemId, p_entered_by: by, p_values: [{ parameter_id: paramId, value_numeric: value }] })) as Array<{ lab_result_id: string }>;
    return r[0].lab_result_id;
  }
  /** Collected, received, entered by lab1, submitted, verified by lab2. */
  async function verified(o: { orderId: string; itemOf: (t: string) => string }, value: number) {
    const item = o.itemOf(tests.t);
    const sample = await collect(o.orderId, [item]);
    await rpc("receive_lab_sample", { p_clinic_id: clinicA, p_sample_id: sample, p_received_by: people.lab1 });
    const id = await draft(item, params.t, value);
    await rpc("submit_lab_result", { p_clinic_id: clinicA, p_result_id: id, p_submitted_by: people.lab1 });
    await rpc("verify_lab_result", { p_clinic_id: clinicA, p_result_id: id, p_verified_by: people.lab2 });
    return id;
  }
  async function setPaid(orderId: string) {
    const { data: p } = await admin.from("payments").select("id, status").eq("lab_order_id", orderId).single();
    const { error } = await admin.from("payments").update({ status: "paid", paid_at: new Date().toISOString(), paid_by: people.owner }).eq("id", p!.id);
    if (error) throw new Error(`pay: ${error.message}`);
  }

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    await admin.from("clinics").insert([
      { id: clinicA, name: `Dash A ${suffix}`, slug: `dash-a-${suffix}`, timezone: "Asia/Tashkent" },
      { id: clinicB, name: `Dash B ${suffix}`, slug: `dash-b-${suffix}`, timezone: "Asia/Tashkent" },
    ]);
    for (const [name, id] of Object.entries(people)) {
      const { error } = await admin.auth.admin.createUser({ id, email: `dash-${name}-${suffix}@test.local`, email_confirm: true, password: `Pw-${randomUUID()}` });
      if (error) throw new Error(error.message);
      await admin.from("profiles").insert({ id, full_name: name });
    }
    await admin.from("staff_roles").insert([
      { clinic_id: clinicA, profile_id: people.reception, role: "receptionist" },
      { clinic_id: clinicA, profile_id: people.lab1, role: "lab" },
      { clinic_id: clinicA, profile_id: people.lab2, role: "lab" },
      { clinic_id: clinicA, profile_id: people.owner, role: "owner" },
      { clinic_id: clinicA, profile_id: people.adminUser, role: "admin" },
      { clinic_id: clinicA, profile_id: people.manager, role: "manager" },
      { clinic_id: clinicA, profile_id: people.drA, role: "doctor" },
      { clinic_id: clinicA, profile_id: people.drC, role: "doctor" },
      { clinic_id: clinicA, profile_id: people.unlinked, role: "doctor" },
      { clinic_id: clinicB, profile_id: people.labB, role: "lab" },
    ]);
    await admin.from("doctors").insert([
      { id: doctors.a, clinic_id: clinicA, profile_id: people.drA, name: `Dr A ${suffix}`, active: true },
      { id: doctors.c, clinic_id: clinicA, profile_id: people.drC, name: `Dr C ${suffix}`, active: true },
    ]);
    await admin.from("services").insert({ id: service, clinic_id: clinicA, name: `Dash consult ${suffix}`, duration_minutes: 30, price: 1 });
    await admin.from("doctor_working_hours").insert(
      [doctors.a, doctors.c].flatMap((doctor_id) => [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinic_id: clinicA, doctor_id, weekday, start_time: "00:00", end_time: "23:59" }))),
    );
    const { data: cat } = await admin.from("lab_test_categories").insert({ clinic_id: clinicA, name: `Gematologiya ${suffix}` }).select("id").single();
    const { data: t } = await admin.from("lab_tests").insert([
      { clinic_id: clinicA, category_id: cat!.id, code: `DSH${suffix}`, name: `Qon tahlili ${suffix}`, sample_type: "Qon", price: 1000, turnaround_hours: 24 },
      { clinic_id: clinicA, code: `DSG${suffix}`, name: `Glyukoza ${suffix}`, sample_type: "Qon", price: 500 },
    ]).select("id, code");
    tests.t = t!.find((x) => x.code === `DSH${suffix}`)!.id;
    tests.t2 = t!.find((x) => x.code === `DSG${suffix}`)!.id;
    const { data: p } = await admin.from("lab_test_parameters").insert([
      { clinic_id: clinicA, test_id: tests.t, code: "HGB", name: "Gemoglobin", value_type: "numeric", unit: "g/L" },
      { clinic_id: clinicA, test_id: tests.t2, code: "GLU", name: "Glyukoza", value_type: "numeric", unit: "mmol/L" },
    ]).select("id, code");
    params.t = p!.find((x) => x.code === "HGB")!.id;
    params.t2 = p!.find((x) => x.code === "GLU")!.id;
    await admin.from("lab_reference_ranges").insert({ clinic_id: clinicA, parameter_id: params.t, low: 120, high: 160, critical_low: 60, critical_high: 220 });

    const { data: pts } = await admin.from("patients").insert([
      { clinic_id: clinicA, full_name: names.p1, date_of_birth: "1980-01-01" },
      { clinic_id: clinicA, full_name: names.p2, date_of_birth: "1985-01-01" },
    ]).select("id, full_name");
    patients.p1 = pts!.find((x) => x.full_name === names.p1)!.id;
    patients.p2 = pts!.find((x) => x.full_name === names.p2)!.id;
    await visit(clinicA, patients.p2, doctors.c); // P2 is Dr C's patient, not Dr A's

    // O1, O2: Dr A orders for P1 — verified 150 (in range), then 100 (low). O1 is paid.
    const o1 = await order({ patientId: patients.p1, testIds: [tests.t], byDoctorA: true });
    await setPaid(o1.orderId);
    results.o1 = await verified(o1, 150);
    const o2 = await order({ patientId: patients.p1, testIds: [tests.t], byDoctorA: true });
    results.o2 = await verified(o2, 100);
    // O3: a walk-in for P2 (Dr C's patient) — verified 90 (low).
    const o3 = await order({ patientId: patients.p2, testIds: [tests.t] });
    results.o3 = await verified(o3, 90);
    // O4: Dr A orders two tests for P1, paid: one with a draft (in progress), one submitted (awaiting verification).
    const o4 = await order({ patientId: patients.p1, testIds: [tests.t, tests.t2], byDoctorA: true });
    await setPaid(o4.orderId);
    const s4 = await collect(o4.orderId, [o4.itemOf(tests.t), o4.itemOf(tests.t2)]);
    await rpc("receive_lab_sample", { p_clinic_id: clinicA, p_sample_id: s4, p_received_by: people.lab1 });
    await draft(o4.itemOf(tests.t), params.t, 140);
    const sub = await draft(o4.itemOf(tests.t2), params.t2, 5.4);
    await rpc("submit_lab_result", { p_clinic_id: clinicA, p_result_id: sub, p_submitted_by: people.lab1 });
    // O5 awaiting collection, O6 collected (not started), O7 received (no result), O8 cancelled.
    await order({ patientId: patients.p2, testIds: [tests.t] });
    const o6 = await order({ patientId: patients.p2, testIds: [tests.t] });
    await collect(o6.orderId, [o6.itemOf(tests.t)]);
    const o7 = await order({ patientId: patients.p2, testIds: [tests.t] });
    const s7 = await collect(o7.orderId, [o7.itemOf(tests.t)]);
    await rpc("receive_lab_sample", { p_clinic_id: clinicA, p_sample_id: s7, p_received_by: people.lab1 });
    const o8 = await order({ patientId: patients.p2, testIds: [tests.t] });
    await admin.from("lab_orders").update({ status: "cancelled", cancelled_by: people.reception, cancelled_at: new Date().toISOString(), cancel_reason: "Bemor kelmadi" }).eq("id", o8.orderId);

    // The catalog price changes after payment: revenue must not move.
    await admin.from("lab_tests").update({ price: 99_999 }).eq("id", tests.t);

    // Clinic B: work that must never appear in clinic A's figures.
    const { data: pb } = await admin.from("patients").insert({ clinic_id: clinicB, full_name: `B bemor ${suffix}`, date_of_birth: "1990-01-01" }).select("id").single();
    const { data: tb } = await admin.from("lab_tests").insert({ clinic_id: clinicB, code: `DSB${suffix}`, name: `B test ${suffix}`, sample_type: "Qon", price: 7777 }).select("id").single();
    for (let i = 0; i < 3; i++) await order({ clinicId: clinicB, patientId: pb!.id, testIds: [tb!.id], orderedBy: people.labB });
  }, 120_000);

  afterAll(async () => {
    if (!admin) return;
    await admin.from("clinics").delete().in("id", [clinicA, clinicB]);
    for (const id of Object.values(people)) await admin.auth.admin.deleteUser(id);
  });

  it("lab staff: the work by stage, counted exactly, status only, own clinic only", async () => {
    as(people.lab1, "lab");
    const { status, body } = await read(await labDashboard());
    expect(status).toBe(200);
    const w = body.data!.workload as Record<string, unknown> & { stages: Record<string, { count: number; oldestSince: string | null }> };
    expect(Object.fromEntries(Object.entries(w.stages).map(([k, v]) => [k, v.count]))).toEqual({
      awaitingCollection: 1, inTransit: 1, awaitingEntry: 1, inProgress: 1, awaitingVerification: 1,
    });
    expect(w.stages.awaitingCollection.oldestSince).toEqual(expect.any(String));
    expect(w).toMatchObject({ activeOrders: 4, completedToday: 3, completedLast7Days: 3, overdue: 0, truncated: false });
    expect(w.byCategory).toEqual(expect.arrayContaining([{ name: `Gematologiya ${suffix}`, open: 4 }, { name: "Bo‘limsiz", open: 1 }]));
    // Nothing about patients, values or money.
    const text = idFree(body);
    for (const leak of [names.p1, names.p2, "Gemoglobin", "g/L", "1000", "price", "amount"]) expect(text).not.toContain(leak);

    // The other work-queue roles see the same; another clinic sees its own.
    for (const [id, role] of [[people.reception, "receptionist"], [people.owner, "owner"], [people.manager, "manager"]] as const) {
      as(id, role);
      expect((await labDashboard()).status).toBe(200);
    }
    as(people.labB, "lab", clinicB);
    const b = (await read(await labDashboard())).body.data!.workload as { stages: Record<string, { count: number }>; activeOrders: number };
    expect(b.stages.awaitingCollection.count).toBe(3);
    expect(b.activeOrders).toBe(3);
  });

  it("lab staff dashboard: doctors (no clinic-wide queue) and anonymous callers are refused", async () => {
    as(people.drA, "doctor");
    expect((await labDashboard()).status).toBe(403);
    session.ctx = null;
    expect((await labDashboard()).status).toBe(401);
  });

  it("doctor: own orders, pending tests, own patients' results, out-of-range values and comparable tests — audited", async () => {
    as(people.drA, "doctor");
    const { status, body } = await read(await doctorDashboard());
    expect(status).toBe(200);
    const d = body.data as {
      myOrders: Array<{ patientId: string; tests: unknown[] }>;
      pending: Array<{ status: string }>;
      pendingCount: number;
      recentResults: Array<{ resultId: string; outOfRange: number; critical: boolean; previousVerifiedAt: string | null; patientName: string }>;
      abnormal: Array<{ resultId: string; parameter: string; value: string; unit: string; flag: string; range: string }>;
    };
    expect(d.myOrders).toHaveLength(3);
    expect(new Set(d.myOrders.map((o) => o.patientId))).toEqual(new Set([patients.p1]));
    expect(d.pendingCount).toBe(2);
    expect(d.pending.map((p) => p.status).sort()).toEqual(["processing", "resulted"]);
    // P1's two verified results; never P2's (Dr C's patient).
    expect(d.recentResults.map((r) => r.resultId).sort()).toEqual([results.o1, results.o2].sort());
    const latest = d.recentResults.find((r) => r.resultId === results.o2)!;
    expect(latest).toMatchObject({ outOfRange: 1, critical: false, patientName: names.p1 });
    expect(latest.previousVerifiedAt).toEqual(expect.any(String)); // compared with O1
    expect(d.recentResults.find((r) => r.resultId === results.o1)!.previousVerifiedAt).toBeNull();
    expect(d.abnormal).toEqual([expect.objectContaining({ resultId: results.o2, parameter: "Gemoglobin", value: "100", unit: "g/L", flag: "low" })]);
    expect(JSON.stringify(d)).not.toContain(names.p2);

    const { data: audits } = await admin.from("audit_events").select("entity_id, metadata").eq("clinic_id", clinicA).eq("action", "lab_result_viewed").eq("actor_id", people.drA);
    expect(audits!.filter((a) => (a.metadata as { via?: string }).via === "doctor_dashboard").map((a) => a.entity_id).sort()).toEqual([results.o1, results.o2].sort());
  });

  it("doctor: a referral adds the patient while it is active; revoking it removes them at once", async () => {
    as(people.drC, "doctor");
    const c = (await read(await doctorDashboard())).body.data as { recentResults: Array<{ resultId: string }>; myOrders: unknown[] };
    expect(c.recentResults.map((r) => r.resultId)).toEqual([results.o3]); // Dr C's own patient, ordered by reception
    expect(c.myOrders).toEqual([]);

    const appt = await visit(clinicA, patients.p2, doctors.c);
    const { data: ref, error } = await admin.from("referrals").insert({
      clinic_id: clinicA, patient_id: patients.p2, referring_doctor_id: doctors.c, referred_to_doctor_id: doctors.a,
      originating_appointment_id: appt, reason: `Dashboard (${suffix})`, created_by: people.drC,
    }).select("id").single();
    if (error) throw new Error(error.message);
    referral = ref!.id;
    as(people.drA, "doctor");
    let a = (await read(await doctorDashboard())).body.data as { recentResults: Array<{ resultId: string }>; abnormal: Array<{ resultId: string }> };
    expect(a.recentResults.map((r) => r.resultId)).toContain(results.o3);
    expect(a.abnormal.map((x) => x.resultId)).toContain(results.o3);

    await admin.from("referrals").update({ status: "revoked", revoked_at: new Date().toISOString(), revoked_by: people.drC, revoked_reason: "Kerak emas" }).eq("id", referral);
    a = (await read(await doctorDashboard())).body.data as { recentResults: Array<{ resultId: string }>; abnormal: Array<{ resultId: string }> };
    expect(a.recentResults.map((r) => r.resultId)).not.toContain(results.o3);
    expect(a.abnormal.map((x) => x.resultId)).not.toContain(results.o3);
  });

  it("doctor dashboard: only for linked doctors", async () => {
    for (const [id, role] of [[people.lab1, "lab"], [people.owner, "owner"], [people.manager, "manager"], [people.reception, "receptionist"]] as const) {
      as(id, role);
      expect((await doctorDashboard()).status).toBe(403);
    }
    as(people.unlinked, "doctor"); // a doctor role without a doctor record
    expect((await doctorDashboard()).status).toBe(403);
    as(people.drA, "doctor", clinicB); // signed in to another clinic
    expect((await doctorDashboard()).status).toBe(403);
    session.ctx = null;
    expect((await doctorDashboard()).status).toBe(401);
  });

  it("owner and admin: revenue from payment records, delivered work only, unaffected by catalog prices", async () => {
    for (const [id, role] of [[people.owner, "owner"], [people.adminUser, "admin"]] as const) {
      as(id, role);
      const { status, body } = await read(await analytics());
      expect(status).toBe(200);
      const d = body.data as { can_view_payment_dynamics: boolean; finance: Record<string, unknown> };
      expect(d.can_view_payment_dynamics).toBe(true);
      expect(d.finance).toMatchObject({
        recognized: 1000, // O1: paid and verified — at the stored price, not the new catalog price
        prepaidInProgress: 1500, // O4: paid, still being done
        toRefund: 0,
        paidTotal: 2500,
        unpaid: 5000, // O2, O3, O5, O6, O7
        paidOrders: 2,
      });
      expect(d.finance.revenueByTest).toEqual([{ name: `Qon tahlili ${suffix}`, revenue: 1000, count: 1 }]);
      expect(d.finance.revenueByCategory).toEqual([{ name: `Gematologiya ${suffix}`, revenue: 1000 }]);
    }
  });

  it("manager: volume, workload, turnaround, cancellations and repeats — and no money anywhere", async () => {
    as(people.manager, "manager");
    const { status, body } = await read(await analytics());
    expect(status).toBe(200);
    const d = body.data as Record<string, unknown> & {
      turnaround: { orderToVerified: { count: number } };
      repeats: { repeatedTests: number; byTest: Array<{ count: number }> };
      workload: { stages: Record<string, { count: number }> };
    };
    expect(d.can_view_payment_dynamics).toBe(false);
    expect(d.finance).toBeNull();
    expect(d).toMatchObject({ orders: 8, tests: 9, cancelledOrders: 1, cancelledTests: 1 });
    expect(d.cancelReasons).toEqual([{ reason: "Bemor kelmadi", count: 1 }]);
    expect(d.turnaround.orderToVerified.count).toBe(3);
    expect(d.repeats.repeatedTests).toBe(5); // P1: O2, O4; P2: O5, O6, O7
    expect(d.workload.stages.awaitingVerification.count).toBe(1);
    const text = idFree(body);
    for (const leak of ["revenue", "paidTotal", "unpaid", "amount", "1500", "2500", names.p1, names.p2, "Gemoglobin", "g/L", "B test"]) expect(text).not.toContain(leak);
  });

  it("management analytics: other roles are refused; a custom period is validated", async () => {
    for (const [id, role] of [[people.reception, "receptionist"], [people.lab1, "lab"], [people.drA, "doctor"]] as const) {
      as(id, role);
      expect((await analytics()).status).toBe(403);
    }
    session.ctx = null;
    expect((await analytics()).status).toBe(401);
    as(people.owner, "owner");
    expect((await analytics("from=2026-02-01&to=2026-01-01")).status).toBe(400);
    const past = (await read(await analytics("from=2020-01-01&to=2020-01-31"))).body.data as { orders: number; finance: { recognized: number } };
    expect(past.orders).toBe(0);
    expect(past.finance.recognized).toBe(0);
  });
});
