import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import postgres from "postgres";
import { cleanupTestClinics } from "@/test/cleanup-clinics";
import { localDbAvailable } from "@/test/local-db";

/**
 * Laboratory configuration through the REAL routes, guards and database (phase 3): who may configure and
 * who may only read, clinic isolation of every id, validation that refuses what is not the client's to
 * set, the per-clinic workflow settings, and an audit trail with ids only.
 *
 * Mocked: only the staff session lookup (getStaffContext) — the guards (requireRoles) run for real, so the
 * role lists in src/lib/auth/staff.ts and src/lib/labs/access.ts are what is under test.
 */

const session = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/staff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/staff")>();
  return { ...actual, getStaffContext: async () => session.ctx };
});

import * as categories from "./categories/route";
import * as tests from "./tests/route";
import * as parameters from "./parameters/route";
import * as ranges from "./ranges/route";
import * as panels from "./panels/route";
import * as settings from "./settings/route";

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const describeDb = describe.skipIf(!localDbAvailable());

// Response bodies are navigated freely in assertions (rows of the configuration API); a precise type per route adds nothing here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = { ok: boolean; data?: Record<string, any>; code?: string; error?: string };
type Role = "owner" | "admin" | "manager" | "receptionist" | "doctor" | "lab_staff";

describeDb("laboratory configuration — real routes and database", () => {
  let sql: postgres.Sql;
  const suffix = Date.now().toString(36);
  const clinicA = randomUUID();
  const clinicB = randomUUID();
  const users: Record<string, string> = {
    owner: randomUUID(), admin: randomUUID(), manager: randomUUID(), receptionist: randomUUID(),
    doctor: randomUUID(), lab: randomUUID(), ownerB: randomUUID(),
  };

  const as = (name: keyof typeof users, role: Role, clinic = clinicA) => {
    session.ctx = { profileId: users[name], clinicId: clinic, clinicName: "Lab config", clinicTimezone: "Asia/Tashkent", roles: [role], platformAdmin: false };
  };
  const asOwner = () => as("owner", "owner");
  const asOwnerB = () => as("ownerB", "owner", clinicB);
  const read = async (res: Response): Promise<{ status: number; body: Json }> => ({ status: res.status, body: (await res.json()) as Json });
  const req = (method: string, path: string, body?: unknown) =>
    new NextRequest(`http://localhost${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  type Handler = (r: NextRequest) => Promise<Response>;
  const call = async (handler: Handler, method: string, path: string, body?: unknown) => read(await handler(req(method, path, body)));
  const auditOf = (entity: string) =>
    sql<{ action: string; actor_id: string | null; new_values: unknown }[]>`select action, actor_id, new_values from public.audit_events where entity_id = ${entity} order by created_at, action`;

  beforeAll(async () => {
    sql = postgres(DB_URL, { max: 4, onnotice: () => {} });
    await sql`insert into public.clinics ${sql([
      { id: clinicA, name: `Lab Config A ${suffix}`, slug: `lab-config-a-${suffix}`, timezone: "Asia/Tashkent" },
      { id: clinicB, name: `Lab Config B ${suffix}`, slug: `lab-config-b-${suffix}`, timezone: "Asia/Tashkent" },
    ])}`;
    const rows = Object.entries(users).map(([name, id]) => ({ id, email: `labcfg-${name}-${suffix}@test.local` }));
    await sql`insert into auth.users ${sql(rows)}`;
    await sql`insert into public.profiles ${sql(rows.map((u) => ({ id: u.id, full_name: u.email })))}`;
    await sql`insert into public.staff_roles ${sql([
      { clinic_id: clinicA, profile_id: users.owner, role: "owner" },
      { clinic_id: clinicA, profile_id: users.admin, role: "admin" },
      { clinic_id: clinicA, profile_id: users.manager, role: "manager" },
      { clinic_id: clinicA, profile_id: users.receptionist, role: "receptionist" },
      { clinic_id: clinicA, profile_id: users.doctor, role: "doctor" },
      { clinic_id: clinicA, profile_id: users.lab, role: "lab_staff" },
      { clinic_id: clinicB, profile_id: users.ownerB, role: "owner" },
    ])}`;
  });

  afterAll(async () => {
    if (!sql) return;
    await cleanupTestClinics([clinicA, clinicB]);
    await sql`delete from auth.users where id in ${sql(Object.values(users))}`;
    await sql.end({ timeout: 5 });
  });

  // ---------- who may do what ----------

  it("configure: owner, admin and manager; read: also laboratory staff; doctors, receptionists and anonymous: nothing", async () => {
    const write = (name: string) => ({ code: `W-${name}-${suffix}`.slice(0, 32), name: `Test by ${name}`, price: 1000 });
    for (const [name, role] of [["owner", "owner"], ["admin", "admin"], ["manager", "manager"]] as const) {
      as(name, role);
      expect((await call(tests.POST, "POST", "/api/admin/lab/tests", write(name))).status, `${role} creates`).toBe(201);
      for (const [handler, path] of [[tests.GET, "/api/admin/lab/tests"], [categories.GET, "/api/admin/lab/categories"], [panels.GET, "/api/admin/lab/panels"], [settings.GET, "/api/admin/lab/settings"]] as const) {
        expect((await call(handler as Handler, "GET", path)).status, `${role} reads ${path}`).toBe(200);
      }
    }
    // Laboratory staff read the configuration they work from — and cannot change any of it.
    as("lab", "lab_staff");
    for (const [handler, path] of [[tests.GET, "/api/admin/lab/tests"], [categories.GET, "/api/admin/lab/categories"], [panels.GET, "/api/admin/lab/panels"], [settings.GET, "/api/admin/lab/settings"]] as const) {
      expect((await call(handler as Handler, "GET", path)).status, `lab reads ${path}`).toBe(200);
    }
    const writes: Array<[Handler, string, string, unknown]> = [
      [tests.POST, "POST", "/api/admin/lab/tests", write("lab")],
      [categories.POST, "POST", "/api/admin/lab/categories", { name: "x" }],
      [parameters.POST, "POST", "/api/admin/lab/parameters", { testId: randomUUID(), code: "A", name: "a" }],
      [ranges.POST, "POST", "/api/admin/lab/ranges", { parameterId: randomUUID(), low: 1 }],
      [panels.POST, "POST", "/api/admin/lab/panels", { code: "P", name: "p", testIds: [randomUUID()] }],
      [settings.PUT, "PUT", "/api/admin/lab/settings", { verification: { required: false, separateVerifier: false }, collection: { requiresPayment: false } }],
      [tests.PATCH, "PATCH", `/api/admin/lab/tests?id=${randomUUID()}`, { active: false }],
    ];
    for (const [handler, method, path, body] of writes) {
      expect((await call(handler, method, path, body)).status, `lab ${method} ${path}`).toBe(403);
    }
    // Doctors (they order through their own routes, phase 4) and receptionists have no configuration access at all.
    for (const [name, role] of [["doctor", "doctor"], ["receptionist", "receptionist"]] as const) {
      as(name, role);
      for (const [handler, method, path, body] of [...writes, [tests.GET, "GET", "/api/admin/lab/tests", undefined], [settings.GET, "GET", "/api/admin/lab/settings", undefined]] as Array<[Handler, string, string, unknown]>) {
        expect((await call(handler, method, path, body)).status, `${role} ${method} ${path}`).toBe(403);
      }
    }
    // Not signed in, and a platform admin (no clinic): refused before anything else.
    session.ctx = null;
    expect((await call(tests.GET, "GET", "/api/admin/lab/tests")).status).toBe(401);
    session.ctx = { profileId: users.owner, clinicId: null, clinicName: "", clinicTimezone: "UTC", roles: [], platformAdmin: true };
    expect((await call(tests.GET, "GET", "/api/admin/lab/tests")).status).toBe(401);
    // Nothing the refused roles sent was written.
    expect((await sql`select 1 from public.lab_tests where clinic_id = ${clinicA} and code like ${`W-lab-%`}`)).toHaveLength(0);
  });

  // ---------- the configuration itself ----------

  it("builds a test with its category, parameters, reference ranges and a panel; the author and the audit are the server's, ids only", async () => {
    asOwner();
    const cat = (await call(categories.POST, "POST", "/api/admin/lab/categories", { name: `Blood ${suffix}`, sortOrder: 1 })).body.data!.category;
    const test = (await call(tests.POST, "POST", "/api/admin/lab/tests", {
      code: `CBC-${suffix}`, name: "Complete blood count", categoryId: cat.id, price: 85000.5, sampleType: "blood",
      preparationText: "No preparation", turnaroundMinutes: 120,
    }));
    expect(test.status).toBe(201);
    const t = test.body.data!.test;
    expect(t).toMatchObject({ clinic_id: clinicA, category_id: cat.id, price: 85000.5, updated_by: users.owner, active: true });
    const hgb = (await call(parameters.POST, "POST", "/api/admin/lab/parameters", { testId: t.id, code: "HGB", name: "Hemoglobin", unit: "g/L", displayOrder: 1 })).body.data!.parameter;
    const app = (await call(parameters.POST, "POST", "/api/admin/lab/parameters", { testId: t.id, code: "APP", name: "Appearance", dataType: "choice", choices: ["clear", "turbid"], displayOrder: 2 })).body.data!.parameter;
    const range = await call(ranges.POST, "POST", "/api/admin/lab/ranges", { parameterId: hgb.id, low: 120, high: 160, criticalLow: 70, criticalHigh: 200, ageMinYears: 18 });
    expect(range.status).toBe(201);

    const detail = (await call(tests.GET, "GET", `/api/admin/lab/tests?id=${t.id}`)).body.data!.test;
    expect(detail.parameters.map((p: { code: string }) => p.code)).toEqual(["HGB", "APP"]);
    expect(detail.parameters[0].ranges).toHaveLength(1);
    expect(detail.parameters[0].ranges[0]).toMatchObject({ low: 120, high: 160, critical_low: 70, critical_high: 200, updated_by: users.owner });
    expect(app.choices).toEqual(["clear", "turbid"]);

    const panel = await call(panels.POST, "POST", "/api/admin/lab/panels", { code: `PAN-${suffix}`, name: "Basic panel", price: null, testIds: [t.id] });
    expect(panel.status).toBe(201);
    const listedPanels = (await call(panels.GET, "GET", "/api/admin/lab/panels")).body.data!.panels;
    expect(listedPanels.find((p: { id: string }) => p.id === panel.body.data!.panel.id)).toMatchObject({ testIds: [t.id], price: null });

    // The trail names who changed which row and which columns — never prices or ranges.
    const rows = await auditOf(t.id);
    expect(rows[0]).toMatchObject({ action: "lab_catalog_created", actor_id: users.owner });
    await call(tests.PATCH, "PATCH", `/api/admin/lab/tests?id=${t.id}`, { price: 91234.56 });
    const updated = (await auditOf(t.id)).find((r) => r.action === "lab_catalog_updated")!;
    expect(updated).toMatchObject({ actor_id: users.owner, new_values: { changed_columns: ["price"] } });
    // (Only the payload is searched: ids are random hex and can contain any short run of digits.)
    const payloads = [...(await auditOf(t.id)), ...(await auditOf(range.body.data!.range.id))].map((r) => r.new_values);
    expect(JSON.stringify(payloads)).not.toMatch(/85000|91234|120|160|200/);
  });

  it("inactive tests leave the ordering list but stay in the configuration; duplicates and malformed values are refused", async () => {
    asOwner();
    const t = (await call(tests.POST, "POST", "/api/admin/lab/tests", { code: `OLD-${suffix}`, name: "Retired test", price: 100 })).body.data!.test;
    await call(tests.PATCH, "PATCH", `/api/admin/lab/tests?id=${t.id}`, { active: false });
    const names = async (qs = "") => ((await call(tests.GET, "GET", `/api/admin/lab/tests${qs}`)).body.data!.tests as { id: string }[]).map((x) => x.id);
    expect(await names()).not.toContain(t.id);
    expect(await names("?includeInactive=1")).toContain(t.id);
    // The same code again (any case) in this clinic, an impossible price, a bad code, an inverted range, a range for a choice parameter.
    expect((await call(tests.POST, "POST", "/api/admin/lab/tests", { code: `old-${suffix}`, name: "dup", price: 1 })).status).toBe(409);
    expect((await call(tests.POST, "POST", "/api/admin/lab/tests", { code: "OK1", name: "x", price: -5 })).status).toBe(400);
    expect((await call(tests.POST, "POST", "/api/admin/lab/tests", { code: "bad code!", name: "x", price: 5 })).status).toBe(400);
    expect((await call(tests.POST, "POST", "/api/admin/lab/tests", { code: "OK2", name: "x", price: 1.005 })).status).toBe(400);
    const good = (await call(tests.POST, "POST", "/api/admin/lab/tests", { code: `RNG-${suffix}`, name: "Range test", price: 1 })).body.data!.test;
    const num = (await call(parameters.POST, "POST", "/api/admin/lab/parameters", { testId: good.id, code: "N", name: "n" })).body.data!.parameter;
    const choice = (await call(parameters.POST, "POST", "/api/admin/lab/parameters", { testId: good.id, code: "C", name: "c", dataType: "choice", choices: ["a"] })).body.data!.parameter;
    expect((await call(ranges.POST, "POST", "/api/admin/lab/ranges", { parameterId: num.id, low: 10, high: 5 })).status).toBe(400);
    expect((await call(ranges.POST, "POST", "/api/admin/lab/ranges", { parameterId: num.id })).status).toBe(400);
    const choiceRange = await call(ranges.POST, "POST", "/api/admin/lab/ranges", { parameterId: choice.id, low: 1 });
    expect(choiceRange.status).toBe(409);
    expect((await call(parameters.POST, "POST", "/api/admin/lab/parameters", { testId: good.id, code: "X", name: "x", dataType: "choice" })).status).toBe(400); // choices missing
    // A panel needs tests, without repeats.
    expect((await call(panels.POST, "POST", "/api/admin/lab/panels", { code: "EMPTY", name: "e", testIds: [] })).status).toBe(400);
    expect((await call(panels.POST, "POST", "/api/admin/lab/panels", { code: "REP", name: "r", testIds: [good.id, good.id] })).status).toBe(400);
  });

  it("the request cannot name a clinic or an author: strict schemas refuse, and the session decides", async () => {
    asOwner();
    for (const extra of [{ clinicId: clinicB }, { clinic_id: clinicB }, { updatedBy: users.ownerB }, { updated_by: users.ownerB }, { id: randomUUID() }]) {
      const res = await call(tests.POST, "POST", "/api/admin/lab/tests", { code: `STR-${suffix}`.slice(0, 32), name: "x", price: 1, ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    expect((await sql`select 1 from public.lab_tests where code = ${`STR-${suffix}`.slice(0, 32)}`)).toHaveLength(0);
  });

  // ---------- clinic isolation ----------

  it("another clinic's owner sees none of it and can change none of it — every id answers 404", async () => {
    asOwner();
    const cat = (await call(categories.POST, "POST", "/api/admin/lab/categories", { name: `Private ${suffix}` })).body.data!.category;
    const t = (await call(tests.POST, "POST", "/api/admin/lab/tests", { code: `ISO-${suffix}`, name: "Isolated", price: 10, categoryId: cat.id })).body.data!.test;
    const p = (await call(parameters.POST, "POST", "/api/admin/lab/parameters", { testId: t.id, code: "ISO", name: "iso" })).body.data!.parameter;
    const r = (await call(ranges.POST, "POST", "/api/admin/lab/ranges", { parameterId: p.id, low: 1, high: 2 })).body.data!.range;
    const pan = (await call(panels.POST, "POST", "/api/admin/lab/panels", { code: `ISOP-${suffix}`, name: "iso panel", testIds: [t.id] })).body.data!.panel;

    asOwnerB();
    expect(((await call(tests.GET, "GET", "/api/admin/lab/tests?includeInactive=1")).body.data!.tests as { id: string }[]).map((x) => x.id)).not.toContain(t.id);
    expect(((await call(categories.GET, "GET", "/api/admin/lab/categories")).body.data!.categories as { id: string }[]).map((x) => x.id)).not.toContain(cat.id);
    expect(((await call(panels.GET, "GET", "/api/admin/lab/panels?includeInactive=1")).body.data!.panels as { id: string }[]).map((x) => x.id)).not.toContain(pan.id);
    const attempts: Array<[string, Promise<{ status: number; body: Json }>]> = [
      ["read test", call(tests.GET, "GET", `/api/admin/lab/tests?id=${t.id}`)],
      ["patch test", call(tests.PATCH, "PATCH", `/api/admin/lab/tests?id=${t.id}`, { price: 1 })],
      ["patch category", call(categories.PATCH, "PATCH", `/api/admin/lab/categories?id=${cat.id}`, { name: "x" })],
      ["patch parameter", call(parameters.PATCH, "PATCH", `/api/admin/lab/parameters?id=${p.id}`, { name: "x" })],
      ["patch range", call(ranges.PATCH, "PATCH", `/api/admin/lab/ranges?id=${r.id}`, { low: 0 })],
      ["patch panel", call(panels.PATCH, "PATCH", `/api/admin/lab/panels?id=${pan.id}`, { name: "x" })],
      ["parameter on their test", call(parameters.POST, "POST", "/api/admin/lab/parameters", { testId: t.id, code: "Z", name: "z" })],
      ["range on their parameter", call(ranges.POST, "POST", "/api/admin/lab/ranges", { parameterId: p.id, low: 1 })],
      ["panel with their test", call(panels.POST, "POST", "/api/admin/lab/panels", { code: "STEAL", name: "s", testIds: [t.id] })],
      ["test in their category", call(tests.POST, "POST", "/api/admin/lab/tests", { code: "STEAL", name: "s", price: 1, categoryId: cat.id })],
      ["a malformed id", call(tests.GET, "GET", "/api/admin/lab/tests?id=not-a-uuid")],
    ];
    for (const [what, run] of attempts) expect((await run).status, what).toBe(404);
    // Nothing of A changed.
    asOwner();
    const detail = (await call(tests.GET, "GET", `/api/admin/lab/tests?id=${t.id}`)).body.data!.test;
    expect(detail).toMatchObject({ name: "Isolated", price: 10 });
    expect(detail.parameters[0]).toMatchObject({ name: "iso" });
  });

  it("a panel and its tests are written atomically: a refused test leaves nothing half-done, and nobody signed-in can call the functions", async () => {
    asOwner();
    const a = (await call(tests.POST, "POST", "/api/admin/lab/tests", { code: `PA-${suffix}`, name: "Panel test A", price: 1 })).body.data!.test;
    const b = (await call(tests.POST, "POST", "/api/admin/lab/tests", { code: `PB-${suffix}`, name: "Panel test B", price: 1 })).body.data!.test;
    asOwnerB();
    const foreign = (await call(tests.POST, "POST", "/api/admin/lab/tests", { code: `PF-${suffix}`, name: "Other clinic test", price: 1 })).body.data!.test;
    asOwner();
    // Creating with another clinic's test: refused, and no panel row is left behind.
    expect((await call(panels.POST, "POST", "/api/admin/lab/panels", { code: `ATOM-${suffix}`, name: "atomic", testIds: [a.id, foreign.id] })).status).toBe(404);
    expect((await sql`select 1 from public.lab_panels where code = ${`ATOM-${suffix}`}`)).toHaveLength(0);
    // Updating with a refused test list changes neither the tests nor the other fields.
    const panel = (await call(panels.POST, "POST", "/api/admin/lab/panels", { code: `ATOM2-${suffix}`, name: "before", price: 10, testIds: [a.id, b.id] })).body.data!.panel;
    expect((await call(panels.PATCH, "PATCH", `/api/admin/lab/panels?id=${panel.id}`, { name: "after", testIds: [b.id, foreign.id] })).status).toBe(404);
    expect((await sql`select name from public.lab_panels where id = ${panel.id}`)[0].name).toBe("before");
    expect((await sql<{ test_id: string }[]>`select test_id from public.lab_panel_tests where panel_id = ${panel.id} order by sort_order`).map((r) => r.test_id)).toEqual([a.id, b.id]);
    // A good update reorders and renames in one go.
    expect((await call(panels.PATCH, "PATCH", `/api/admin/lab/panels?id=${panel.id}`, { name: "after", testIds: [b.id, a.id] })).status).toBe(200);
    expect((await sql<{ test_id: string }[]>`select test_id from public.lab_panel_tests where panel_id = ${panel.id} order by sort_order`).map((r) => r.test_id)).toEqual([b.id, a.id]);
    // The database functions refuse an empty list (membership untouched) and are not callable by signed-in roles.
    expect((await sql`select public.lab_set_panel_tests(${clinicA}, ${panel.id}, ${sql.array([], 2950)}::uuid[])`.then(() => "no error", (e) => String(e.message)))).toContain("at least one test");
    expect((await sql`select count(*)::int as n from public.lab_panel_tests where panel_id = ${panel.id}`)[0].n).toBe(2);
    let denied = "executed";
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("set local role authenticated");
        await tx`select public.lab_set_panel_tests(${clinicA}, ${panel.id}, ${[a.id]}::uuid[])`;
      });
    } catch (e) {
      denied = (e as postgres.PostgresError).code ?? "error";
    }
    expect(denied).toBe("42501");
  });

  // ---------- workflow settings ----------

  it("workflow settings: safe defaults, strict validation, per clinic, changes audited — and a damaged stored value never loosens the policy", async () => {
    asOwner();
    expect((await call(settings.GET, "GET", "/api/admin/lab/settings")).body.data!.settings).toEqual({
      verification: { required: true, separateVerifier: false },
      collection: { requiresPayment: false },
    });
    for (const bad of [
      { verification: { required: "yes", separateVerifier: false }, collection: { requiresPayment: false } },
      { verification: { required: true }, collection: { requiresPayment: false } },
      { verification: { required: true, separateVerifier: false, extra: 1 }, collection: { requiresPayment: false } },
      { verification: { required: true, separateVerifier: false }, collection: { requiresPayment: false }, clinicId: clinicB },
    ]) {
      expect((await call(settings.PUT, "PUT", "/api/admin/lab/settings", bad)).status, JSON.stringify(bad)).toBe(400);
    }
    const next = { verification: { required: true, separateVerifier: true }, collection: { requiresPayment: true } };
    expect((await call(settings.PUT, "PUT", "/api/admin/lab/settings", next)).status).toBe(200);
    expect((await call(settings.GET, "GET", "/api/admin/lab/settings")).body.data!.settings).toEqual(next);
    // Clinic B is unaffected.
    asOwnerB();
    expect((await call(settings.GET, "GET", "/api/admin/lab/settings")).body.data!.settings).toEqual({ verification: { required: true, separateVerifier: false }, collection: { requiresPayment: false } });
    // The change is in the trail, with the actor and the flags before and after.
    const trail = await sql<{ actor_id: string; old_values: unknown; new_values: unknown }[]>`
      select actor_id, old_values, new_values from public.audit_events where clinic_id = ${clinicA} and action = 'lab_settings_changed'`;
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ actor_id: users.owner, new_values: next });
    // A stored value that no longer parses falls back to the defaults.
    await sql`update public.app_settings set value = '{"verification": {"required": false}}'::jsonb where clinic_id = ${clinicA} and key = 'lab'`;
    asOwner();
    expect((await call(settings.GET, "GET", "/api/admin/lab/settings")).body.data!.settings.verification).toEqual({ required: true, separateVerifier: false });
  });
});
