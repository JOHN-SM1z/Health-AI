import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { localDbAvailable } from "@/test/local-db";

/**
 * Clinic laboratory configuration (Phase 4) against the real database: the
 * real guards (requireLabCapability) run with only the session stubbed.
 * Management configures a CBC / biochemistry catalog with parameters, sex-
 * and age-specific ranges and a panel; other roles and other clinics are
 * refused; bad configuration is rejected; every change is audited with the
 * actor; inactive tests stay in the catalog; malformed stored settings fall
 * back to safe defaults.
 */

const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const session = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/staff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/staff")>();
  return { ...actual, getStaffContext: async () => session.ctx };
});

import { GET as getCatalog } from "./catalog/route";
import { POST, PATCH } from "./[kind]/route";
import { GET as getSettings, PUT as putSettings } from "./settings/route";

const describeDb = describe.skipIf(!localDbAvailable());

type Body = { ok: boolean; data?: Record<string, unknown> & { [k: string]: unknown }; error?: string; code?: string };
type Catalog = {
  categories: Array<{ id: string; name: string }>;
  tests: Array<{ id: string; code: string; active: boolean; price: number }>;
  parameters: Array<{ id: string; test_id: string; value_type: string }>;
  ranges: Array<{ id: string; parameter_id: string; active: boolean }>;
  panels: Array<{ id: string; test_ids: string[] }>;
};

describeDb("lab configuration API (real database)", () => {
  let admin: SupabaseClient;
  const suffix = Date.now().toString(36);
  const clinicA = randomUUID();
  const clinicB = randomUUID();
  const people = {
    managerA: randomUUID(),
    receptionistA: randomUUID(),
    doctorA: randomUUID(),
    labA: randomUUID(),
    ownerB: randomUUID(),
  };

  const as = (profileId: string, role: string, clinicId = clinicA) => {
    session.ctx = { profileId, clinicId, clinicName: "Lab", clinicTimezone: "Asia/Tashkent", roles: [role], platformAdmin: false };
  };

  async function call(handler: (r: NextRequest, c: { params: Promise<{ kind: string }> }) => Promise<Response>, method: string, kind: string, body?: unknown, id?: string) {
    const url = `http://localhost/api/admin/lab/${kind}${id ? `?id=${id}` : ""}`;
    const res = await handler(
      new NextRequest(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }),
      { params: Promise.resolve({ kind }) },
    );
    return { status: res.status, body: (await res.json()) as Body };
  }
  const post = (kind: string, body: unknown) => call(POST, "POST", kind, body);
  const patch = (kind: string, id: string, body: unknown) => call(PATCH, "PATCH", kind, body, id);
  const idOf = (r: { body: Body }, key: string) => (r.body.data?.[key] as { id: string }).id;
  const catalog = async () => {
    const res = await getCatalog();
    return { status: res.status, body: (await res.json()) as { data: Catalog } };
  };

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    await admin.from("clinics").insert([
      { id: clinicA, name: `Lab cfg A ${suffix}`, slug: `lab-cfg-a-${suffix}` },
      { id: clinicB, name: `Lab cfg B ${suffix}`, slug: `lab-cfg-b-${suffix}` },
    ]);
    for (const [name, id] of Object.entries(people)) {
      const { error } = await admin.auth.admin.createUser({ id, email: `lab-cfg-${name}-${suffix}@test.local`, email_confirm: true, password: `Pw-${randomUUID()}` });
      if (error) throw new Error(`createUser: ${error.message}`);
      await admin.from("profiles").insert({ id, full_name: name });
    }
    await admin.from("staff_roles").insert([
      { clinic_id: clinicA, profile_id: people.managerA, role: "manager" },
      { clinic_id: clinicA, profile_id: people.receptionistA, role: "receptionist" },
      { clinic_id: clinicA, profile_id: people.doctorA, role: "doctor" },
      { clinic_id: clinicA, profile_id: people.labA, role: "lab" },
      { clinic_id: clinicB, profile_id: people.ownerB, role: "owner" },
    ]);
  });

  afterAll(async () => {
    if (!admin) return;
    await admin.from("clinics").delete().in("id", [clinicA, clinicB]);
    for (const id of Object.values(people)) await admin.auth.admin.deleteUser(id);
  });

  beforeEach(() => as(people.managerA, "manager"));

  it("refuses configuration to reception, doctors, lab staff and anonymous callers", async () => {
    for (const [profile, role] of [
      [people.receptionistA, "receptionist"],
      [people.doctorA, "doctor"],
      [people.labA, "lab"],
    ] as const) {
      as(profile, role);
      expect((await post("tests", { code: "X1", name: "X", sampleType: "Blood", price: 1 })).status).toBe(403);
      expect((await call(PUT_SETTINGS, "PUT", "settings", { paymentPolicy: "not_required", releaseToPatient: true, verifiers: "lab_and_doctor" })).status).toBe(403);
      // Everyone on the staff may read the catalog (it holds no patient data).
      expect((await catalog()).status).toBe(200);
    }
    session.ctx = null;
    expect((await post("tests", { code: "X1", name: "X", sampleType: "Blood", price: 1 })).status).toBe(401);
    expect((await catalog()).status).toBe(401);
  });

  it("configures a CBC with parameters, sex/age ranges, a biochemistry test and a panel — audited with the actor", async () => {
    const blood = await post("categories", { name: `Qon tahlili ${suffix}` });
    expect(blood.status).toBe(201);
    const bio = await post("categories", { name: `Bioximiya ${suffix}` });
    const cbc = await post("tests", {
      code: `CBC${suffix}`, name: `Umumiy qon tahlili ${suffix}`, categoryId: idOf(blood, "category"),
      sampleType: "Vena qoni", preparationText: "Och qoringa", turnaroundHours: 24, price: 100000,
    });
    expect(cbc.status).toBe(201);
    const glucose = await post("tests", {
      code: `GLU${suffix}`, name: `Glyukoza ${suffix}`, categoryId: idOf(bio, "category"), sampleType: "Vena qoni", price: 50000,
    });
    const hgb = await post("parameters", { testId: idOf(cbc, "test"), code: "HGB", name: "Gemoglobin", valueType: "numeric", unit: "g/L" });
    expect(hgb.status).toBe(201);
    await post("parameters", { testId: idOf(cbc, "test"), code: "WBC", name: "Leykotsitlar", valueType: "numeric", unit: "10^9/L" });
    const female = await post("ranges", { parameterId: idOf(hgb, "parameter"), sex: "female", ageMinDays: 6570, low: 120, high: 150, criticalLow: 70 });
    expect(female.status).toBe(201);
    expect((await post("ranges", { parameterId: idOf(hgb, "parameter"), sex: "male", ageMinDays: 6570, low: 130, high: 170 })).status).toBe(201);
    const panel = await post("panels", { code: `PN${suffix}`, name: `Tekshiruv paneli ${suffix}`, price: 120000, testIds: [idOf(cbc, "test"), idOf(glucose, "test")] });
    expect(panel.status).toBe(201);

    const { body } = await catalog();
    expect(body.data.tests.map((t) => t.code)).toEqual(expect.arrayContaining([`CBC${suffix}`, `GLU${suffix}`]));
    expect(body.data.parameters.filter((p) => p.test_id === idOf(cbc, "test"))).toHaveLength(2);
    expect(body.data.panels.find((p) => p.id === idOf(panel, "panel"))?.test_ids).toEqual([idOf(cbc, "test"), idOf(glucose, "test")]);

    const { data: audit } = await admin
      .from("audit_events")
      .select("action, actor_id")
      .eq("clinic_id", clinicA)
      .in("entity_id", [idOf(cbc, "test"), idOf(female, "range"), idOf(panel, "panel")]);
    expect(audit).toEqual(
      expect.arrayContaining([
        { action: "lab_test_created", actor_id: people.managerA },
        { action: "lab_range_created", actor_id: people.managerA },
        { action: "lab_panel_created", actor_id: people.managerA },
      ]),
    );
  });

  it("rejects invalid configuration with plain messages", async () => {
    const test = await post("tests", { code: `V${suffix}`, name: `Validation ${suffix}`, sampleType: "Siydik", price: 1000 });
    expect((await post("tests", { code: "bad code!", name: "X", sampleType: "Blood", price: 1 })).status).toBe(400);
    expect((await post("tests", { code: "NEG1", name: "Neg", sampleType: "Blood", price: -5 })).status).toBe(400);
    const dup = await post("tests", { code: `V${suffix}`, name: `Other ${suffix}`, sampleType: "Siydik", price: 1 });
    expect(dup.status).toBe(409);
    expect((await post("parameters", { testId: idOf(test, "test"), code: "C1", name: "Choice", valueType: "choice" })).status).toBe(400);
    expect((await post("parameters", { testId: idOf(test, "test"), code: "T1", name: "Text", valueType: "text", unit: "mg" })).status).toBe(400);

    const numeric = await post("parameters", { testId: idOf(test, "test"), code: "N1", name: "Num", valueType: "numeric" });
    expect((await post("ranges", { parameterId: idOf(numeric, "parameter"), low: 10, high: 5 })).status).toBe(400);
    expect((await post("ranges", { parameterId: idOf(numeric, "parameter") })).status).toBe(400);
    expect((await post("ranges", { parameterId: idOf(numeric, "parameter"), normalText: "negative" })).status).toBe(400);
    expect((await post("ranges", { parameterId: idOf(numeric, "parameter"), low: 1, high: 5 })).status).toBe(201);
    const overlap = await post("ranges", { parameterId: idOf(numeric, "parameter"), low: 2, high: 6 });
    expect(overlap.status).toBe(409);
    expect(overlap.body.code).toBe("range_overlap");

    expect((await call(POST, "POST", "invoices", {})).status).toBe(404);
    expect((await patch("tests", "not-a-uuid", { price: 1 })).status).toBe(400);
  });

  it("keeps a choice that an active range expects, and never changes a parameter's type", async () => {
    const test = await post("tests", { code: `U${suffix}`, name: `Urine ${suffix}`, sampleType: "Siydik", price: 1000 });
    const protein = await post("parameters", {
      testId: idOf(test, "test"), code: "PRO", name: "Oqsil", valueType: "choice", choices: ["manfiy", "musbat"],
    });
    expect((await post("ranges", { parameterId: idOf(protein, "parameter"), normalText: "manfiy" })).status).toBe(201);
    const removing = await patch("parameters", idOf(protein, "parameter"), { choices: ["musbat", "iz"] });
    expect(removing.status).toBe(409);
    await patch("parameters", idOf(protein, "parameter"), { valueType: "numeric", name: "Oqsil (siydikda)" });
    const { data } = await admin.from("lab_test_parameters").select("value_type, name").eq("id", idOf(protein, "parameter")).single();
    expect(data).toEqual({ value_type: "choice", name: "Oqsil (siydikda)" });
  });

  it("deactivates instead of deleting: an inactive test stays in the catalog", async () => {
    const test = await post("tests", { code: `D${suffix}`, name: `Deactivate ${suffix}`, sampleType: "Qon", price: 1000 });
    expect((await patch("tests", idOf(test, "test"), { active: false })).status).toBe(200);
    const { body } = await catalog();
    expect(body.data.tests.find((t) => t.id === idOf(test, "test"))).toMatchObject({ active: false });
  });

  it("never lets one clinic read or change another clinic's configuration", async () => {
    const test = await post("tests", { code: `X${suffix}`, name: `Cross ${suffix}`, sampleType: "Qon", price: 1000 });
    const testId = idOf(test, "test");
    as(people.ownerB, "owner", clinicB);
    expect((await patch("tests", testId, { price: 1 })).status).toBe(404);
    expect((await post("parameters", { testId, code: "P1", name: "P", valueType: "numeric" })).status).toBe(400);
    expect((await post("panels", { code: "PB", name: "PB", price: 1, testIds: [testId, randomUUID()] })).status).toBe(400);
    expect((await post("tests", { code: "B1", name: "B", sampleType: "Qon", categoryId: randomUUID(), price: 1 })).status).toBe(400);
    const { body } = await catalog();
    expect(body.data.tests.find((t) => t.id === testId)).toBeUndefined();
    const { data } = await admin.from("lab_tests").select("price").eq("id", testId).single();
    expect(Number(data!.price)).toBe(1000);
  });

  it("stores lab settings, validates them, and reads malformed stored values as safe defaults", async () => {
    const get = async () => ((await (await getSettings()).json()) as { data: { settings: unknown } }).data.settings;
    expect(await get()).toEqual({ paymentPolicy: "not_required", releaseToPatient: true, verifiers: "lab_and_doctor", notifyStaff: true, notifyPatientOnCancel: false, aiSummaries: false });
    expect((await call(PUT_SETTINGS, "PUT", "settings", { paymentPolicy: "always", releaseToPatient: true, verifiers: "lab_and_doctor" })).status).toBe(400);
    expect((await call(PUT_SETTINGS, "PUT", "settings", { paymentPolicy: "not_required", releaseToPatient: true, verifiers: "nobody" })).status).toBe(400);
    expect((await call(PUT_SETTINGS, "PUT", "settings", { paymentPolicy: "before_collection", releaseToPatient: false, verifiers: "lab_only" })).status).toBe(200);
    expect(await get()).toEqual({ paymentPolicy: "before_collection", releaseToPatient: false, verifiers: "lab_only", notifyStaff: true, notifyPatientOnCancel: false, aiSummaries: false });
    // Written around the API (management can write app_settings directly).
    await admin.from("app_settings").upsert({ clinic_id: clinicA, key: "lab", value: { paymentPolicy: 42, releaseToPatient: "yes", verifiers: "everyone", notifyStaff: "no", notifyPatientOnCancel: 1, aiSummaries: "true" } });
    expect(await get()).toEqual({ paymentPolicy: "not_required", releaseToPatient: true, verifiers: "lab_and_doctor", notifyStaff: true, notifyPatientOnCancel: false, aiSummaries: false });
    // One malformed field never resets the others.
    await admin.from("app_settings").upsert({ clinic_id: clinicA, key: "lab", value: { paymentPolicy: "before_collection", releaseToPatient: false, verifiers: "everyone" } });
    expect(await get()).toEqual({ paymentPolicy: "before_collection", releaseToPatient: false, verifiers: "lab_and_doctor", notifyStaff: true, notifyPatientOnCancel: false, aiSummaries: false });
  });
});

// The settings route has no [kind]; adapt it to call().
const PUT_SETTINGS = (request: NextRequest) => putSettings(request);
