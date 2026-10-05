import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { localDbAvailable } from "@/test/local-db";

/**
 * The lab work queue and sample collection (Phase 7) through the real routes,
 * guards and database: who may see the queue, collect, receive and reject;
 * the queue carries status and specimens only; one sample per test even when
 * two people submit at once; walk-in orders from the desk; nothing crosses
 * clinics.
 */

const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const session = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/staff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/staff")>();
  return { ...actual, getStaffContext: async () => session.ctx };
});

import { GET as getQueue } from "./queue/route";
import { GET as getCatalog } from "./catalog/route";
import { GET as findPatients } from "./patients/route";
import { POST as walkIn } from "./orders/route";
import { POST as collectRoute } from "./orders/[id]/samples/route";
import { POST as sampleRoute } from "./samples/[id]/route";

const describeDb = describe.skipIf(!localDbAvailable());

type Body = { ok: boolean; data?: Record<string, unknown>; code?: string };
type QueueOrder = {
  id: string;
  patient: { id: string; fullName: string; dateOfBirth: string | null };
  items: Array<{ id: string; status: string; sampleType: string; sampleId: string | null }>;
  samples: Array<{ id: string; code: string; status: string; itemIds: string[] }>;
};

const json = (url: string, body: unknown) =>
  new NextRequest(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Body });

describeDb("lab work queue and sample collection (real database)", () => {
  let admin: SupabaseClient;
  const suffix = Date.now().toString(36);
  const clinicA = randomUUID();
  const clinicB = randomUUID();
  const people = {
    owner: randomUUID(),
    manager: randomUUID(),
    reception: randomUUID(),
    lab: randomUUID(),
    lab2: randomUUID(),
    doctor: randomUUID(),
    labB: randomUUID(),
  };
  let blood = "";
  let urine = "";
  let patientA = "";
  let patientB = "";

  const as = (profileId: string, role: string, clinicId = clinicA) => {
    session.ctx = { profileId, clinicId, clinicName: "Queue", clinicTimezone: "Asia/Tashkent", roles: [role], platformAdmin: false };
  };
  const queue = async () => read(await getQueue());
  const collect = async (orderId: string, itemIds: string[], key = randomUUID(), notes?: string) =>
    read(await collectRoute(json(`http://localhost/api/lab/orders/${orderId}/samples`, { idempotencyKey: key, itemIds, notes }), { params: Promise.resolve({ id: orderId }) }));
  const act = async (sampleId: string, body: unknown) =>
    read(await sampleRoute(json(`http://localhost/api/lab/samples/${sampleId}`, body), { params: Promise.resolve({ id: sampleId }) }));
  const order = async (patientId: string, testIds: string[], key = randomUUID()) =>
    read(await walkIn(json("http://localhost/api/lab/orders", { idempotencyKey: key, patientId, testIds, panelIds: [] })));
  const itemsOf = async (orderId: string) =>
    (await admin.from("lab_order_items").select("id, test_id, status").eq("order_id", orderId)).data as Array<{ id: string; test_id: string; status: string }>;

  async function newOrder(testIds = [blood]) {
    as(people.reception, "receptionist");
    const res = await order(patientA, testIds);
    expect(res.status).toBe(201);
    return res.body.data!.orderId as string;
  }

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    await admin.from("clinics").insert([
      { id: clinicA, name: `Queue A ${suffix}`, slug: `queue-a-${suffix}` },
      { id: clinicB, name: `Queue B ${suffix}`, slug: `queue-b-${suffix}` },
    ]);
    for (const [name, id] of Object.entries(people)) {
      const { error } = await admin.auth.admin.createUser({ id, email: `queue-${name}-${suffix}@test.local`, email_confirm: true, password: `Pw-${randomUUID()}` });
      if (error) throw new Error(error.message);
      await admin.from("profiles").insert({ id, full_name: name });
    }
    await admin.from("staff_roles").insert([
      { clinic_id: clinicA, profile_id: people.owner, role: "owner" },
      { clinic_id: clinicA, profile_id: people.manager, role: "manager" },
      { clinic_id: clinicA, profile_id: people.reception, role: "receptionist" },
      { clinic_id: clinicA, profile_id: people.lab, role: "lab" },
      { clinic_id: clinicA, profile_id: people.lab2, role: "lab" },
      { clinic_id: clinicA, profile_id: people.doctor, role: "doctor" },
      { clinic_id: clinicB, profile_id: people.labB, role: "lab" },
    ]);
    const { data: tests } = await admin
      .from("lab_tests")
      .insert([
        { clinic_id: clinicA, code: `QB${suffix}`, name: `Qon test ${suffix}`, sample_type: "Qon", price: 50000, preparation_text: "Och qoringa" },
        { clinic_id: clinicA, code: `QU${suffix}`, name: `Siydik test ${suffix}`, sample_type: "Siydik", price: 30000 },
      ])
      .select("id, sample_type");
    blood = tests!.find((t) => t.sample_type === "Qon")!.id;
    urine = tests!.find((t) => t.sample_type === "Siydik")!.id;
    const { data: pa } = await admin.from("patients").insert({ clinic_id: clinicA, full_name: `Navbat Bemor ${suffix}`, date_of_birth: "1985-04-02", phone: "+998901234567" }).select("id").single();
    const { data: pb } = await admin.from("patients").insert({ clinic_id: clinicB, full_name: `Navbat Begona ${suffix}`, date_of_birth: "1970-01-01" }).select("id").single();
    patientA = pa!.id;
    patientB = pb!.id;
  });

  afterAll(async () => {
    if (!admin) return;
    await admin.from("clinics").delete().in("id", [clinicA, clinicB]);
    for (const id of Object.values(people)) await admin.auth.admin.deleteUser(id);
  });

  beforeEach(() => as(people.lab, "lab"));

  it("keeps the clinic-wide queue from doctors and anonymous callers", async () => {
    as(people.doctor, "doctor");
    expect((await queue()).status).toBe(403);
    expect((await read(await getCatalog())).status).toBe(403);
    expect((await read(await findPatients(new NextRequest("http://localhost/api/lab/patients?q=Navbat")))).status).toBe(403);
    expect((await order(patientA, [blood])).status).toBe(403);
    session.ctx = null;
    expect((await queue()).status).toBe(401);
    for (const [id, role] of [[people.owner, "owner"], [people.manager, "manager"], [people.reception, "receptionist"], [people.lab, "lab"]] as const) {
      as(id, role);
      expect((await queue()).status, role).toBe(200);
    }
  });

  it("orders a walk-in at the desk with catalog prices; another clinic's patient is refused", async () => {
    as(people.reception, "receptionist");
    const search = await read(await findPatients(new NextRequest("http://localhost/api/lab/patients?q=Navbat")));
    const found = search.body.data!.patients as Array<{ id: string; dateOfBirth: string; phoneTail: string }>;
    expect(found).toEqual([{ id: patientA, fullName: `Navbat Bemor ${suffix}`, dateOfBirth: "1985-04-02", phoneTail: "4567" }]);

    const key = randomUUID();
    const res = await read(await walkIn(json("http://localhost/api/lab/orders", { idempotencyKey: key, patientId: patientA, testIds: [blood], panelIds: [], price: 1 })));
    expect(res.status).toBe(201);
    const orderId = res.body.data!.orderId as string;
    const { data: o } = await admin.from("lab_orders").select("source, ordered_by, ordering_doctor_id").eq("id", orderId).single();
    expect(o).toEqual({ source: "walk_in", ordered_by: people.reception, ordering_doctor_id: null });
    expect((await admin.from("payments").select("amount").eq("lab_order_id", orderId).single()).data!.amount).toBe(50000);
    expect((await order(patientA, [blood], key)).status).toBe(200); // replay

    expect((await order(patientB, [blood])).status).toBe(404);
    as(people.lab, "lab");
    expect((await order(patientA, [urine])).status).toBe(201); // lab desk can order too
  });

  it("shows status and specimens only — no result values, notes or clinical text", async () => {
    const orderId = await newOrder([blood, urine]);
    as(people.lab, "lab");
    const res = await queue();
    const row = (res.body.data!.orders as QueueOrder[]).find((o) => o.id === orderId)!;
    expect(row.patient).toEqual({ id: patientA, fullName: `Navbat Bemor ${suffix}`, dateOfBirth: "1985-04-02" });
    expect(row.items.map((i) => [i.sampleType, i.status]).sort()).toEqual([["Qon", "ready_for_collection"], ["Siydik", "ready_for_collection"]]);
    const keys = new Set<string>();
    const walk = (v: unknown) => {
      if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); }
    };
    walk(res.body.data);
    for (const forbidden of ["values", "value", "flag", "labComment", "summary", "details", "diagnosis", "phone", "reason"]) {
      expect(keys.has(forbidden), forbidden).toBe(false);
    }
  });

  it("collects, receives and rejects by role: reception collects, only the lab processes", async () => {
    const orderId = await newOrder([blood]);
    const [item] = await itemsOf(orderId);

    as(people.manager, "manager");
    expect((await collect(orderId, [item.id])).status).toBe(403);
    as(people.owner, "owner");
    expect((await collect(orderId, [item.id])).status).toBe(403);

    as(people.reception, "receptionist");
    const key = randomUUID();
    const first = await collect(orderId, [item.id], key, "Chap qo‘l");
    expect(first.status).toBe(201);
    const sampleId = first.body.data!.sampleId as string;
    const replay = await collect(orderId, [item.id], key, "Chap qo‘l");
    expect(replay.status).toBe(200);
    expect(replay.body.data!.sampleId).toBe(sampleId);
    expect((await act(sampleId, { action: "receive" })).status).toBe(403); // reception does not process

    as(people.lab, "lab");
    const rows = (await queue()).body.data!.orders as QueueOrder[];
    const mine = rows.find((o) => o.id === orderId)!;
    expect(mine.items[0]).toMatchObject({ status: "collected", sampleId });
    expect(mine.samples).toEqual([expect.objectContaining({ id: sampleId, status: "collected", itemIds: [item.id], code: first.body.data!.sampleCode })]);

    expect((await act(sampleId, { action: "receive" })).body.data).toEqual({ changed: true });
    expect((await itemsOf(orderId))[0].status).toBe("processing");
    expect((await act(sampleId, { action: "reject" })).status).toBe(400); // reason required
    expect((await act(sampleId, { action: "reject", reason: "Gemoliz" })).body.data).toEqual({ changed: true });
    expect((await itemsOf(orderId))[0].status).toBe("ready_for_collection");

    // A fresh sample can be collected again.
    expect((await collect(orderId, [item.id])).status).toBe(201);
  });

  it("refuses mixed sample types and an item of another order", async () => {
    const orderId = await newOrder([blood, urine]);
    const other = await newOrder([blood]);
    const items = await itemsOf(orderId);
    const [otherItem] = await itemsOf(other);
    as(people.lab, "lab");
    expect((await collect(orderId, items.map((i) => i.id))).body.code).toBe("mixed_sample_types");
    expect((await collect(orderId, [otherItem.id])).status).toBe(404);
  });

  it("two people collecting the same test at once create exactly one sample", async () => {
    const orderId = await newOrder([blood]);
    const [item] = await itemsOf(orderId);
    // Three submits with different keys (double taps on two screens) race for one test.
    as(people.lab, "lab");
    const results = await Promise.all([collect(orderId, [item.id]), collect(orderId, [item.id]), collect(orderId, [item.id])]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.code === "already_collected")).toBe(true);
    const { count } = await admin.from("lab_sample_items").select("sample_id", { count: "exact", head: true }).eq("order_item_id", item.id);
    expect(count).toBe(1);
  });

  it("refuses a cancelled order", async () => {
    const orderId = await newOrder([blood]);
    const [item] = await itemsOf(orderId);
    await admin.from("lab_orders").update({ status: "cancelled", cancelled_at: new Date().toISOString(), cancelled_by: people.reception }).eq("id", orderId);
    expect((await collect(orderId, [item.id])).body.code).toBe("order_not_active");
    expect(((await queue()).body.data!.orders as QueueOrder[]).some((o) => o.id === orderId)).toBe(false);
  });

  it("never reaches another clinic's orders or samples", async () => {
    const orderId = await newOrder([blood]);
    const [item] = await itemsOf(orderId);
    as(people.lab, "lab");
    const sampleId = (await collect(orderId, [item.id])).body.data!.sampleId as string;

    as(people.labB, "lab", clinicB);
    expect(((await queue()).body.data!.orders as QueueOrder[]).some((o) => o.id === orderId)).toBe(false);
    expect((await collect(orderId, [item.id])).status).toBe(404);
    expect((await act(sampleId, { action: "receive" })).status).toBe(404);
    expect((await act(sampleId, { action: "reject", reason: "x" })).status).toBe(404);
    const search = await read(await findPatients(new NextRequest("http://localhost/api/lab/patients?q=Navbat")));
    expect((search.body.data!.patients as Array<{ id: string }>).map((p) => p.id)).toEqual([patientB]);
    expect((await admin.from("lab_samples").select("status").eq("id", sampleId).single()).data!.status).toBe("collected");
  });
});
