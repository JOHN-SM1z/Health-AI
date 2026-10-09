import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import postgres from "postgres";
import { localDbAvailable } from "@/test/local-db";

/**
 * Pay online, get the queue number online (Slice C, 20261008000012) — real database, real routes, the signed test
 * provider. Mocked: the staff session lookup, Telegram sending, and the background notification kick.
 */

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const SECRET = `test-online-${randomUUID()}-${randomUUID()}`;
process.env.ONLINE_PAYMENT_PROVIDER = "test_online";
process.env.TEST_ONLINE_PAYMENT_SECRET = SECRET;

const session = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/staff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/staff")>();
  return { ...actual, getStaffContext: async () => session.ctx };
});
vi.mock("@/lib/telegram/bot", () => ({
  sendTelegramMessage: vi.fn(async () => 4242),
  getTelegramFileUrl: vi.fn(async () => null),
  telegramConfigured: vi.fn(() => true),
  answerCallbackQuery: vi.fn(async () => undefined),
}));
vi.mock("@/lib/notifications/deliver-soon", () => ({ deliverClinicNotificationsSoon: vi.fn() }));

import { POST as webhook } from "./[provider]/webhook/route";
import { POST as invoiceRoute } from "@/app/api/me/payments/invoice/route";
import { POST as statusRoute } from "@/app/api/me/payments/status/route";
import { GET as bookedList } from "@/app/api/operations/booked/route";
import { POST as arrived } from "@/app/api/operations/booked/[id]/route";
import { GET as refundList } from "@/app/api/admin/payments/refunds/route";
import { POST as refundDone } from "@/app/api/admin/payments/refunds/[id]/route";
import { POST as doctorAct } from "@/app/api/doctor/visits/[id]/route";
import { kassaTotals, listOpenVisits } from "@/lib/operations/outpatient";

const describeDb = describe.skipIf(!localDbAvailable());
type Body = { ok: boolean; data?: Record<string, unknown>; code?: string; outcome?: string };
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Body });

function signInitData(botToken: string, telegramUserId: number) {
  const user = JSON.stringify({ id: telegramUserId, first_name: "Bemor" });
  const fields: Array<[string, string]> = [["auth_date", String(Math.floor(Date.now() / 1000))], ["query_id", "AAHdF6IQAAAAAN0XohDhrOrc"], ["user", user]];
  const check = fields.map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  return `${fields.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}&hash=${createHmac("sha256", secret).update(check).digest("hex")}`;
}

describeDb("online payment → queue number (signed test provider, real database)", () => {
  let sql: postgres.Sql;
  const suffix = Date.now().toString(36);
  const seed = Math.floor(Math.random() * 1_000_000);
  const clinic = randomUUID();
  const BOT = `${400000 + (seed % 1000)}:PY${suffix}bot${"p".repeat(24)}`;
  const people = { owner: randomUUID(), reception: randomUUID(), cashier: randomUUID(), doctor: randomUUID() };
  const doctor = randomUUID();
  const service = randomUUID();
  const tg = 930_000_000 + seed;
  let patient = "";
  let slotMinutes = 0;

  const as = (profileId: string, role: string) => {
    session.ctx = { profileId, clinicId: clinic, clinicName: "Pay", clinicTimezone: "Asia/Tashkent", roles: [role], platformAdmin: false };
  };
  const mini = (handler: (r: NextRequest) => Promise<Response>, body: Record<string, unknown>) =>
    handler(
      new NextRequest(`http://localhost/api/me/payments?clinic=${clinic}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `10.6.${seed % 250}.1` },
        body: JSON.stringify({ initData: signInitData(BOT, tg), ...body }),
      }),
    ).then(read);
  const hook = (body: unknown, signature?: string) => {
    const raw = JSON.stringify(body);
    const sig = signature ?? createHmac("sha256", SECRET).update(raw).digest("hex");
    return webhook(new NextRequest("http://localhost/api/payments/test_online/webhook", { method: "POST", headers: { "x-test-signature": sig }, body: raw }), {
      params: Promise.resolve({ provider: "test_online" }),
    }).then(read);
  };
  /** A pending online booking of the doctor today (clinic time), each one 20 minutes later than the last. */
  const booking = async () => {
    slotMinutes += 20;
    const start = new Date(Date.now() + slotMinutes * 60_000);
    start.setUTCSeconds(0, 0);
    const [a] = await sql<{ id: string }[]>`
      insert into public.appointments ${sql({ clinic_id: clinic, patient_id: patient, doctor_id: doctor, service_id: service, start_at: start, end_at: new Date(start.getTime() + 20 * 60_000), status: "pending", source: "telegram_mini_app" })}
      returning id`;
    await sql`insert into public.payments ${sql({ clinic_id: clinic, appointment_id: a.id, patient_id: patient, amount: 120000, currency: "UZS", status: "unpaid", provider: "manual" })}`;
    return a.id;
  };
  const invoiceFor = async (appointmentId: string) => {
    const r = await mini(invoiceRoute, { appointmentId });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.data as { invoiceId: string; amount: number; currency: string; payUrl: string };
  };
  const paid = (inv: { invoiceId: string; amount: number; currency: string }, eventId = randomUUID()) =>
    hook({ eventId, invoiceId: inv.invoiceId, amount: inv.amount, currency: inv.currency, reference: `R-${eventId.slice(0, 8)}` });

  beforeAll(async () => {
    sql = postgres(DB_URL, { max: 12, onnotice: () => {} });
    await sql`insert into public.clinics ${sql({ id: clinic, name: `Pay ${suffix}`, slug: `pay-${suffix}`, timezone: "Asia/Tashkent", currency: "UZS" })}`;
    await sql`insert into public.clinic_telegram_integrations ${sql({ clinic_id: clinic, telegram_bot_token: BOT, telegram_bot_id: 400000 + seed, telegram_username: `py_${suffix}_bot`, telegram_bot_name: "Pay", status: "active", enabled: true, validated_at: new Date() })}`;
    const users = Object.entries(people).map(([n, id]) => ({ id, email: `pay-${n}-${suffix}@test.local` }));
    await sql`insert into auth.users ${sql(users)}`;
    await sql`insert into public.profiles ${sql(users.map((u) => ({ id: u.id, full_name: u.email })))}`;
    await sql`insert into public.staff_roles ${sql([
      { clinic_id: clinic, profile_id: people.owner, role: "owner" },
      { clinic_id: clinic, profile_id: people.reception, role: "receptionist" },
      { clinic_id: clinic, profile_id: people.cashier, role: "cashier" },
      { clinic_id: clinic, profile_id: people.doctor, role: "doctor" },
    ])}`;
    await sql`insert into public.doctors ${sql({ id: doctor, clinic_id: clinic, profile_id: people.doctor, name: `Dr Onlayn ${suffix}`, active: true })}`;
    await sql`insert into public.services ${sql({ id: service, clinic_id: clinic, name: `Onlayn ko‘rik ${suffix}`, duration_minutes: 20, price: 120000 })}`;
    await sql`insert into public.doctor_services ${sql({ doctor_id: doctor, service_id: service })}`;
    await sql`insert into public.doctor_working_hours ${sql([1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinic_id: clinic, doctor_id: doctor, weekday, start_time: "00:00", end_time: "23:59" })))}`;
    const [p] = await sql<{ id: string }[]>`insert into public.patients ${sql({ clinic_id: clinic, full_name: `Onlayn To‘lovchi ${suffix}`, phone: "+998 90 444 55 66", telegram_user_id: tg })} returning id`;
    patient = p.id;
  }, 60_000);

  afterAll(async () => {
    if (!sql) return;
    await sql.begin(async (tx) => {
      await tx.unsafe("set local session_replication_role = replica");
      for (const table of ["visit_transactions", "visit_charges", "notification_jobs", "payment_refunds", "payment_invoices", "visits"]) {
        await tx.unsafe(`delete from public.${table} where clinic_id = $1`, [clinic]);
      }
    });
    await sql`delete from public.payment_provider_events where invoice_id is null or invoice_id not in (select id from public.payment_invoices)`;
    await sql`delete from public.clinics where id = ${clinic}`;
    await sql`delete from auth.users where id in ${sql(Object.values(people))}`;
    await sql.end({ timeout: 5 });
  });

  it("a forged or unsigned webhook gets 401 and changes nothing", async () => {
    const appointment = await booking();
    const inv = await invoiceFor(appointment);
    expect(inv.amount).toBe(120000); // the server's price
    const body = { eventId: randomUUID(), invoiceId: inv.invoiceId, amount: inv.amount, currency: inv.currency };
    expect((await hook(body, "0".repeat(64))).status).toBe(401);
    expect((await hook(body, "not-hex")).status).toBe(401);
    const [p] = await sql`select status from public.payments where appointment_id = ${appointment}`;
    expect(p.status).toBe("unpaid");
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from public.payment_provider_events where invoice_id = ${inv.invoiceId}`;
    expect(n).toBe(0);
  });

  it("a signed event for another amount is never 'paid' — the payment goes to manual review", async () => {
    const appointment = await booking();
    const inv = await invoiceFor(appointment);
    const r = await hook({ eventId: randomUUID(), invoiceId: inv.invoiceId, amount: 1000, currency: inv.currency });
    expect(r.body).toMatchObject({ ok: true, outcome: "rejected" });
    const [p] = await sql`select status from public.payments where appointment_id = ${appointment}`;
    expect(p.status).toBe("manual_review");
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from public.visits where appointment_id = ${appointment}`;
    expect(n).toBe(0);
  });

  it("paid: the payment, the booking, a visit with today's next number and the ticket — once, whatever the provider retries", async () => {
    const appointment = await booking();
    const inv = await invoiceFor(appointment);
    expect((await mini(statusRoute, { appointmentId: appointment })).body.data).toMatchObject({ paymentStatus: "unpaid", queueNumber: null, onlineAvailable: true });

    const eventId = randomUUID();
    expect((await paid(inv, eventId)).body).toMatchObject({ ok: true, outcome: "settled" });
    expect((await paid(inv, eventId)).body).toMatchObject({ ok: true, outcome: "replayed" });

    const [state] = await sql`
      select p.status as payment, a.status as appointment, v.status as visit, v.source, v.queue_number, v.queue_date::text, v.arrived_at
        from public.payments p join public.appointments a on a.id = p.appointment_id left join public.visits v on v.appointment_id = a.id
       where a.id = ${appointment}`;
    expect(state).toMatchObject({ payment: "paid", appointment: "confirmed", visit: "booked", source: "online", arrived_at: null });
    expect(state.queue_number).toBeGreaterThan(0);
    const ledger = await sql`select t.kind, t.method, t.amount::float8 as amount, t.executed_by from public.visit_transactions t join public.visits v on v.id = t.visit_id where v.appointment_id = ${appointment}`;
    expect(ledger).toEqual([{ kind: "collection", method: "online", amount: 120000, executed_by: null }]);
    const jobs = await sql`select type, patient_telegram_user_id from public.notification_jobs j join public.visits v on v.id = j.visit_id where v.appointment_id = ${appointment}`;
    expect(jobs).toEqual([{ type: "queue_ticket", patient_telegram_user_id: String(tg) }]);

    const status = (await mini(statusRoute, { appointmentId: appointment })).body.data!;
    expect(status).toMatchObject({ paymentStatus: "paid", queueNumber: state.queue_number, visitStatus: "booked" });

    // Paying the same invoice a second time: never a second visit — the money goes back.
    expect((await paid(inv)).body).toMatchObject({ outcome: "refund_requested" });
    const [{ visits }] = await sql<{ visits: number }[]>`select count(*)::int as visits from public.visits where appointment_id = ${appointment}`;
    expect(visits).toBe(1);
    const refunds = await sql`select r.reason, r.status from public.payment_refunds r join public.payments p on p.id = r.payment_id where p.appointment_id = ${appointment}`;
    expect(refunds).toEqual([{ reason: "duplicate_payment", status: "requested" }]);
  });

  it("many patients paying at once get distinct numbers; the kassa's cash and terminal totals are untouched", async () => {
    const appointments = await Promise.all(Array.from({ length: 8 }, () => booking()));
    const invoices = await Promise.all(appointments.map(invoiceFor));
    const results = await Promise.all(invoices.map((inv) => paid(inv)));
    expect(results.every((r) => r.body.outcome === "settled")).toBe(true);
    const numbers = await sql<{ queue_date: string; queue_number: number }[]>`
      select queue_date::text, queue_number from public.visits where clinic_id = ${clinic} and queue_number is not null`;
    expect(new Set(numbers.map((n) => `${n.queue_date}#${n.queue_number}`)).size).toBe(numbers.length);

    as(people.owner, "owner");
    const totals = await kassaTotals(
      { profileId: people.owner, clinicId: clinic, clinicName: "Pay", clinicTimezone: "Asia/Tashkent", roles: ["owner"], platformAdmin: false } as never,
      new Date(Date.now() - 3_600_000).toISOString(),
      new Date(Date.now() + 3_600_000).toISOString(),
      true,
    );
    expect(totals.byMethod.cash.collected).toBe(0);
    expect(totals.byMethod.terminal.collected).toBe(0);
    expect(totals.byMethod.online.collected).toBeGreaterThanOrEqual(8 * 120000);
    expect(totals.byStaff).toEqual([]);
  });

  it("reception marks arrival; the doctor starts the booked appointment itself; a cancelled booking is refunded", async () => {
    const appointment = await booking();
    await paid(await invoiceFor(appointment));
    const [v] = await sql<{ id: string; queue_date: string }[]>`select id, queue_date::text from public.visits where appointment_id = ${appointment}`;

    as(people.reception, "receptionist");
    const list = await read(await bookedList());
    const today = list.body.data!.day as string;
    if (v.queue_date === today) {
      expect((list.body.data!.visits as Array<{ id: string }>).map((x) => x.id)).toContain(v.id);
      expect(JSON.stringify(list.body)).not.toMatch(/date_of_birth|document|pinfl/);
      // Not in the waiting queue until the patient is here.
      expect((await listOpenVisits(clinic, { doctorId: doctor })).map((x) => x.id)).not.toContain(v.id);
      const r = await read(await arrived(new NextRequest("http://x", { method: "POST" }), { params: Promise.resolve({ id: v.id }) }));
      expect(r.status).toBe(200);
      expect((await listOpenVisits(clinic, { doctorId: doctor })).map((x) => x.id)).toContain(v.id);

      as(people.doctor, "doctor");
      const started = await read(
        await doctorAct(new NextRequest("http://x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "start", expected: "waiting" }) }), {
          params: Promise.resolve({ id: v.id }),
        }),
      );
      expect(started.status, JSON.stringify(started.body)).toBe(200);
      const [after] = await sql`select v.status, v.appointment_id, a.status as appointment from public.visits v join public.appointments a on a.id = v.appointment_id where v.id = ${v.id}`;
      expect(after).toMatchObject({ status: "in_progress", appointment_id: appointment, appointment: "in_progress" });
      const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from public.appointments where patient_id = ${patient} and status = 'in_progress'`;
      expect(n).toBe(1); // no second appointment was created
    } else {
      const r = await read(await arrived(new NextRequest("http://x", { method: "POST" }), { params: Promise.resolve({ id: v.id }) }));
      expect(r.body.code).toBe("not_today");
    }

    // Cancelling another paid booking cancels its visit and asks for the money back; the owner records the refund.
    const second = await booking();
    await paid(await invoiceFor(second));
    await sql`update public.appointments set status = 'cancelled', cancelled_at = now() where id = ${second}`;
    const [cancelled] = await sql`select status from public.visits where appointment_id = ${second}`;
    expect(cancelled.status).toBe("cancelled");
    as(people.owner, "owner");
    const refunds = (await read(await refundList())).body.data!.refunds as Array<{ id: string; reason: string; amount: number }>;
    const mine = refunds.find((r) => r.reason === "booking_cancelled")!;
    expect(mine).toMatchObject({ amount: 120000 });
    as(people.cashier, "cashier");
    expect((await read(await refundList())).status).toBe(403);
    as(people.owner, "owner");
    const done = await read(
      await refundDone(new NextRequest("http://x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reference: "RAH-123456" }) }), {
        params: Promise.resolve({ id: mine.id }),
      }),
    );
    expect(done.status).toBe(200);
    const [p] = await sql`select status from public.payments where appointment_id = ${second}`;
    expect(p.status).toBe("refunded");
    const ledger = await sql`select t.kind, t.method from public.visit_transactions t join public.visits v on v.id = t.visit_id where v.appointment_id = ${second} order by t.created_at`;
    expect(ledger).toEqual([{ kind: "collection", method: "online" }, { kind: "refund", method: "online" }]);
  });

  it("without an online provider configured, the checkout is refused and patients pay at the kassa", async () => {
    const appointment = await booking();
    process.env.ONLINE_PAYMENT_PROVIDER = "none";
    try {
      expect(await mini(invoiceRoute, { appointmentId: appointment })).toMatchObject({ status: 503, body: { code: "provider_unavailable" } });
      expect((await mini(statusRoute, { appointmentId: appointment })).body.data).toMatchObject({ onlineAvailable: false });
    } finally {
      process.env.ONLINE_PAYMENT_PROVIDER = "test_online";
    }
  });
});
