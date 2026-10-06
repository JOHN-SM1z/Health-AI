import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { localDbAvailable } from "@/test/local-db";

vi.mock("@/lib/telegram/bot", () => ({
  sendTelegramMessage: vi.fn(async () => 5151),
}));

/**
 * Lab notifications (Phase 16) on the real database and the existing
 * notification worker: who is told about each lifecycle event, clinic
 * settings, duplicate events, failed sends and retries, wrong clinic, wrong
 * patient, and the staff inbox (no values; doctors only while they may see
 * the patient).
 */

const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const session = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/staff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/staff")>();
  return { ...actual, getStaffContext: async () => session.ctx };
});

import { sendTelegramMessage } from "@/lib/telegram/bot";
import { processDueNotificationJobs } from "@/lib/notifications/processor";
import { GET as inbox, POST as inboxAction } from "../staff/notifications/route";

const describeDb = describe.skipIf(!localDbAvailable());

type Job = { id: string; type: string; channel: string; recipient_profile_id: string | null; status: string; attempts: number; error: string | null; patient_telegram_user_id: number | null };
type Body = { ok: boolean; data?: Record<string, unknown>; code?: string };
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Body });

describeDb("lab notifications (real database)", () => {
  let admin: SupabaseClient;
  const suffix = Date.now().toString(36);
  const clinicA: string = randomUUID();
  const clinicB: string = randomUUID();
  const people = {
    reception: randomUUID(), lab1: randomUUID(), lab2: randomUUID(), owner: randomUUID(), manager: randomUUID(),
    drA: randomUUID(), drC: randomUUID(), labB: randomUUID(),
  };
  const doctors = { a: randomUUID(), c: randomUUID() };
  const service = randomUUID();
  let test = "";
  let param = "";
  let day = 0;
  const tg = 600_000_000 + Math.floor(Math.random() * 1e8);

  const as = (profileId: string, role: string, clinicId = clinicA) => {
    session.ctx = { profileId, clinicId, clinicName: "Notify", clinicTimezone: "Asia/Tashkent", roles: [role], platformAdmin: false };
  };
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await admin.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  };
  const settings = (value: Record<string, unknown>) => admin.from("app_settings").upsert({ clinic_id: clinicA, key: "lab", value });
  const jobs = async (filter: { orderId?: string; resultId?: string }) => {
    let q = admin.from("notification_jobs").select("id, type, channel, recipient_profile_id, status, attempts, error, patient_telegram_user_id").eq("clinic_id", clinicA);
    if (filter.orderId) q = q.eq("lab_order_id", filter.orderId);
    if (filter.resultId) q = q.eq("lab_result_id", filter.resultId);
    const { data } = await q;
    return (data ?? []) as Job[];
  };
  const staffOf = (list: Job[], type: string) => list.filter((j) => j.type === type && j.channel === "in_app").map((j) => j.recipient_profile_id).sort();
  const sorted = (...ids: string[]) => [...ids].sort();
  // Other suites run the worker too: keep this suite's patient jobs parked until it processes them.
  const park = () => admin.from("notification_jobs").update({ scheduled_for: new Date(Date.now() + 86_400_000).toISOString() }).eq("clinic_id", clinicA).eq("status", "pending");
  const makeDue = () => admin.from("notification_jobs").update({ scheduled_for: new Date(Date.now() - 1000).toISOString() }).eq("clinic_id", clinicA).eq("status", "pending");

  async function patient(telegram: number | null = null) {
    const { data } = await admin.from("patients").insert({ clinic_id: clinicA, full_name: `Xabar bemor ${suffix}`, date_of_birth: "1990-01-01", telegram_user_id: telegram }).select("id").single();
    return data!.id as string;
  }
  /** Dr A's consultation order for the patient (the ordering doctor). */
  async function consultationOrder(patientId: string) {
    const start = new Date(Date.UTC(2024, 0, 1, 5, 0) + day++ * 86_400_000);
    const { data: appt } = await admin
      .from("appointments")
      .insert({ clinic_id: clinicA, patient_id: patientId, doctor_id: doctors.a, service_id: service, start_at: start.toISOString(), end_at: new Date(start.getTime() + 1_800_000).toISOString(), status: "completed", source: "walk_in" })
      .select("id")
      .single();
    const o = (await rpc("create_lab_order", {
      p_clinic_id: clinicA, p_patient_id: patientId, p_ordered_by: people.drA, p_source: "consultation", p_test_ids: [test], p_panel_ids: [],
      p_ordering_doctor_id: doctors.a, p_appointment_id: appt!.id,
    })) as Array<{ lab_order_id: string }>;
    const { data: item } = await admin.from("lab_order_items").select("id").eq("order_id", o[0].lab_order_id).single();
    return { orderId: o[0].lab_order_id, itemId: item!.id as string };
  }
  async function receivedAndSubmitted(itemId: string, orderId: string, value = 140) {
    const s = (await rpc("collect_lab_sample", { p_clinic_id: clinicA, p_order_id: orderId, p_item_ids: [itemId], p_collected_by: people.reception })) as Array<{ lab_sample_id: string }>;
    await rpc("receive_lab_sample", { p_clinic_id: clinicA, p_sample_id: s[0].lab_sample_id, p_received_by: people.lab1 });
    const r = (await rpc("save_lab_result_draft", { p_clinic_id: clinicA, p_order_item_id: itemId, p_entered_by: people.lab1, p_values: [{ parameter_id: param, value_numeric: value }] })) as Array<{ lab_result_id: string }>;
    await rpc("submit_lab_result", { p_clinic_id: clinicA, p_result_id: r[0].lab_result_id, p_submitted_by: people.lab1 });
    return { resultId: r[0].lab_result_id, sampleId: s[0].lab_sample_id };
  }

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    await admin.from("clinics").insert([
      { id: clinicA, name: `Notify A ${suffix}`, slug: `notify-a-${suffix}`, timezone: "Asia/Tashkent" },
      { id: clinicB, name: `Notify B ${suffix}`, slug: `notify-b-${suffix}`, timezone: "Asia/Tashkent" },
    ]);
    for (const [name, id] of Object.entries(people)) {
      const { error } = await admin.auth.admin.createUser({ id, email: `notify-${name}-${suffix}@test.local`, email_confirm: true, password: `Pw-${randomUUID()}` });
      if (error) throw new Error(error.message);
      await admin.from("profiles").insert({ id, full_name: name });
    }
    await admin.from("staff_roles").insert([
      { clinic_id: clinicA, profile_id: people.reception, role: "receptionist" },
      { clinic_id: clinicA, profile_id: people.lab1, role: "lab" },
      { clinic_id: clinicA, profile_id: people.lab2, role: "lab" },
      { clinic_id: clinicA, profile_id: people.owner, role: "owner" },
      { clinic_id: clinicA, profile_id: people.manager, role: "manager" },
      { clinic_id: clinicA, profile_id: people.drA, role: "doctor" },
      { clinic_id: clinicA, profile_id: people.drC, role: "doctor" },
      { clinic_id: clinicB, profile_id: people.labB, role: "lab" },
    ]);
    await admin.from("doctors").insert([
      { id: doctors.a, clinic_id: clinicA, profile_id: people.drA, name: `Dr A ${suffix}`, active: true },
      { id: doctors.c, clinic_id: clinicA, profile_id: people.drC, name: `Dr C ${suffix}`, active: true },
    ]);
    await admin.from("services").insert({ id: service, clinic_id: clinicA, name: `Notify consult ${suffix}`, duration_minutes: 30, price: 1 });
    await admin.from("doctor_working_hours").insert([1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinic_id: clinicA, doctor_id: doctors.a, weekday, start_time: "00:00", end_time: "23:59" })));
    const { data: t } = await admin.from("lab_tests").insert({ clinic_id: clinicA, code: `NTF${suffix}`, name: `Xabar testi ${suffix}`, sample_type: "Qon", price: 1000 }).select("id").single();
    test = t!.id;
    const { data: p } = await admin.from("lab_test_parameters").insert({ clinic_id: clinicA, test_id: test, code: "HGB", name: "Gemoglobin", value_type: "numeric", unit: "g/L" }).select("id").single();
    param = p!.id;
  });

  afterAll(async () => {
    if (!admin) return;
    await admin.from("clinics").delete().in("id", [clinicA, clinicB]);
    for (const id of Object.values(people)) await admin.auth.admin.deleteUser(id);
  });

  beforeEach(async () => {
    await settings({});
    vi.mocked(sendTelegramMessage).mockReset();
    vi.mocked(sendTelegramMessage).mockResolvedValue(5151);
  });

  it("tells the right people about each lifecycle event — never the actor, never another clinic — once per event", async () => {
    const pid = await patient(tg);
    const { orderId, itemId } = await consultationOrder(pid);
    let list = await jobs({ orderId });
    // LAB_ORDER_CREATED → lab staff (the ordering doctor caused it).
    expect(staffOf(list, "lab_order_created")).toEqual(sorted(people.lab1, people.lab2));

    const { resultId, sampleId } = await receivedAndSubmitted(itemId, orderId);
    list = await jobs({ orderId });
    // LAB_SAMPLE_COLLECTED → lab staff (reception collected).
    expect(staffOf(list, "lab_sample_collected")).toEqual(sorted(people.lab1, people.lab2));
    expect(sampleId).toBeTruthy();
    // LAB_RESULT_ENTERED → the verifiers, not the author: the other lab technician and the ordering doctor.
    expect(staffOf(await jobs({ resultId }), "lab_result_entered")).toEqual(sorted(people.lab2, people.drA));

    // Duplicate event: returned and submitted again → still one notification per recipient.
    await rpc("return_lab_result", { p_clinic_id: clinicA, p_result_id: resultId, p_by: people.lab2 });
    await rpc("submit_lab_result", { p_clinic_id: clinicA, p_result_id: resultId, p_submitted_by: people.lab1 });
    expect(staffOf(await jobs({ resultId }), "lab_result_entered")).toEqual(sorted(people.lab2, people.drA));

    // LAB_RESULT_VERIFIED → the ordering doctor; LAB_RESULT_READY → the patient (Telegram).
    await rpc("verify_lab_result", { p_clinic_id: clinicA, p_result_id: resultId, p_verified_by: people.lab2 });
    await park();
    list = await jobs({ resultId });
    expect(staffOf(list, "lab_result_verified")).toEqual([people.drA]);
    expect(list.filter((j) => j.type === "lab_result_ready")).toEqual([expect.objectContaining({ channel: "telegram", patient_telegram_user_id: tg, recipient_profile_id: null })]);

    // LAB_RESULT_CORRECTED → the ordering doctor.
    const c = (await rpc("start_lab_result_correction", { p_clinic_id: clinicA, p_result_id: resultId, p_by: people.lab1, p_reason: "Qayta o‘lchandi" })) as Array<{ lab_result_id: string }>;
    await rpc("save_lab_result_draft", { p_clinic_id: clinicA, p_order_item_id: itemId, p_entered_by: people.lab1, p_values: [{ parameter_id: param, value_numeric: 141 }] });
    await rpc("submit_lab_result", { p_clinic_id: clinicA, p_result_id: c[0].lab_result_id, p_submitted_by: people.lab1 });
    await rpc("verify_lab_result", { p_clinic_id: clinicA, p_result_id: c[0].lab_result_id, p_verified_by: people.lab2 });
    await park();
    expect(staffOf(await jobs({ resultId: c[0].lab_result_id }), "lab_result_corrected")).toEqual([people.drA]);

    // Nobody in another clinic, no unrelated doctor, no receptionist was told anything.
    const { data: anyB } = await admin.from("notification_jobs").select("id").eq("clinic_id", clinicB);
    expect(anyB).toEqual([]);
    const { data: wrongPeople } = await admin.from("notification_jobs").select("id").eq("clinic_id", clinicA).in("recipient_profile_id", [people.drC, people.labB, people.reception]);
    expect(wrongPeople).toEqual([]);
  });

  it("cancellation tells lab staff, managers and the ordering doctor; the patient only when the clinic enables it", async () => {
    const pid = await patient(tg + 1);
    const a = await consultationOrder(pid);
    await admin.from("lab_orders").update({ status: "cancelled", cancelled_by: people.reception, cancelled_at: new Date().toISOString(), cancel_reason: "Bemor kelmadi" }).eq("id", a.orderId);
    let list = await jobs({ orderId: a.orderId });
    expect(staffOf(list, "lab_order_cancelled")).toEqual(sorted(people.lab1, people.lab2, people.owner, people.manager, people.drA));
    expect(list.filter((j) => j.type === "lab_order_cancelled" && j.channel === "telegram")).toEqual([]);

    await settings({ notifyPatientOnCancel: true });
    const b = await consultationOrder(pid);
    await admin.from("lab_orders").update({ status: "cancelled", cancelled_by: people.lab1, cancelled_at: new Date().toISOString(), cancel_reason: "Namuna yo‘q" }).eq("id", b.orderId);
    await park();
    list = await jobs({ orderId: b.orderId });
    expect(list.filter((j) => j.channel === "telegram")).toEqual([expect.objectContaining({ type: "lab_order_cancelled", patient_telegram_user_id: tg + 1 })]);
    expect(staffOf(list, "lab_order_cancelled")).not.toContain(people.lab1); // the actor

    // The worker sends it — without test names — through this clinic's bot.
    const send = vi.mocked(sendTelegramMessage);
    await makeDue();
    await processDueNotificationJobs(200, [clinicA, clinicB]);
    const toPatient = send.mock.calls.filter(([p]) => Number(p.chatId) === tg + 1);
    expect(toPatient).toHaveLength(1);
    expect(toPatient[0][1]).toBe(clinicA);
    expect(toPatient[0][0].text).toContain("Laboratoriya buyurtmangiz bekor qilindi");
    expect(toPatient[0][0].text).not.toContain("Xabar testi");
    // In-app rows are never handed to Telegram.
    expect(send.mock.calls.some(([p]) => p.chatId === null || p.chatId === undefined)).toBe(false);
    expect((await jobs({ orderId: b.orderId })).filter((j) => j.channel === "in_app").every((j) => j.status === "sent" && j.attempts === 0)).toBe(true);
  });

  it("follows the clinic's settings: staff notifications off, lab-only verifiers; imports notify nobody", async () => {
    await settings({ notifyStaff: false });
    const pid = await patient();
    const a = await consultationOrder(pid);
    expect(await jobs({ orderId: a.orderId })).toEqual([]);

    await settings({ verifiers: "lab_only" });
    const b = await consultationOrder(pid);
    const { resultId } = await receivedAndSubmitted(b.itemId, b.orderId);
    expect(staffOf(await jobs({ resultId }), "lab_result_entered")).toEqual([people.lab2]);

    await settings({ verifiers: "doctor_only" });
    const c = await consultationOrder(pid);
    const r2 = await receivedAndSubmitted(c.itemId, c.orderId);
    expect(staffOf(await jobs({ resultId: r2.resultId }), "lab_result_entered")).toEqual([people.drA]);

    const { data: imported } = await admin
      .from("lab_orders")
      .insert({ clinic_id: clinicA, patient_id: pid, source: "external_import", ordered_by: people.lab1, external_reference: `import:${randomUUID()}` })
      .select("id")
      .single();
    expect(await jobs({ orderId: imported!.id })).toEqual([]);
  });

  it("retries a failed patient message, gives up after the limit, and skips a changed recipient (wrong patient)", async () => {
    await settings({ notifyPatientOnCancel: true });
    const send = vi.mocked(sendTelegramMessage);

    // Failed then retried: the first send fails, the next run delivers it.
    const p1 = await patient(tg + 2);
    const o1 = await consultationOrder(p1);
    await admin.from("lab_orders").update({ status: "cancelled", cancelled_by: people.reception, cancelled_at: new Date().toISOString(), cancel_reason: "x x" }).eq("id", o1.orderId);
    await park();
    send.mockImplementation(async (payload) => (Number(payload.chatId) === tg + 2 && send.mock.calls.filter(([p]) => Number(p.chatId) === tg + 2).length === 1 ? null : 5151));
    await makeDue();
    await processDueNotificationJobs(200, [clinicA, clinicB]);
    let job = (await jobs({ orderId: o1.orderId })).find((j) => j.channel === "telegram")!;
    expect(job).toMatchObject({ status: "pending", attempts: 1, error: "send failed, retrying" });
    await processDueNotificationJobs(200, [clinicA, clinicB]);
    job = (await jobs({ orderId: o1.orderId })).find((j) => j.channel === "telegram")!;
    expect(job).toMatchObject({ status: "sent", attempts: 2 });
    expect(send.mock.calls.filter(([p]) => Number(p.chatId) === tg + 2)).toHaveLength(2);
    // Duplicate run: nothing is sent again.
    await processDueNotificationJobs(200, [clinicA, clinicB]);
    expect(send.mock.calls.filter(([p]) => Number(p.chatId) === tg + 2)).toHaveLength(2);

    // Always failing: gives up after max attempts.
    const p2 = await patient(tg + 3);
    const o2 = await consultationOrder(p2);
    await admin.from("lab_orders").update({ status: "cancelled", cancelled_by: people.reception, cancelled_at: new Date().toISOString(), cancel_reason: "x x" }).eq("id", o2.orderId);
    await park();
    send.mockImplementation(async (payload) => (Number(payload.chatId) === tg + 3 ? null : 5151));
    for (let i = 0; i < 3; i++) {
      await makeDue();
      await processDueNotificationJobs(200, [clinicA, clinicB]);
    }
    job = (await jobs({ orderId: o2.orderId })).find((j) => j.channel === "telegram")!;
    expect(job).toMatchObject({ status: "failed", attempts: 3, error: "send failed after retries" });

    // Wrong patient: the record's Telegram identity changed before sending → skipped, nothing sent to the old chat.
    const p3 = await patient(tg + 4);
    const o3 = await consultationOrder(p3);
    await admin.from("lab_orders").update({ status: "cancelled", cancelled_by: people.reception, cancelled_at: new Date().toISOString(), cancel_reason: "x x" }).eq("id", o3.orderId);
    await park();
    await admin.from("patients").update({ telegram_user_id: tg + 5 }).eq("id", p3);
    send.mockClear();
    send.mockResolvedValue(5151);
    await makeDue();
    await processDueNotificationJobs(200, [clinicA, clinicB]);
    job = (await jobs({ orderId: o3.orderId })).find((j) => j.channel === "telegram")!;
    expect(job).toMatchObject({ status: "skipped", error: "recipient changed" });
    expect(send.mock.calls.filter(([p]) => [tg + 4, tg + 5].includes(Number(p.chatId)))).toEqual([]);
  });

  it("the staff inbox shows each person their own notifications, without values, and only patients they may see", async () => {
    const pid = await patient();
    const { orderId, itemId } = await consultationOrder(pid);
    const { resultId } = await receivedAndSubmitted(itemId, orderId, 155);
    await rpc("verify_lab_result", { p_clinic_id: clinicA, p_result_id: resultId, p_verified_by: people.lab2 });

    as(people.drA, "doctor");
    const mine = await read(await inbox());
    const items = mine.body.data!.notifications as Array<{ id: string; type: string; title: string; detail: string; href: string; read: boolean }>;
    const verified = items.find((n) => n.type === "lab_result_verified")!;
    expect(verified).toMatchObject({ title: "Laboratoriya natijasi tasdiqlandi", detail: `Xabar bemor ${suffix} · Xabar testi ${suffix}`, href: `/doctor/patients/${pid}`, read: false });
    // What the reader sees never carries a value (ids and timestamps aside).
    for (const n of items) expect(`${n.title} ${n.detail}`).not.toMatch(/\b155\b|g\/L|Gemoglobin/);

    // A notification about a patient the doctor may not see is not shown (re-checked at read time).
    await admin.from("notification_jobs").insert({
      clinic_id: clinicA, type: "lab_result_verified", channel: "in_app", recipient_type: "staff", recipient_profile_id: people.drC,
      lab_order_id: orderId, lab_result_id: resultId, scheduled_for: new Date().toISOString(), status: "sent", idempotency_key: `test:${randomUUID()}`,
    });
    as(people.drC, "doctor");
    expect(((await read(await inbox())).body.data!.notifications as unknown[]).length).toBe(0);

    // Wrong clinic: another clinic's lab sees nothing of this one.
    as(people.labB, "lab", clinicB);
    expect((await read(await inbox())).body.data).toMatchObject({ notifications: [], unread: 0 });

    // Mark read: only one's own.
    as(people.lab1, "lab");
    const lab1 = await read(await inbox());
    expect(lab1.body.data!.unread).toBeGreaterThan(0);
    const lab2Ids = (await jobs({ orderId })).filter((j) => j.recipient_profile_id === people.lab2).map((j) => j.id);
    await inboxAction(new NextRequest("http://localhost/api/staff/notifications", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "read", ids: lab2Ids }) }));
    as(people.lab2, "lab");
    const lab2Before = (await read(await inbox())).body.data!.unread as number;
    expect(lab2Before).toBeGreaterThan(0);
    as(people.lab1, "lab");
    await inboxAction(new NextRequest("http://localhost/api/staff/notifications", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "read" }) }));
    expect((await read(await inbox())).body.data!.unread).toBe(0);
    as(people.lab2, "lab");
    expect((await read(await inbox())).body.data!.unread).toBe(lab2Before);
  });
});
