import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import postgres from "postgres";
import { cleanupTestClinics } from "@/test/cleanup-clinics";
import { localDbAvailable } from "@/test/local-db";

/**
 * A doctor's laboratory ordering through the REAL routes, guards and database (phase 4): the catalog a
 * doctor can order from, an order written as the session's doctor from their own consultation with the
 * catalog's prices, refusals (patient, consultation, tests, referral), idempotency including a concurrent
 * race, the longitudinal view of a patient's orders, and the advisory similar-test notice.
 *
 * Mocked: only the staff session lookup (getStaffContext).
 */

const session = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/staff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/staff")>();
  return { ...actual, getStaffContext: async () => session.ctx };
});

import * as catalogRoute from "./catalog/route";
import * as comparableRoute from "./comparable/route";
import * as ordersRoute from "./orders/route";
import * as patientLabRoute from "../patients/[id]/lab/route";
import * as settingsRoute from "@/app/api/admin/lab/settings/route";

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const describeDb = describe.skipIf(!localDbAvailable());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = { ok: boolean; data?: Record<string, any>; code?: string; error?: string };
type Role = "doctor" | "owner" | "receptionist" | "lab_staff" | "manager";

describeDb("doctor laboratory ordering — real routes and database", () => {
  let sql: postgres.Sql;
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const clinicA = randomUUID();
  const clinicB = randomUUID();
  const users: Record<string, string> = {
    a: randomUUID(), b: randomUUID(), c: randomUUID(), k: randomUUID(), owner: randomUUID(), rec: randomUUID(), lab: randomUUID(), ver: randomUUID(),
  };
  const doc: Record<string, string> = { a: randomUUID(), b: randomUUID(), c: randomUUID(), k: randomUUID() };
  const patient = { x: randomUUID(), y: randomUUID(), k: randomUUID() };
  const svcA = randomUUID();
  const svcB = randomUUID();
  const T: Record<string, string> = {}; // tests: hb, glu, old (inactive), b (clinic B)
  let panelOk = "";
  let panelFixed = "";
  let panelBroken = "";
  let consult = ""; // doctor A, patient X, in progress
  let consultDone = "";
  let consultBooked = "";
  let consultOfB = ""; // doctor B, patient X
  let consultY = ""; // doctor A, patient Y (completed) — the patient the "wrong patient" cases use
  let day = 0;
  const NOTE = `Doctor's note about the order ${suffix}`;

  const as = (name: "a" | "b" | "c" | "k", role: Role = "doctor", clinic = clinicA) => {
    session.ctx = { profileId: users[name], clinicId: clinic, clinicName: "Lab ordering", clinicTimezone: "Asia/Tashkent", roles: [role], platformAdmin: false };
  };
  const asRole = (name: "owner" | "rec" | "lab", role: Role) => {
    session.ctx = { profileId: users[name], clinicId: clinicA, clinicName: "Lab ordering", clinicTimezone: "Asia/Tashkent", roles: [role], platformAdmin: false };
  };
  const read = async (res: Response): Promise<{ status: number; body: Json }> => ({ status: res.status, body: (await res.json()) as Json });
  const req = (method: string, path: string, body?: unknown) =>
    new NextRequest(`http://localhost${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const order = async (body: Record<string, unknown>) => read(await ordersRoute.POST(req("POST", "/api/doctor/lab/orders", { idempotencyKey: randomUUID(), ...body })));
  const similar = async (body: Record<string, unknown>) => read(await comparableRoute.POST(req("POST", "/api/doctor/lab/comparable", body)));
  const listFor = async (patientId: string) =>
    read(await patientLabRoute.GET(req("GET", `/api/doctor/patients/${patientId}/lab`), { params: Promise.resolve({ id: patientId }) }));
  const catalog = async (q = "") => read(await catalogRoute.GET(req("GET", `/api/doctor/lab/catalog${q ? `?q=${encodeURIComponent(q)}` : ""}`)));
  const orderRows = (patientId: string) => sql<{ id: string; created_by: string; ordering_doctor_id: string; appointment_id: string; status: string }[]>`
    select id, created_by, ordering_doctor_id, appointment_id, status from public.lab_orders where patient_id = ${patientId} order by created_at`;

  async function visit(clinic: string, pt: string, doctor: string, status: string, service = svcA) {
    const start = new Date(Date.UTC(2032, 2, 2, 5, 0) + day++ * 86_400_000);
    const [row] = await sql<{ id: string }[]>`insert into public.appointments ${sql({
      clinic_id: clinic, patient_id: pt, doctor_id: doctor, service_id: service, start_at: start,
      end_at: new Date(start.getTime() + 30 * 60_000), status, source: "walk_in",
    })} returning id`;
    return row.id;
  }

  beforeAll(async () => {
    sql = postgres(DB_URL, { max: 8, onnotice: () => {} });
    await sql`insert into public.clinics ${sql([
      { id: clinicA, name: `Lab Order A ${suffix}`, slug: `lab-order-a-${suffix}`, timezone: "Asia/Tashkent" },
      { id: clinicB, name: `Lab Order B ${suffix}`, slug: `lab-order-b-${suffix}`, timezone: "Asia/Tashkent" },
    ])}`;
    const rows = Object.entries(users).map(([name, id]) => ({ id, email: `labord-${name}-${suffix}@test.local` }));
    await sql`insert into auth.users ${sql(rows)}`;
    await sql`insert into public.profiles ${sql(rows.map((u) => ({ id: u.id, full_name: u.email })))}`;
    await sql`insert into public.staff_roles ${sql([
      { clinic_id: clinicA, profile_id: users.a, role: "doctor" },
      { clinic_id: clinicA, profile_id: users.b, role: "doctor" },
      { clinic_id: clinicA, profile_id: users.c, role: "doctor" },
      { clinic_id: clinicB, profile_id: users.k, role: "doctor" },
      { clinic_id: clinicA, profile_id: users.owner, role: "owner" },
      { clinic_id: clinicA, profile_id: users.rec, role: "receptionist" },
      { clinic_id: clinicA, profile_id: users.lab, role: "lab_staff" },
      { clinic_id: clinicA, profile_id: users.ver, role: "lab_staff" },
    ])}`;
    await sql`insert into public.doctors ${sql([
      { id: doc.a, clinic_id: clinicA, profile_id: users.a, name: `Dr A ${suffix}`, active: true },
      { id: doc.b, clinic_id: clinicA, profile_id: users.b, name: `Dr B ${suffix}`, active: true },
      { id: doc.c, clinic_id: clinicA, profile_id: users.c, name: `Dr C ${suffix}`, active: true },
      { id: doc.k, clinic_id: clinicB, profile_id: users.k, name: `Dr K ${suffix}`, active: true },
    ])}`;
    await sql`insert into public.services ${sql([
      { id: svcA, clinic_id: clinicA, name: `Order consult ${suffix}`, duration_minutes: 30, price: 1000 },
      { id: svcB, clinic_id: clinicB, name: `Order consult B ${suffix}`, duration_minutes: 30, price: 1000 },
    ])}`;
    await sql`insert into public.doctor_working_hours ${sql(
      [[clinicA, doc.a], [clinicA, doc.b], [clinicA, doc.c], [clinicB, doc.k]].flatMap(([clinic, doctor]) =>
        [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinic_id: clinic, doctor_id: doctor, weekday, start_time: "00:00", end_time: "23:59" })),
      ),
    )}`;
    await sql`insert into public.patients ${sql([
      { id: patient.x, clinic_id: clinicA, full_name: `Order patient X ${suffix}` },
      { id: patient.y, clinic_id: clinicA, full_name: `Order patient Y ${suffix}` },
      { id: patient.k, clinic_id: clinicB, full_name: `Order patient K ${suffix}` },
    ])}`;
    consult = await visit(clinicA, patient.x, doc.a, "in_progress");
    consultDone = await visit(clinicA, patient.x, doc.a, "completed");
    consultBooked = await visit(clinicA, patient.x, doc.a, "confirmed");
    consultOfB = await visit(clinicA, patient.x, doc.b, "completed");
    consultY = await visit(clinicA, patient.y, doc.a, "completed");
    await visit(clinicB, patient.k, doc.k, "in_progress", svcB);

    const ins = async <R extends Record<string, unknown>>(table: string, row: R) =>
      (await sql<{ id: string }[]>`insert into ${sql(`public.${table}`)} ${sql(row as never)} returning id`)[0].id;
    const cat = await ins("lab_categories", { clinic_id: clinicA, name: `Gematologiya ${suffix}` });
    T.hb = await ins("lab_tests", { clinic_id: clinicA, category_id: cat, code: `CBC-${suffix}`, name: "Complete blood count", price: 85000, sample_type: "blood", preparation_text: "No preparation", turnaround_minutes: 120 });
    T.glu = await ins("lab_tests", { clinic_id: clinicA, category_id: null, code: `GLU-${suffix}`, name: "Glucose", price: 25000, sample_type: "blood", preparation_text: "Fasting 8h", turnaround_minutes: 60 });
    T.old = await ins("lab_tests", { clinic_id: clinicA, category_id: null, code: `OLD-${suffix}`, name: "Retired test", price: 1, sample_type: null, preparation_text: null, turnaround_minutes: null, active: false });
    T.b = await ins("lab_tests", { clinic_id: clinicB, category_id: null, code: `B-${suffix}`, name: "Clinic B test", price: 1, sample_type: null, preparation_text: null, turnaround_minutes: null });
    await ins("lab_test_parameters", { clinic_id: clinicA, test_id: T.hb, code: "HGB", name: "Hemoglobin", unit: "g/L", data_type: "numeric", choices: null });
    panelOk = await ins("lab_panels", { clinic_id: clinicA, code: `PAN-${suffix}`, name: "Basic panel", description: null, price: null });
    panelFixed = await ins("lab_panels", { clinic_id: clinicA, code: `PFX-${suffix}`, name: "Fixed panel", description: null, price: 100000 });
    panelBroken = await ins("lab_panels", { clinic_id: clinicA, code: `PBR-${suffix}`, name: "Panel with a retired test", description: null, price: null });
    await sql`insert into public.lab_panel_tests ${sql([
      { panel_id: panelOk, test_id: T.hb, clinic_id: clinicA, sort_order: 0 },
      { panel_id: panelOk, test_id: T.glu, clinic_id: clinicA, sort_order: 1 },
      { panel_id: panelFixed, test_id: T.hb, clinic_id: clinicA, sort_order: 0 },
      { panel_id: panelFixed, test_id: T.glu, clinic_id: clinicA, sort_order: 1 },
      { panel_id: panelBroken, test_id: T.hb, clinic_id: clinicA, sort_order: 0 },
      { panel_id: panelBroken, test_id: T.old, clinic_id: clinicA, sort_order: 1 },
    ])}`;
  });

  // Each case counts its own requests: the buckets are per doctor, and this file makes many calls.
  beforeEach(async () => {
    await sql`delete from public.rate_limit_buckets where key like 'doctor-lab-%'`;
  });

  afterAll(async () => {
    if (!sql) return;
    await cleanupTestClinics([clinicA, clinicB]);
    await sql`delete from auth.users where id in ${sql(Object.values(users))}`;
    await sql.end({ timeout: 5 });
  });

  // ---------- the catalog a doctor can order from ----------

  it("catalog: active tests and panels of the doctor's own clinic, searchable by code, name and section — and only for doctors", async () => {
    as("a");
    const all = (await catalog()).body.data!;
    const codes = (all.tests as { code: string }[]).map((t) => t.code);
    expect(codes).toContain(`CBC-${suffix}`);
    expect(codes).toContain(`GLU-${suffix}`);
    expect(codes, "inactive tests are not orderable").not.toContain(`OLD-${suffix}`);
    expect(codes, "another clinic's tests are invisible").not.toContain(`B-${suffix}`);
    expect(all.tests.find((t: { code: string }) => t.code === `CBC-${suffix}`)).toMatchObject({
      name: "Complete blood count", price: 85000, sampleType: "blood", preparationText: "No preparation", turnaroundMinutes: 120, category: `Gematologiya ${suffix}`,
    });
    // By code, by name, by section.
    for (const [q, expected] of [[`cbc-${suffix}`, `CBC-${suffix}`], ["Glucose", `GLU-${suffix}`], [`gematologiya ${suffix}`, `CBC-${suffix}`]] as const) {
      expect(((await catalog(q)).body.data!.tests as { code: string }[]).map((t) => t.code), q).toContain(expected);
    }
    expect(((await catalog("zzz-nothing-here")).body.data!.tests as unknown[]).length).toBe(0);
    // A search text is a literal, never filter syntax.
    expect((await catalog("a),id.not.is.null,(b")).status).toBe(200);
    // Panels: the effective price is the sum, or the fixed price; one with a retired test is flagged.
    const panels = all.panels as Array<{ code: string; price: number; fixedPrice: boolean; unavailable: unknown[]; tests: unknown[] }>;
    expect(panels.find((p) => p.code === `PAN-${suffix}`)).toMatchObject({ price: 110000, fixedPrice: false, unavailable: [] });
    expect(panels.find((p) => p.code === `PFX-${suffix}`)).toMatchObject({ price: 100000, fixedPrice: true });
    expect(panels.find((p) => p.code === `PBR-${suffix}`)!.unavailable).toHaveLength(1);
    // Other roles and clinics.
    as("k", "doctor", clinicB);
    expect(((await catalog()).body.data!.tests as { code: string }[]).map((t) => t.code)).toEqual([`B-${suffix}`]);
    for (const [name, role] of [["rec", "receptionist"], ["lab", "lab_staff"], ["owner", "manager"]] as const) {
      asRole(name, role);
      expect((await catalog()).status, role).toBe(403);
    }
    session.ctx = null;
    expect((await catalog()).status).toBe(401);
  });

  // ---------- creating an order ----------

  it("an order is written as the session's doctor, from their own consultation, with the catalog's prices — tests and panels, deduplicated", async () => {
    as("a");
    const res = await order({ patientId: patient.x, testIds: [T.hb], panelIds: [panelOk], priority: "urgent", notes: NOTE });
    expect(res.status).toBe(201);
    const o = res.body.data!.order;
    expect(o).toMatchObject({ status: "ordered", priority: "urgent", replayed: false, appointmentId: consult });
    // CBC chosen directly AND through the panel is one item; glucose comes from the panel: 85000 + 25000.
    expect(o.items.map((i: { code: string }) => i.code).sort()).toEqual([`CBC-${suffix}`, `GLU-${suffix}`].sort());
    expect(o.total).toBe(110000);
    const [row] = await orderRows(patient.x);
    expect(row).toMatchObject({ id: o.id, ordering_doctor_id: doc.a, created_by: users.a, appointment_id: consult, status: "ordered" });
    const items = await sql<{ test_code: string; panel_id: string | null; price_snapshot: string }[]>`select test_code, panel_id, price_snapshot::text from public.lab_order_items where order_id = ${o.id} order by test_code`;
    expect(items.find((i) => i.test_code === `CBC-${suffix}`)!.panel_id).toBeNull(); // the explicit choice wins
    expect(items.find((i) => i.test_code === `GLU-${suffix}`)!.panel_id).toBe(panelOk);
    // The creation is in the trail: who, which order, ids only — never the note or the prices.
    const audit = await sql<{ action: string; actor_id: string; patient_id: string; new_values: unknown }[]>`
      select action, actor_id, patient_id, new_values from public.audit_events where entity_id = ${o.id}`;
    expect(audit.find((a) => a.action === "lab_order_created")).toMatchObject({ actor_id: users.a, patient_id: patient.x });
    expect(JSON.stringify(audit)).not.toContain(NOTE);
    expect(JSON.stringify(audit)).not.toMatch(/85000|25000|110000/);

    // A fixed-price panel orders the same tests (the panel price is applied at billing, phase 5).
    const fixed = await order({ patientId: patient.x, panelIds: [panelFixed] });
    expect(fixed.status).toBe(201);
    expect(fixed.body.data!.order.items).toHaveLength(2);
  });

  it("the request cannot name a clinic, a doctor, a price or a status: strict body, and an order needs at least one test", async () => {
    as("a");
    const before = (await orderRows(patient.x)).length;
    for (const extra of [{ clinicId: clinicB }, { doctorId: doc.b }, { orderingDoctorId: doc.b }, { createdBy: users.b }, { price: 1 }, { status: "completed" }, { total: 1 }]) {
      expect((await order({ patientId: patient.x, testIds: [T.hb], ...extra })).status, JSON.stringify(extra)).toBe(400);
    }
    expect((await order({ patientId: patient.x })).status).toBe(400);
    expect((await order({ patientId: patient.x, testIds: [] , panelIds: [] })).status).toBe(400);
    expect((await order({ patientId: "not-a-uuid", testIds: [T.hb] })).status).toBe(400);
    expect((await ordersRoute.POST(req("POST", "/api/doctor/lab/orders", { patientId: patient.x, testIds: [T.hb] }))).status, "no idempotency key").toBe(400);
    expect((await orderRows(patient.x)).length).toBe(before);
  });

  it("the consultation: the one in progress when not named; a completed one is fine; booked, another doctor's, another patient's or none are refused", async () => {
    // A patient with no consultation of the doctor in progress: 409 asking to start one first.
    as("a");
    expect((await order({ patientId: patient.y, testIds: [T.glu] }))).toMatchObject({ status: 409, body: { code: "consultation_required" } });
    // …but a named, completed consultation of theirs works.
    expect((await order({ patientId: patient.y, testIds: [T.glu], appointmentId: consultY })).status).toBe(201);
    expect((await order({ patientId: patient.x, testIds: [T.glu], appointmentId: consultDone })).status).toBe(201);
    expect((await order({ patientId: patient.x, testIds: [T.glu], appointmentId: consultBooked }))).toMatchObject({ status: 409, body: { code: "consultation_not_active" } });
    expect((await order({ patientId: patient.x, testIds: [T.glu], appointmentId: consultOfB }))).toMatchObject({ status: 404, body: { code: "consultation_not_found" } });
    expect((await order({ patientId: patient.x, testIds: [T.glu], appointmentId: consultY }))).toMatchObject({ status: 404, body: { code: "consultation_not_found" } });
    expect((await order({ patientId: patient.x, testIds: [T.glu], appointmentId: randomUUID() }))).toMatchObject({ status: 404, body: { code: "consultation_not_found" } });
  });

  it("who can order for whom: no relationship, another clinic and another role are all refused — and nothing is written", async () => {
    const countAll = async () => (await sql<{ n: number }[]>`select count(*)::int as n from public.lab_orders where clinic_id in ${sql([clinicA, clinicB])}`)[0].n;
    const before = await countAll();
    // Doctor C has no relationship with patient X: 404, exactly like any patient read, and the attempt is audited.
    as("c");
    expect((await order({ patientId: patient.x, testIds: [T.hb] }))).toMatchObject({ status: 404, body: { code: "patient_not_found" } });
    expect(await sql`select 1 from public.audit_events where action = 'unauthorized_clinical_access_attempt' and entity_id = ${patient.x} and actor_id = ${users.c}`).not.toHaveLength(0);
    // Doctor A and another clinic's patient / doctor B's patient of another clinic.
    as("a");
    expect((await order({ patientId: patient.k, testIds: [T.hb] })).status).toBe(404);
    as("k", "doctor", clinicB);
    expect((await order({ patientId: patient.x, testIds: [T.b] })).status).toBe(404);
    // Roles that are not the doctor's.
    for (const [name, role] of [["rec", "receptionist"], ["lab", "lab_staff"], ["owner", "owner"]] as const) {
      asRole(name, role);
      expect((await order({ patientId: patient.x, testIds: [T.hb] })).status, role).toBe(403);
    }
    session.ctx = null;
    expect((await order({ patientId: patient.x, testIds: [T.hb] })).status).toBe(401);
    expect(await countAll()).toBe(before);
  });

  it("tests and panels: inactive, unknown and another clinic's are refused; a referral must be this doctor's own", async () => {
    as("a");
    expect((await order({ patientId: patient.x, testIds: [T.old] }))).toMatchObject({ status: 409, body: { code: "lab_test_inactive" } });
    expect((await order({ patientId: patient.x, testIds: [T.hb, T.old] }))).toMatchObject({ status: 409, body: { code: "lab_test_inactive" } });
    expect((await order({ patientId: patient.x, panelIds: [panelBroken] }))).toMatchObject({ status: 409, body: { code: "lab_test_inactive" } });
    expect((await order({ patientId: patient.x, testIds: [T.b] }))).toMatchObject({ status: 404, body: { code: "lab_not_found" } });
    expect((await order({ patientId: patient.x, testIds: [randomUUID()] })).status).toBe(404);
    expect((await order({ patientId: patient.x, panelIds: [randomUUID()] })).status).toBe(404);
    // A retired panel.
    await sql`update public.lab_panels set active = false where id = ${panelFixed}`;
    expect((await order({ patientId: patient.x, panelIds: [panelFixed] }))).toMatchObject({ status: 409, body: { code: "lab_panel_inactive" } });
    await sql`update public.lab_panels set active = true where id = ${panelFixed}`;
    // Referral: one addressed to another doctor, or an unknown one, cannot be answered by this order.
    const [ref] = await sql<{ id: string }[]>`
      insert into public.referrals (clinic_id, patient_id, referring_doctor_id, referred_to_doctor_id, originating_appointment_id, reason, created_by)
      values (${clinicA}, ${patient.x}, ${doc.b}, ${doc.c}, ${consultOfB}, 'r', ${users.b}) returning id`;
    expect((await order({ patientId: patient.x, testIds: [T.glu], referralId: ref.id }))).toMatchObject({ status: 404, body: { code: "referral_not_found" } });
    expect((await order({ patientId: patient.x, testIds: [T.glu], referralId: randomUUID() })).status).toBe(404);
    // That referral gave doctor C access to the patient: remove it so later cases keep C unrelated.
    await sql`delete from public.referrals where id = ${ref.id}`;
    // A referral to this doctor is fine.
    const [mine] = await sql<{ id: string }[]>`
      insert into public.referrals (clinic_id, patient_id, referring_doctor_id, referred_to_doctor_id, originating_appointment_id, reason, created_by)
      values (${clinicA}, ${patient.x}, ${doc.b}, ${doc.a}, ${consultOfB}, 'r2', ${users.b}) returning id`;
    const withReferral = await order({ patientId: patient.x, testIds: [T.glu], referralId: mine.id });
    expect(withReferral.status).toBe(201);
    expect((await sql`select referral_id from public.lab_orders where id = ${withReferral.body.data!.order.id}`)[0].referral_id).toBe(mine.id);
  });

  it("idempotent: a repeat returns the first order, a concurrent burst creates exactly one, and a reused key for other content is a conflict", async () => {
    as("a");
    const before = (await orderRows(patient.x)).length;
    const key = randomUUID();
    const first = await order({ patientId: patient.x, testIds: [T.hb], idempotencyKey: key });
    expect(first.status).toBe(201);
    const again = await order({ patientId: patient.x, testIds: [T.hb], idempotencyKey: key });
    expect(again.status).toBe(200);
    expect(again.body.data!.order).toMatchObject({ id: first.body.data!.order.id, replayed: true });
    expect((await orderRows(patient.x)).length).toBe(before + 1);
    // The same key for different tests: refused, nothing changes.
    expect((await order({ patientId: patient.x, testIds: [T.glu], idempotencyKey: key }))).toMatchObject({ status: 409, body: { code: "idempotency_conflict" } });
    expect((await order({ patientId: patient.x, testIds: [T.hb, T.glu], idempotencyKey: key })).body.code).toBe("idempotency_conflict");
    // A concurrent burst: exactly one order, every answer names it.
    const burstKey = randomUUID();
    const burst = await Promise.all(Array.from({ length: 8 }, () => order({ patientId: patient.x, testIds: [T.glu], idempotencyKey: burstKey })));
    expect(burst.every((r) => r.status === 201 || r.status === 200)).toBe(true);
    expect(burst.filter((r) => r.status === 201)).toHaveLength(1);
    expect(new Set(burst.map((r) => r.body.data!.order.id)).size).toBe(1);
    expect((await orderRows(patient.x)).length).toBe(before + 2);
    // Another doctor's identical key is another order (keys are per ordering doctor).
    expect((await sql`select count(*)::int as n from public.lab_orders where creation_key = ${burstKey}`)[0].n).toBe(1);
  });

  it("all or nothing: an order whose item the database refuses leaves no order behind", async () => {
    as("a");
    const before = (await orderRows(patient.x)).length;
    // The test is deactivated between the server's check and the write: simulate with the database function directly.
    await sql`update public.lab_tests set active = false where id = ${T.glu}`;
    try {
      const err = await sql`select public.lab_create_order(${clinicA}, ${users.a}, ${patient.x}, ${doc.a}, ${consult}, null, 'routine', null, ${randomUUID()}, ${sql.json([{ test_id: T.hb }, { test_id: T.glu }])})`.then(() => "no error", (e) => String(e.message));
      expect(err).toContain("inactive");
    } finally {
      await sql`update public.lab_tests set active = true where id = ${T.glu}`;
    }
    expect((await orderRows(patient.x)).length).toBe(before);
    // The function is callable by the server only.
    let code = "executed";
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("set local role authenticated");
        await tx`select public.lab_create_order(${clinicA}, ${users.a}, ${patient.x}, ${doc.a}, ${consult}, null, 'routine', null, null, ${sql.json([])})`;
      });
    } catch (e) {
      code = (e as postgres.PostgresError).code ?? "error";
    }
    expect(code).toBe("42501");
  });

  it("rate limits: ordering and the similar-test notice are limited per doctor, and a limit never writes an order", async () => {
    as("a");
    const before = (await orderRows(patient.x)).length;
    await sql`insert into public.rate_limit_buckets (key, window_started_at, hits) values (${`doctor-lab-order:${users.a}`}, now(), 30)`;
    expect((await order({ patientId: patient.x, testIds: [T.hb] })).status).toBe(429);
    expect((await orderRows(patient.x)).length).toBe(before);
    // Another doctor is not affected.
    as("b");
    expect((await order({ patientId: patient.x, testIds: [T.hb] })).status).not.toBe(429);
    await sql`insert into public.rate_limit_buckets (key, window_started_at, hits) values (${`doctor-lab-lookup:${users.a}`}, now(), 60)`;
    as("a");
    expect((await similar({ patientId: patient.x, testIds: [T.hb] })).status).toBe(429);
  });

  // ---------- the patient's orders and the advisory notice ----------

  it("the patient's orders: every doctor's, for doctors with the history — refused for the rest, audited on each read, no result value", async () => {
    // Doctor B treated patient X (consultOfB): they see doctor A's orders too — the longitudinal record.
    as("b");
    const res = await listFor(patient.x);
    expect(res.status).toBe(200);
    const orders = res.body.data!.orders as Array<{ id: string; isOwn: boolean; orderedBy: string; notes: string | null; items: Array<{ resultStatus: string }> }>;
    expect(orders.length).toBeGreaterThan(0);
    expect(orders.every((o) => o.isOwn === false)).toBe(true);
    expect(orders[0].orderedBy).toBe(`Dr A ${suffix}`);
    expect(orders.some((o) => o.notes === NOTE)).toBe(true);
    expect(orders[0].items[0]).toHaveProperty("resultStatus");
    const trail = await sql<{ metadata: { order_ids: string[]; via: string }; actor_id: string }[]>`
      select metadata, actor_id from public.audit_events where action = 'lab_order_viewed' and entity_id = ${patient.x} and actor_id = ${users.b}`;
    expect(trail.length).toBeGreaterThan(0);
    expect(trail[0].metadata.order_ids.length).toBe(orders.length);
    expect(JSON.stringify(trail)).not.toContain(NOTE);
    // Own orders are marked as such.
    as("a");
    expect(((await listFor(patient.x)).body.data!.orders as { isOwn: boolean }[]).every((o) => o.isOwn)).toBe(true);
    // No relationship (doctor C), another clinic's patient, a malformed id, other roles.
    as("c");
    expect((await listFor(patient.x))).toMatchObject({ status: 404, body: { code: "patient_not_found" } });
    as("a");
    expect((await listFor(patient.k)).status).toBe(404);
    expect((await listFor("not-a-uuid")).status).toBe(404);
    asRole("rec", "receptionist");
    expect((await listFor(patient.x)).status).toBe(403);
    asRole("owner", "manager");
    expect((await listFor(patient.x)).status).toBe(403);
  });

  it("similar test notice: advisory only — same test, same patient, inside the window, no cancelled orders, no values; a clinic can switch it off", async () => {
    as("a");
    // Doctor A ordered CBC and glucose for patient X earlier in this suite.
    const notices = (await similar({ patientId: patient.x, testIds: [T.hb] })).body.data!.notices as Array<{ code: string; daysAgo: number; isOwn: boolean; resultAvailable: boolean; orderId: string; orderStatus: string }>;
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ code: `CBC-${suffix}`, daysAgo: 0, isOwn: true, resultAvailable: false });
    // Panels count through their tests; a test never ordered gives nothing; another patient's history is not this patient's.
    expect(((await similar({ patientId: patient.x, panelIds: [panelOk] })).body.data!.notices as unknown[]).length).toBe(2);
    expect(((await similar({ patientId: patient.y, testIds: [T.hb] })).body.data!.notices as unknown[]).length).toBe(0);
    // It never blocks: ordering the same test again still works.
    expect((await order({ patientId: patient.x, testIds: [T.hb] })).status).toBe(201);

    // A verified earlier result is reported as available — without its value.
    const earlier = (await similar({ patientId: patient.x, testIds: [T.glu] })).body.data!.notices[0];
    const [item] = await sql<{ id: string; order_id: string }[]>`select i.id, i.order_id from public.lab_order_items i where i.order_id = ${earlier.orderId} and i.test_id = ${T.glu}`;
    const [r] = await sql<{ id: string }[]>`insert into public.lab_results (clinic_id, order_item_id, order_id, patient_id) values (${clinicA}, ${item.id}, ${item.order_id}, ${patient.x}) returning id`;
    const [v] = await sql<{ id: string }[]>`insert into public.lab_result_versions (clinic_id, result_id, entered_by) values (${clinicA}, ${r.id}, ${users.lab}) returning id`;
    const [hgb] = await sql<{ id: string }[]>`insert into public.lab_test_parameters (clinic_id, test_id, code, name, unit, data_type) values (${clinicA}, ${T.glu}, 'GLU', 'Glucose', 'mmol/L', 'numeric') returning id`;
    await sql`insert into public.lab_result_values (clinic_id, version_id, parameter_id, value_numeric) values (${clinicA}, ${v.id}, ${hgb.id}, 6.789)`;
    await sql`update public.lab_result_versions set status = 'pending_verification' where id = ${v.id}`;
    await sql`update public.lab_result_versions set status = 'verified', verified_by = ${users.ver} where id = ${v.id}`;
    const withResult = await similar({ patientId: patient.x, testIds: [T.glu] });
    expect(withResult.body.data!.notices[0]).toMatchObject({ resultAvailable: true });
    expect(JSON.stringify(withResult.body)).not.toMatch(/6\.789|mmol/);

    // Doctor B (treating) gets the same notice; doctor C (no relationship) is refused.
    as("b");
    expect(((await similar({ patientId: patient.x, testIds: [T.hb] })).body.data!.notices as { isOwn: boolean }[])[0].isOwn).toBe(false);
    as("c");
    expect((await similar({ patientId: patient.x, testIds: [T.hb] })).status).toBe(404);
    // A selection that cannot be ordered is refused here too (inactive / another clinic's test).
    as("a");
    expect((await similar({ patientId: patient.x, testIds: [T.old] })).status).toBe(409);
    expect((await similar({ patientId: patient.x, testIds: [T.b] })).status).toBe(404);
    expect((await similar({ patientId: patient.x, testIds: [] , panelIds: [] })).status).toBe(400);

    // The clinic's setting: 0 switches the notice off; the notice is audited as a read of the history.
    asRole("owner", "owner");
    const put = (days: number) =>
      settingsRoute.PUT(req("PUT", "/api/admin/lab/settings", { verification: { required: true, separateVerifier: false }, collection: { requiresPayment: false }, ordering: { recentTestWindowDays: days } }));
    expect((await put(0)).status).toBe(200);
    as("a");
    expect(((await similar({ patientId: patient.x, testIds: [T.hb] })).body.data!.notices as unknown[]).length).toBe(0);
    asRole("owner", "owner");
    expect((await put(30)).status).toBe(200);
    expect(await sql`select 1 from public.audit_events where action = 'lab_order_viewed' and metadata ->> 'via' = 'similar_notice' and patient_id = ${patient.x}`).not.toHaveLength(0);

    // A cancelled order no longer counts.
    const [cancelMe] = await sql<{ id: string }[]>`select id from public.lab_orders where patient_id = ${patient.y} limit 1`;
    await sql`update public.lab_orders set status = 'cancelled', cancelled_by = ${users.owner}, cancel_reason = 'test' where id = ${cancelMe.id}`;
    as("a");
    expect(((await similar({ patientId: patient.y, testIds: [T.glu] })).body.data!.notices as unknown[]).length).toBe(0);
  });
});
