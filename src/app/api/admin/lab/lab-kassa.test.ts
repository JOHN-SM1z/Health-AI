import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { localDbAvailable } from "@/test/local-db";

/**
 * Lab orders at the Kassa (Phase 6) against the real database, real guards
 * and the real payment engine: only finance roles record payments; the
 * amount is the order's; transitions are legal, idempotent and audited;
 * refunds work; another clinic is refused; the clinic's "before collection"
 * policy releases items once paid.
 */

const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const session = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/staff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/staff")>();
  return { ...actual, getStaffContext: async () => session.ctx };
});

import { GET as listPayments } from "./payments/route";
import { POST as changePayment } from "./orders/[id]/payment/route";

const describeDb = describe.skipIf(!localDbAvailable());

type Body = { ok: boolean; data?: Record<string, unknown>; code?: string };

describeDb("lab Kassa (real database)", () => {
  let admin: SupabaseClient;
  const suffix = Date.now().toString(36);
  const clinicA = randomUUID();
  const clinicB = randomUUID();
  const people = { owner: randomUUID(), manager: randomUUID(), reception: randomUUID(), lab: randomUUID(), ownerB: randomUUID() };
  let testId = "";

  const as = (profileId: string, role: string, clinicId = clinicA) => {
    session.ctx = { profileId, clinicId, clinicName: "Kassa", clinicTimezone: "Asia/Tashkent", roles: [role], platformAdmin: false };
  };

  const list = async (filter = "open") => {
    const res = await listPayments(new NextRequest(`http://localhost/api/admin/lab/payments?filter=${filter}`));
    return { status: res.status, body: (await res.json()) as Body };
  };
  const pay = async (orderId: string, body: unknown) => {
    const res = await changePayment(
      new NextRequest(`http://localhost/api/admin/lab/orders/${orderId}/payment`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      { params: Promise.resolve({ id: orderId }) },
    );
    return { status: res.status, body: (await res.json()) as Body };
  };

  async function newOrder(clinicId = clinicA) {
    const { data: patient } = await admin.from("patients").insert({ clinic_id: clinicId, full_name: `Kassa bemor ${suffix}`, date_of_birth: "1990-01-01" }).select("id").single();
    const { data, error } = await admin.rpc("create_lab_order", {
      p_clinic_id: clinicId,
      p_patient_id: patient!.id,
      p_ordered_by: clinicId === clinicA ? people.reception : people.ownerB,
      p_source: "walk_in",
      p_test_ids: clinicId === clinicA ? [testId] : [],
      p_panel_ids: [],
    });
    if (error) throw new Error(error.message);
    return (data as Array<{ lab_order_id: string }>)[0].lab_order_id;
  }
  const paymentOf = async (orderId: string) =>
    (await admin.from("payments").select("id, status, amount, metadata, paid_by").eq("lab_order_id", orderId).single()).data!;

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    await admin.from("clinics").insert([
      { id: clinicA, name: `Kassa A ${suffix}`, slug: `kassa-a-${suffix}` },
      { id: clinicB, name: `Kassa B ${suffix}`, slug: `kassa-b-${suffix}` },
    ]);
    for (const [name, id] of Object.entries(people)) {
      const { error } = await admin.auth.admin.createUser({ id, email: `kassa-${name}-${suffix}@test.local`, email_confirm: true, password: `Pw-${randomUUID()}` });
      if (error) throw new Error(error.message);
      await admin.from("profiles").insert({ id, full_name: name });
    }
    await admin.from("staff_roles").insert([
      { clinic_id: clinicA, profile_id: people.owner, role: "owner" },
      { clinic_id: clinicA, profile_id: people.manager, role: "manager" },
      { clinic_id: clinicA, profile_id: people.reception, role: "receptionist" },
      { clinic_id: clinicA, profile_id: people.lab, role: "lab" },
      { clinic_id: clinicB, profile_id: people.ownerB, role: "owner" },
    ]);
    const { data } = await admin.from("lab_tests").insert({ clinic_id: clinicA, code: `K${suffix}`, name: `Kassa test ${suffix}`, sample_type: "Qon", price: 70000 }).select("id").single();
    testId = data!.id;
  });

  afterAll(async () => {
    if (!admin) return;
    await admin.from("clinics").delete().in("id", [clinicA, clinicB]);
    for (const id of Object.values(people)) await admin.auth.admin.deleteUser(id);
  });

  beforeEach(() => as(people.owner, "owner"));

  it("is for the existing payment roles only (owner, admin)", async () => {
    const orderId = await newOrder();
    for (const [profile, role] of [
      [people.manager, "manager"],
      [people.reception, "receptionist"],
      [people.lab, "lab"],
    ] as const) {
      as(profile, role);
      expect((await list()).status).toBe(403);
      expect((await pay(orderId, { status: "paid", method: "cash" })).status).toBe(403);
    }
    session.ctx = null;
    expect((await pay(orderId, { status: "paid", method: "cash" })).status).toBe(401);
    expect((await paymentOf(orderId)).status).toBe("unpaid");
  });

  it("lists the unpaid order with its stored amount and records a cash payment once, audited", async () => {
    const orderId = await newOrder();
    const open = await list();
    const row = (open.body.data!.payments as Array<{ orderId: string; amount: number; paymentStatus: string; tests: Array<{ name: string }> }>).find((r) => r.orderId === orderId);
    expect(row).toMatchObject({ amount: 70000, paymentStatus: "unpaid", tests: [{ name: `Kassa test ${suffix}` }] });

    expect((await pay(orderId, { status: "paid" })).status).toBe(400); // method required
    const first = await pay(orderId, { status: "paid", method: "cash", amount: 1 });
    expect(first.status).toBe(200);
    const again = await pay(orderId, { status: "paid", method: "cash" });
    expect(again.body.data).toEqual({ updated: true, alreadyInState: true });
    const payment = await paymentOf(orderId);
    expect(payment).toMatchObject({ status: "paid", amount: 70000, paid_by: people.owner });
    expect((payment.metadata as Record<string, unknown>).method).toBe("cash");
    const { data: audit } = await admin.from("audit_events").select("actor_id").eq("action", "payment_status_changed").eq("entity_id", payment.id);
    expect(audit).toEqual([{ actor_id: people.owner }]);
    expect((await list()).body.data!.payments as Array<{ orderId: string }>).not.toContainEqual(expect.objectContaining({ orderId }));
  });

  it("refunds a paid order and refuses illegal transitions", async () => {
    const orderId = await newOrder();
    expect((await pay(orderId, { status: "refunded" })).status).toBe(409); // unpaid → refunded
    await pay(orderId, { status: "paid", method: "card_terminal" });
    expect((await pay(orderId, { status: "refunded" })).status).toBe(200);
    expect((await paymentOf(orderId)).status).toBe("refunded");
    expect((await pay(orderId, { status: "paid", method: "cash" })).status).toBe(409); // refunded is final
  });

  it("never touches another clinic's lab payment", async () => {
    const orderA = await newOrder();
    as(people.ownerB, "owner", clinicB);
    expect((await pay(orderA, { status: "paid", method: "cash" })).status).toBe(404);
    const rows = (await list("all")).body.data!.payments as Array<{ orderId: string }>;
    expect(rows.find((r) => r.orderId === orderA)).toBeUndefined();
    expect((await paymentOf(orderA)).status).toBe("unpaid");
  });

  it("releases items for collection when payment is required first", async () => {
    await admin.from("app_settings").upsert({ clinic_id: clinicA, key: "lab", value: { paymentPolicy: "before_collection", releaseToPatient: true } });
    const orderId = await newOrder();
    const statusOf = async () => (await admin.from("lab_order_items").select("status").eq("order_id", orderId).single()).data!.status;
    expect(await statusOf()).toBe("ordered");
    await pay(orderId, { status: "paid", method: "cash" });
    expect(await statusOf()).toBe("ready_for_collection");
    await admin.from("app_settings").delete().eq("clinic_id", clinicA).eq("key", "lab");
  });
});
