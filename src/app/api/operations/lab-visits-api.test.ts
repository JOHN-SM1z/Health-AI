import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { localDbAvailable } from "@/test/local-db";

/**
 * Laboratory walk-ins through the real routes and database (Phase 3):
 * reception registers tests, the kassa takes one payment for the visit's
 * bill, the lab queue number appears, lab staff run the lab queue, and a lab
 * line can only leave the bill by cancelling the test in the laboratory.
 */

const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const session = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/staff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/staff")>();
  return { ...actual, getStaffContext: async () => session.ctx };
});

import { POST as registerLab } from "./lab-arrivals/route";
import { GET as catalog } from "./catalog/route";
import { GET as kassa } from "./kassa/route";
import { POST as pay } from "./kassa/[visitId]/pay/route";
import { POST as voidCharge } from "./charges/[id]/void/route";
import { GET as labQueue } from "../lab/visits/route";
import { POST as labAct } from "../lab/visits/[id]/route";
import { GET as publicQueue } from "../queue/[clinicId]/route";
import { POST as followLink } from "./visits/[id]/follow-link/route";

const describeDb = describe.skipIf(!localDbAvailable());
type Body = { ok: boolean; data?: Record<string, unknown>; code?: string };
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Body });
const json = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const params = <T,>(p: T) => ({ params: Promise.resolve(p) });

describeDb("laboratory walk-ins — routes", () => {
  let admin: SupabaseClient;
  let sql: postgres.Sql;
  const suffix = Date.now().toString(36);
  const clinic = randomUUID();
  const people = { reception: randomUUID(), cashier: randomUUID(), lab: randomUUID() };
  const tests = { cbc: randomUUID(), ferritin: randomUUID() };

  const as = (profileId: string, role: string) => {
    session.ctx = { profileId, clinicId: clinic, clinicName: "Lab", clinicTimezone: "Asia/Tashkent", roles: [role], platformAdmin: false };
  };

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    sql = postgres(DB_URL, { max: 2, onnotice: () => {} });
    const { error } = await admin.from("clinics").insert({ id: clinic, name: `Lab API ${suffix}`, slug: `lab-api-${suffix}`, timezone: "Asia/Tashkent" });
    if (error) throw new Error(error.message);
    for (const [name, id] of Object.entries(people)) {
      const r = await admin.auth.admin.createUser({ id, email: `labapi-${name}-${suffix}@test.local`, email_confirm: true, password: `Pw-${randomUUID()}` });
      if (r.error) throw new Error(r.error.message);
      await admin.from("profiles").insert({ id, full_name: name });
    }
    await admin.from("staff_roles").insert([
      { clinic_id: clinic, profile_id: people.reception, role: "receptionist" },
      { clinic_id: clinic, profile_id: people.cashier, role: "cashier" },
      { clinic_id: clinic, profile_id: people.lab, role: "lab" },
    ]);
    await admin.from("lab_tests").insert([
      { id: tests.cbc, clinic_id: clinic, code: `CBC${suffix}`.slice(0, 30), name: `Umumiy qon ${suffix}`, sample_type: "Qon", price: 40000 },
      { id: tests.ferritin, clinic_id: clinic, code: `FER${suffix}`.slice(0, 30), name: `Ferritin ${suffix}`, sample_type: "Qon", price: 90000 },
    ]);
    await admin.from("app_settings").insert({ clinic_id: clinic, key: "lab", value: { paymentPolicy: "before_collection" } });
    await admin.from("clinic_telegram_integrations").insert({
      clinic_id: clinic,
      telegram_bot_token: `${800000 + Math.floor(Math.random() * 1000)}:LABAPI_${suffix}`,
      telegram_bot_id: 800000 + Math.floor(Math.random() * 100000),
      telegram_username: `labapi_${suffix}_bot`,
      telegram_bot_name: "Lab API",
      status: "active",
      enabled: true,
      validated_at: new Date().toISOString(),
    });
  }, 60_000);

  afterAll(async () => {
    if (sql) {
      await sql.begin(async (tx) => {
        await tx.unsafe("set local session_replication_role = replica");
        await tx`delete from public.visit_transactions where clinic_id = ${clinic}`;
        await tx`delete from public.visit_charges where clinic_id = ${clinic}`;
        await tx`delete from public.notification_jobs where clinic_id = ${clinic}`;
        await tx`delete from public.visit_follow_tokens where clinic_id = ${clinic}`;
        await tx`update public.lab_orders set visit_id = null where clinic_id = ${clinic}`;
        await tx`delete from public.visits where clinic_id = ${clinic}`;
      });
      await sql.end({ timeout: 5 });
    }
    if (!admin) return;
    await admin.from("clinics").delete().eq("id", clinic);
    for (const id of Object.values(people)) await admin.auth.admin.deleteUser(id).catch(() => {});
  });

  it("reception → kassa → lab queue → lab staff, on one bill", async () => {
    as(people.reception, "receptionist");
    const cat = (await read(await catalog())).body.data as { lab: { tests: Array<{ id: string; price: number }> } };
    expect(cat.lab.tests.find((t) => t.id === tests.ferritin)?.price).toBe(90000);

    const body = { key: randomUUID(), testIds: [tests.cbc, tests.ferritin], newPatient: { fullName: `Lab Bemor ${suffix}`, dateOfBirth: "1992-07-08" } };
    expect((await read(await registerLab(new NextRequest("http://x", json("POST", { ...body, price: 1 }))))).status).toBe(400);
    expect((await read(await registerLab(new NextRequest("http://x", json("POST", { ...body, testIds: [] }))))).status).toBe(400);
    const r = await read(await registerLab(new NextRequest("http://x", json("POST", body))));
    expect(r.status).toBe(201);
    const visitId = r.body.data!.visitId as string;
    // A retry is the same registration.
    expect((await read(await registerLab(new NextRequest("http://x", json("POST", body))))).body.data).toMatchObject({ visitId, replayed: true });

    as(people.cashier, "cashier");
    const list = (await read(await kassa())).body.data as { open: Array<{ id: string; kind: string; balance: { outstanding: number }; charges: Array<{ id: string; isLabTest: boolean }> }> };
    const v = list.open.find((x) => x.id === visitId)!;
    expect(v).toMatchObject({ kind: "lab", balance: { outstanding: 130000 } });
    expect(v.charges.every((c) => c.isLabTest)).toBe(true);
    // A lab line is not removed at the desk.
    expect((await read(await voidCharge(new NextRequest("http://x", json("POST", { reason: "Xato tahlil" })), params({ id: v.charges[0].id })))).body.code).toBe("cancel_lab_test");

    const paid = await read(await pay(new NextRequest("http://x", json("POST", { key: randomUUID(), expectedOutstanding: 130000, lines: [{ method: "terminal", amount: 130000 }] })), params({ visitId })));
    expect(paid.body.data!.queueNumber).toEqual(expect.any(Number));
    const [order] = await sql<{ id: string }[]>`select lab_order_id as id from public.visits where id = ${visitId}`;
    const statuses = await sql<{ status: string }[]>`select status from public.lab_order_items where order_id = ${order.id}`;
    expect(statuses.every((s) => s.status === "ready_for_collection")).toBe(true);

    // Lab staff see it in the lab queue with the tests, and run it.
    as(people.lab, "lab");
    const q = (await read(await labQueue())).body.data!.visits as Array<{ id: string; tests: string[]; queueNumber: number }>;
    const mine = q.find((x) => x.id === visitId)!;
    expect(mine.tests.sort()).toEqual([`Ferritin ${suffix}`, `Umumiy qon ${suffix}`].sort());
    expect(mine.queueNumber).toBe(paid.body.data!.queueNumber);
    for (const [action, expected] of [["call", "waiting"], ["start", "called"], ["complete", "in_progress"]] as const) {
      const res = await read(await labAct(new NextRequest("http://x", json("POST", { action, expected })), params({ id: visitId })));
      expect(res.status, action).toBe(200);
    }

    // Reception cannot drive the lab queue route.
    as(people.reception, "receptionist");
    expect((await read(await labAct(new NextRequest("http://x", json("POST", { action: "call", expected: "waiting" })), params({ id: visitId })))).status).toBe(403);
  });

  it("the waiting-room screen shows the laboratory's numbers under 'Laboratoriya', never names", async () => {
    as(people.reception, "receptionist");
    const r = await read(await registerLab(new NextRequest("http://x", json("POST", { key: randomUUID(), testIds: [tests.cbc], newPatient: { fullName: `Ekran Bemor ${suffix}`, dateOfBirth: "1990-01-01" } }))));
    const visitId = r.body.data!.visitId as string;
    as(people.cashier, "cashier");
    const paid = await read(await pay(new NextRequest("http://x", json("POST", { key: randomUUID(), expectedOutstanding: 40000, lines: [{ method: "cash", amount: 40000 }] })), params({ visitId })));
    const screen = await read(await publicQueue(new NextRequest("http://x", { headers: { "x-forwarded-for": "10.7.7.7" } }), params({ clinicId: clinic })));
    const lab = (screen.body.data!.doctors as Array<{ name: string; waiting: number[] }>).find((d) => d.name === "Laboratoriya");
    expect(lab?.waiting).toContain(paid.body.data!.queueNumber);
    expect(JSON.stringify(screen.body)).not.toContain("Ekran Bemor");
  });

  it("the kassa's Telegram QR link: desk and kassa only, this clinic's visits only", async () => {
    as(people.reception, "receptionist");
    const r = await read(await registerLab(new NextRequest("http://x", json("POST", { key: randomUUID(), testIds: [tests.cbc], newPatient: { fullName: `QR Bemor ${suffix}`, dateOfBirth: "1993-03-03" } }))));
    const visitId = r.body.data!.visitId as string;
    as(people.cashier, "cashier");
    await pay(new NextRequest("http://x", json("POST", { key: randomUUID(), expectedOutstanding: 40000, lines: [{ method: "cash", amount: 40000 }] })), params({ visitId }));

    const link = await read(await followLink(new NextRequest("http://x", json("POST", {})), params({ id: visitId })));
    expect(link.status).toBe(201);
    expect(link.body.data!.url).toMatch(new RegExp(`^https://t\\.me/labapi_${suffix}_bot\\?start=v_[A-Za-z0-9_-]{32}$`));

    // Not a lab or doctor action; not someone else's visit.
    as(people.lab, "lab");
    expect((await read(await followLink(new NextRequest("http://x", json("POST", {})), params({ id: visitId })))).status).toBe(403);
    as(people.reception, "receptionist");
    expect((await read(await followLink(new NextRequest("http://x", json("POST", {})), params({ id: randomUUID() })))).status).toBe(404);
    expect((await read(await followLink(new NextRequest("http://x", json("POST", {})), params({ id: "not-a-uuid" })))).status).toBe(404);
  });
});
