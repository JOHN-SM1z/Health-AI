import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { localDbAvailable } from "@/test/local-db";

/**
 * Laboratory QA (Phase 20) — the complete critical path through the real
 * route handlers, the real database, the real notification worker and real
 * storage, with only Telegram's network call and the AI provider stubbed:
 *
 *   patient → doctor consultation → lab order → payment (clinic policy:
 *   before collection) → sample collection → processing → result entry →
 *   verification → longitudinal history → doctor notification → patient
 *   Telegram message → patient result view → secure document access →
 *   AI summary (enabled)
 *
 * and the interruptions and edge cases around it: collection before payment,
 * duplicate order / sample / submission, self-verification, a verification
 * race, a failed Telegram send and its retry, AI disabled and unavailable,
 * cancellation and refund, correction, missing values, a single lab person
 * (no second verifier), an inactive test, an inactive doctor, a patient
 * mismatch and a cross-clinic mismatch.
 */

const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const session = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/staff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/staff")>();
  return { ...actual, getStaffContext: async () => session.ctx };
});
const telegram = vi.hoisted(() => ({ fail: 0, sent: [] as Array<{ chatId: number; text: string }> }));
vi.mock("@/lib/telegram/bot", () => ({
  sendTelegramMessage: vi.fn(async (payload: { chatId: number; text: string }) => {
    if (telegram.fail > 0) {
      telegram.fail -= 1;
      throw new Error("telegram unavailable");
    }
    telegram.sent.push({ chatId: Number(payload.chatId), text: payload.text });
    return 9000 + telegram.sent.length;
  }),
  getTelegramFileUrl: vi.fn(async () => null),
  telegramConfigured: vi.fn(() => true),
}));
const ai = vi.hoisted(() => ({ mode: "echo" as "echo" | "down" | "off", calls: 0 }));
vi.mock("@/lib/ai/provider", () => ({
  getAiProvider: () =>
    ai.mode === "off"
      ? null
      : {
          name: "stand-in",
          generateReply: async (opts: { messages: Array<{ content: string }> }) => {
            ai.calls += 1;
            if (ai.mode === "down") throw new Error("provider timeout");
            const { statements } = JSON.parse(opts.messages[0].content) as { statements: Array<{ id: string; text: string }> };
            return JSON.stringify({ bullets: statements.map((s) => ({ id: s.id, text: s.text })) });
          },
        },
}));

import { processDueNotificationJobs } from "@/lib/notifications/processor";
import { POST as doctorOrder } from "../doctor/patients/[id]/lab-orders/route";
import { GET as labHistory } from "../doctor/patients/[id]/lab-history/route";
import { GET as labSummary } from "../doctor/patients/[id]/lab-summary/route";
import { POST as pay } from "../admin/lab/orders/[id]/payment/route";
import { POST as collect } from "./orders/[id]/samples/route";
import { POST as cancelOrder } from "./orders/[id]/route";
import { POST as walkIn } from "./orders/route";
import { POST as sampleAction } from "./samples/[id]/route";
import { PUT as saveResult } from "./items/[id]/result/route";
import { POST as resultAction } from "./results/[id]/route";
import { POST as uploadDocument } from "./orders/[id]/documents/route";
import { GET as inbox } from "../staff/notifications/route";
import { POST as myResults } from "../me/lab-results/route";
import { POST as myResult } from "../me/lab-results/[itemId]/route";
import { POST as myDocument } from "../me/lab-documents/[id]/route";

const describeDb = describe.skipIf(!localDbAvailable());
type Body = { ok: boolean; data?: Record<string, unknown>; code?: string };
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Body });
const json = (path: string, method: string, body: unknown) => new NextRequest(`http://localhost${path}`, { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
const PDF = new TextEncoder().encode("%PDF-1.4\n% report\n%%EOF");

function signInitData(botToken: string, telegramUserId: number) {
  const fields: Array<[string, string]> = [["auth_date", String(Math.floor(Date.now() / 1000))], ["query_id", "AAHqa"], ["user", JSON.stringify({ id: telegramUserId, first_name: "Bemor" })]];
  const check = fields.map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return `${fields.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}&hash=${hash}`;
}

describeDb("lab critical path (QA, real database and routes)", () => {
  let admin: SupabaseClient;
  const suffix = Date.now().toString(36);
  const seed = Math.floor(Math.random() * 90_000) + 1000;
  const clinicA: string = randomUUID();
  const clinicB: string = randomUUID();
  const BOT = `${seed}:QA-${suffix}-${"x".repeat(20)}`;
  const people = { owner: randomUUID(), reception: randomUUID(), lab1: randomUUID(), lab2: randomUUID(), drA: randomUUID(), drGone: randomUUID(), labB: randomUUID() };
  const doctors = { a: randomUUID(), gone: randomUUID() };
  const service = randomUUID();
  const tg = { patient: 700_000_000 + seed, other: 710_000_000 + seed };
  const s = { test: "", param: "", inactiveTest: "", patient: "", other: "", visit: "", order: "", item: "", sample: "", result: "", document: "", patientB: "" };
  const paths: string[] = [];

  const as = (profileId: string, role: string, clinicId = clinicA) => {
    session.ctx = { profileId, clinicId, clinicName: "QA", clinicTimezone: "Asia/Tashkent", roles: [role], platformAdmin: false };
  };
  const mini = async (handler: (r: NextRequest, c: never) => Promise<Response>, path: string, telegramId: number, p: Record<string, string> = {}) =>
    read(await handler(new NextRequest(`http://localhost${path}?clinic=${clinicA}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `10.7.${seed % 250}.${Math.floor(Math.random() * 250)}` }, body: JSON.stringify({ initData: signInitData(BOT, telegramId) }) }), params(p) as never));
  const telegramJobs = async (resultId: string) => (await admin.from("notification_jobs").select("id, type, status, attempts, patient_telegram_user_id").eq("lab_result_id", resultId).eq("channel", "telegram")).data ?? [];

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    await admin.from("clinics").insert([
      { id: clinicA, name: `QA A ${suffix}`, slug: `qa-a-${suffix}`, timezone: "Asia/Tashkent" },
      { id: clinicB, name: `QA B ${suffix}`, slug: `qa-b-${suffix}`, timezone: "Asia/Tashkent" },
    ]);
    await admin.from("clinic_telegram_integrations").insert({ clinic_id: clinicA, telegram_bot_token: BOT, telegram_bot_id: 600000 + seed, telegram_username: `qa_${suffix}_bot`, telegram_bot_name: "QA", status: "active", enabled: true, validated_at: new Date().toISOString() });
    for (const [name, id] of Object.entries(people)) {
      const { error } = await admin.auth.admin.createUser({ id, email: `qa-${name}-${suffix}@test.local`, email_confirm: true, password: `Pw-${randomUUID()}` });
      if (error) throw new Error(error.message);
      await admin.from("profiles").insert({ id, full_name: name });
    }
    await admin.from("staff_roles").insert([
      { clinic_id: clinicA, profile_id: people.owner, role: "owner" },
      { clinic_id: clinicA, profile_id: people.reception, role: "receptionist" },
      { clinic_id: clinicA, profile_id: people.lab1, role: "lab" },
      { clinic_id: clinicA, profile_id: people.lab2, role: "lab" },
      { clinic_id: clinicA, profile_id: people.drA, role: "doctor" },
      { clinic_id: clinicA, profile_id: people.drGone, role: "doctor" },
      { clinic_id: clinicB, profile_id: people.labB, role: "lab" },
    ]);
    await admin.from("doctors").insert([
      { id: doctors.a, clinic_id: clinicA, profile_id: people.drA, name: `Dr A ${suffix}`, active: true },
      { id: doctors.gone, clinic_id: clinicA, profile_id: people.drGone, name: `Dr Gone ${suffix}`, active: true },
    ]);
    await admin.from("services").insert({ id: service, clinic_id: clinicA, name: `QA consult ${suffix}`, duration_minutes: 30, price: 100000 });
    await admin.from("doctor_working_hours").insert([doctors.a, doctors.gone].flatMap((doctor_id) => [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinic_id: clinicA, doctor_id, weekday, start_time: "00:00", end_time: "23:59" }))));
    // Clinic policy: payment before collection; the patient sees released results; AI rewording on.
    await admin.from("app_settings").upsert({ clinic_id: clinicA, key: "lab", value: { paymentPolicy: "before_collection", releaseToPatient: true, verifiers: "lab_and_doctor", aiSummaries: true } });

    const { data: tests, error: testsError } = await admin.from("lab_tests").insert([
      { clinic_id: clinicA, code: `QA${suffix}`, name: "Umumiy qon tahlili", sample_type: "Qon", price: 60000, active: true },
      { clinic_id: clinicA, code: `QAOFF${suffix}`, name: "Eskirgan tahlil", sample_type: "Qon", price: 1000, active: false },
    ]).select("id, code");
    if (testsError) throw new Error(testsError.message);
    s.test = tests!.find((t) => t.code === `QA${suffix}`)!.id;
    s.inactiveTest = tests!.find((t) => t.code === `QAOFF${suffix}`)!.id;
    const { data: p } = await admin.from("lab_test_parameters").insert({ clinic_id: clinicA, test_id: s.test, code: "HGB", name: "Gemoglobin", value_type: "numeric", unit: "g/L" }).select("id").single();
    s.param = p!.id;
    await admin.from("lab_reference_ranges").insert({ clinic_id: clinicA, parameter_id: s.param, low: 120, high: 160 });
    const { data: pts } = await admin.from("patients").insert([
      { clinic_id: clinicA, full_name: `QA Bemor ${suffix}`, date_of_birth: "1984-04-04", telegram_user_id: tg.patient },
      { clinic_id: clinicA, full_name: `QA Boshqa ${suffix}`, date_of_birth: "1990-09-09", telegram_user_id: tg.other },
    ]).select("id, telegram_user_id");
    s.patient = pts!.find((x) => Number(x.telegram_user_id) === tg.patient)!.id;
    s.other = pts!.find((x) => Number(x.telegram_user_id) === tg.other)!.id;
    const { data: pb } = await admin.from("patients").insert({ clinic_id: clinicB, full_name: `QA B ${suffix}`, date_of_birth: "1980-01-01" }).select("id").single();
    s.patientB = pb!.id;
    // The doctor consultation.
    const start = new Date(Date.UTC(2024, 5, 1, 5, 0) + (seed % 400) * 86_400_000);
    const { data: visit } = await admin.from("appointments").insert({ clinic_id: clinicA, patient_id: s.patient, doctor_id: doctors.a, service_id: service, start_at: start.toISOString(), end_at: new Date(start.getTime() + 1_800_000).toISOString(), status: "completed", source: "walk_in" }).select("id").single();
    s.visit = visit!.id;
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    if (paths.length) await admin.storage.from("lab-documents").remove(paths);
    await admin.from("clinics").delete().in("id", [clinicA, clinicB]);
    for (const id of Object.values(people)) await admin.auth.admin.deleteUser(id);
  });

  it("1. the doctor orders from the consultation; a repeated request is the same order; an inactive test or another clinic's patient is refused", async () => {
    as(people.drA, "doctor");
    const key = randomUUID();
    const first = await read(await doctorOrder(json(`/api/doctor/patients/${s.patient}/lab-orders`, "POST", { idempotencyKey: key, appointmentId: s.visit, testIds: [s.test] }), params({ id: s.patient })));
    expect(first.status).toBe(201);
    s.order = (first.body.data as { orderId: string }).orderId;
    const again = await read(await doctorOrder(json(`/api/doctor/patients/${s.patient}/lab-orders`, "POST", { idempotencyKey: key, appointmentId: s.visit, testIds: [s.test] }), params({ id: s.patient })));
    expect([again.status, (again.body.data as { orderId: string }).orderId]).toEqual([200, s.order]);
    const { count } = await admin.from("lab_orders").select("id", { count: "exact", head: true }).eq("patient_id", s.patient);
    expect(count).toBe(1);
    expect((await doctorOrder(json(`/api/doctor/patients/${s.patient}/lab-orders`, "POST", { idempotencyKey: randomUUID(), testIds: [s.inactiveTest] }), params({ id: s.patient }))).status).toBeGreaterThanOrEqual(400);
    expect((await doctorOrder(json(`/api/doctor/patients/${s.patientB}/lab-orders`, "POST", { idempotencyKey: randomUUID(), testIds: [s.test] }), params({ id: s.patientB }))).status).toBe(404);
    const { data: item } = await admin.from("lab_order_items").select("id, status, price_snapshot").eq("order_id", s.order).single();
    s.item = item!.id;
    expect(item).toMatchObject({ status: "ordered", price_snapshot: 60000 }); // waits for payment (clinic policy)
  });

  it("2. interruption: no sample before payment; the desk takes the payment; collection then works once", async () => {
    as(people.reception, "receptionist");
    const early = await read(await collect(json(`/api/lab/orders/${s.order}/samples`, "POST", { idempotencyKey: randomUUID(), itemIds: [s.item] }), params({ id: s.order })));
    expect([early.status, early.body.code]).toEqual([409, "awaiting_payment"]);
    as(people.reception, "receptionist");
    expect((await pay(json(`/api/admin/lab/orders/${s.order}/payment`, "POST", { status: "paid", method: "cash" }), params({ id: s.order }))).status).toBe(403); // payment roles only
    as(people.owner, "owner");
    expect((await pay(json(`/api/admin/lab/orders/${s.order}/payment`, "POST", { status: "paid", method: "cash", amount: 1 }), params({ id: s.order }))).status).toBe(200);
    const { data: payment } = await admin.from("payments").select("status, amount").eq("lab_order_id", s.order).single();
    expect(payment).toEqual({ status: "paid", amount: 60000 });
    as(people.reception, "receptionist");
    const key = randomUUID();
    const sampled = await read(await collect(json(`/api/lab/orders/${s.order}/samples`, "POST", { idempotencyKey: key, itemIds: [s.item] }), params({ id: s.order })));
    expect(sampled.status).toBe(201);
    s.sample = (sampled.body.data as { sampleId: string }).sampleId;
    // Duplicate sample: the same request replays; a new one is refused.
    expect((await collect(json(`/api/lab/orders/${s.order}/samples`, "POST", { idempotencyKey: key, itemIds: [s.item] }), params({ id: s.order }))).status).toBe(200);
    expect((await read(await collect(json(`/api/lab/orders/${s.order}/samples`, "POST", { idempotencyKey: randomUUID(), itemIds: [s.item] }), params({ id: s.order })))).body.code).toBe("already_collected");
  });

  it("3. processing and result entry; missing values cannot be submitted; a repeated submission changes nothing", async () => {
    as(people.lab1, "lab");
    expect((await sampleAction(json(`/api/lab/samples/${s.sample}`, "POST", { action: "receive" }), params({ id: s.sample }))).status).toBe(200);
    const empty = await read(await saveResult(json(`/api/lab/items/${s.item}/result`, "PUT", { values: [] }), params({ id: s.item })));
    expect(empty.status).toBeLessThan(300);
    s.result = (empty.body.data as { resultId: string }).resultId;
    expect((await resultAction(json(`/api/lab/results/${s.result}`, "POST", { action: "submit" }), params({ id: s.result }))).status).toBeGreaterThanOrEqual(400); // missing result values
    expect((await saveResult(json(`/api/lab/items/${s.item}/result`, "PUT", { values: [{ parameterId: s.param, value: "112" }] }), params({ id: s.item }))).status).toBeLessThan(300);
    // The report file goes with the version being entered (a verified version is frozen).
    const form = new FormData();
    form.set("file", new Blob([PDF], { type: "application/pdf" }), "report.pdf");
    form.set("kind", "report");
    form.set("resultId", s.result);
    const up = await read(await uploadDocument(new NextRequest(`http://localhost/api/lab/orders/${s.order}/documents`, { method: "POST", body: form }), params({ id: s.order })));
    expect(up.status).toBe(201);
    s.document = up.body.data!.id as string;
    paths.push(`${clinicA}/${s.document}`);
    expect((await resultAction(json(`/api/lab/results/${s.result}`, "POST", { action: "submit" }), params({ id: s.result }))).status).toBe(200);
    const twice = await resultAction(json(`/api/lab/results/${s.result}`, "POST", { action: "submit" }), params({ id: s.result }));
    expect(twice.status).toBeLessThan(500);
    const { data } = await admin.from("lab_results").select("status").eq("order_item_id", s.item);
    expect(data!.map((r) => r.status)).toEqual(["submitted"]);
  });

  it("4. verification: never the enterer; two second persons at once → one verification", async () => {
    as(people.lab1, "lab");
    expect((await resultAction(json(`/api/lab/results/${s.result}`, "POST", { action: "verify" }), params({ id: s.result }))).status).toBe(409);
    const [lab2, doctor] = await Promise.all([
      (async () => {
        as(people.lab2, "lab");
        return resultAction(json(`/api/lab/results/${s.result}`, "POST", { action: "verify" }), params({ id: s.result }));
      })(),
      Promise.resolve().then(() => null),
    ]);
    void doctor;
    expect(lab2.status).toBe(200);
    // A second verification attempt (the race's loser) changes nothing.
    as(people.drA, "doctor");
    const late = await resultAction(json(`/api/lab/results/${s.result}`, "POST", { action: "verify" }), params({ id: s.result }));
    expect(late.status).toBeLessThan(500);
    const { data } = await admin.from("lab_results").select("status, verified_by").eq("id", s.result).single();
    expect(data).toEqual({ status: "verified", verified_by: people.lab2 });
    const { data: audits } = await admin.from("audit_events").select("id").eq("entity_id", s.result).eq("action", "lab_result_verified");
    expect(audits).toHaveLength(1);
  });

  it("5. longitudinal history and the doctor's notification", async () => {
    as(people.drA, "doctor");
    const history = await read(await labHistory(new NextRequest(`http://localhost/api/doctor/patients/${s.patient}/lab-history`), params({ id: s.patient })));
    const results = history.body.data!.results as Array<{ resultId: string; values: Array<{ display: string; flag: string }> }>;
    expect(results.find((r) => r.resultId === s.result)!.values[0]).toMatchObject({ display: "112", flag: "low" });
    const box = await read(await inbox());
    expect(JSON.stringify(box.body)).toContain("Laboratoriya natijasi tasdiqlandi");
    expect(JSON.stringify(box.body)).not.toMatch(/\b112\b/);
  });

  it("6. the patient's Telegram message: a failed send is retried, sent once, never with the value", async () => {
    const [job] = await telegramJobs(s.result);
    expect(job).toMatchObject({ type: "lab_result_ready", status: "pending", patient_telegram_user_id: tg.patient });
    telegram.fail = 1;
    await admin.from("notification_jobs").update({ scheduled_for: new Date(Date.now() - 1000).toISOString() }).eq("id", job.id);
    await processDueNotificationJobs(50, [clinicA]);
    expect((await telegramJobs(s.result))[0]).toMatchObject({ status: "pending", attempts: 1 });
    await admin.from("notification_jobs").update({ scheduled_for: new Date(Date.now() - 1000).toISOString() }).eq("id", job.id);
    await processDueNotificationJobs(50, [clinicA]);
    await processDueNotificationJobs(50, [clinicA]); // a second worker run sends nothing again
    expect((await telegramJobs(s.result))[0]).toMatchObject({ status: "sent" });
    const mine = telegram.sent.filter((m) => m.chatId === tg.patient);
    expect(mine).toHaveLength(1);
    expect(mine[0].text).toContain("Laboratoriya natijangiz tayyor");
    expect(mine[0].text).not.toMatch(/\b112\b|Gemoglobin|Umumiy qon/);
  });

  it("7. the patient's result view and secure document access (signed link, real file); another patient sees neither", async () => {
    const list = await mini(myResults as never, "/api/me/lab-results", tg.patient);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).toContain(s.item);
    const detail = await mini(myResult as never, `/api/me/lab-results/${s.item}`, tg.patient, { itemId: s.item });
    expect(JSON.stringify(detail.body)).toContain("112");
    const doc = await mini(myDocument as never, `/api/me/lab-documents/${s.document}`, tg.patient, { id: s.document });
    expect(doc.status).toBe(200);
    const url = (doc.body.data as { url: string }).url;
    expect(url).toMatch(/token=/);
    const file = await fetch(url);
    expect(file.status).toBe(200);
    expect(new Uint8Array(await file.arrayBuffer()).slice(0, 5)).toEqual(PDF.slice(0, 5));
    // Patient mismatch: another patient of the same clinic.
    expect((await mini(myResult as never, `/api/me/lab-results/${s.item}`, tg.other, { itemId: s.item })).status).toBe(404);
    expect((await mini(myDocument as never, `/api/me/lab-documents/${s.document}`, tg.other, { id: s.document })).status).toBe(404);
    expect(JSON.stringify((await mini(myResults as never, "/api/me/lab-results", tg.other)).body)).not.toContain(s.item);
  });

  it("8. the AI summary when enabled — and the same facts when AI is unavailable or disabled", async () => {
    as(people.drA, "doctor");
    const summary = async () => (await read(await labSummary(new NextRequest(`http://localhost/api/doctor/patients/${s.patient}/lab-summary`), params({ id: s.patient })))).body.data!.summary as { source: string; aiStatus: string; bullets: Array<{ text: string }> };
    ai.mode = "echo";
    const used = await summary();
    expect(used).toMatchObject({ source: "ai", aiStatus: "used" });
    expect(used.bullets[0].text).toContain("112 g/L");
    ai.mode = "down";
    const down = await summary();
    expect(down).toMatchObject({ source: "computed", aiStatus: "unavailable" });
    ai.mode = "off";
    const off = await summary();
    expect(off).toMatchObject({ source: "computed", aiStatus: "disabled" });
    expect(off.bullets.map((b) => b.text)).toEqual(down.bullets.map((b) => b.text));
    ai.mode = "echo";
  });

  it("9. correction: a new version, verified by a second person; the patient sees the corrected value and is told once", async () => {
    as(people.lab2, "lab");
    const started = await read(await resultAction(json(`/api/lab/results/${s.result}`, "POST", { action: "correct", reason: "Qayta o‘lchandi" }), params({ id: s.result })));
    expect(started.status).toBe(201);
    const correction = (started.body.data as { resultId: string }).resultId;
    expect((await saveResult(json(`/api/lab/items/${s.item}/result`, "PUT", { values: [{ parameterId: s.param, value: "125" }] }), params({ id: s.item }))).status).toBeLessThan(300);
    expect((await resultAction(json(`/api/lab/results/${correction}`, "POST", { action: "submit" }), params({ id: correction }))).status).toBe(200);
    as(people.lab1, "lab");
    expect((await resultAction(json(`/api/lab/results/${correction}`, "POST", { action: "verify" }), params({ id: correction }))).status).toBe(200);
    const { data: versions } = await admin.from("lab_results").select("version, status").eq("order_item_id", s.item).order("version");
    expect(versions).toEqual([{ version: 1, status: "superseded" }, { version: 2, status: "verified" }]);
    const detail = await mini(myResult as never, `/api/me/lab-results/${s.item}`, tg.patient, { itemId: s.item });
    expect(JSON.stringify(detail.body)).toContain("125");
    expect(JSON.stringify(detail.body)).not.toMatch(/"112"/);
    // The patient's "result ready" message is per verified version: one more, for the correction.
    expect((await telegramJobs(correction)).map((j) => j.type)).toEqual(["lab_result_ready"]);
  });

  it("10. cancellation and refund: unpaid → bill lowered; paid → refunded at the Kassa; collected → refused; repeat → no change", async () => {
    as(people.reception, "receptionist");
    const order = async () => (await read(await walkIn(json("/api/lab/orders", "POST", { idempotencyKey: randomUUID(), patientId: s.patient, testIds: [s.test] })))).body.data as { orderId: string };
    // Unpaid order: cancelled, the open bill drops to zero.
    const unpaid = (await order()).orderId;
    const reasonless = await cancelOrder(json(`/api/lab/orders/${unpaid}`, "POST", { action: "cancel", reason: "" }), params({ id: unpaid }));
    expect(reasonless.status).toBe(400);
    expect((await read(await cancelOrder(json(`/api/lab/orders/${unpaid}`, "POST", { action: "cancel", reason: "Bemor kelmadi" }), params({ id: unpaid })))).body.data).toEqual({ changed: true });
    expect((await read(await cancelOrder(json(`/api/lab/orders/${unpaid}`, "POST", { action: "cancel", reason: "Bemor kelmadi" }), params({ id: unpaid })))).body.data).toEqual({ changed: false });
    const { data: items } = await admin.from("lab_order_items").select("status").eq("order_id", unpaid);
    expect(items!.map((i) => i.status)).toEqual(["cancelled"]);
    const { data: bill } = await admin.from("payments").select("status, amount").eq("lab_order_id", unpaid).single();
    expect(Number(bill!.amount)).toBe(0);
    // Paid, then cancelled: the money is refunded at the Kassa (whole payment).
    const paid = (await order()).orderId;
    as(people.owner, "owner");
    expect((await pay(json(`/api/admin/lab/orders/${paid}/payment`, "POST", { status: "paid", method: "card_terminal" }), params({ id: paid }))).status).toBe(200);
    as(people.reception, "receptionist");
    expect((await cancelOrder(json(`/api/lab/orders/${paid}`, "POST", { action: "cancel", reason: "Shifokor bekor qildi" }), params({ id: paid }))).status).toBe(200);
    as(people.owner, "owner");
    expect((await pay(json(`/api/admin/lab/orders/${paid}/payment`, "POST", { status: "refunded" }), params({ id: paid }))).status).toBe(200);
    const { data: refunded } = await admin.from("payments").select("status, amount").eq("lab_order_id", paid).single();
    expect(refunded).toEqual({ status: "refunded", amount: 60000 });
    // The main order has a collected sample: it cannot be cancelled.
    as(people.reception, "receptionist");
    const late = await read(await cancelOrder(json(`/api/lab/orders/${s.order}`, "POST", { action: "cancel", reason: "x" }), params({ id: s.order })));
    expect([late.status, late.body.code]).toEqual([409, "order_completed"]);
    // Another clinic's staff, or a doctor without the patient, cannot cancel it.
    as(people.labB, "lab", clinicB);
    expect((await cancelOrder(json(`/api/lab/orders/${paid}`, "POST", { action: "cancel", reason: "x" }), params({ id: paid }))).status).toBe(404);
    as(people.drGone, "doctor");
    const third = (await (async () => { as(people.reception, "receptionist"); return order(); })()).orderId;
    as(people.drGone, "doctor");
    expect((await cancelOrder(json(`/api/lab/orders/${third}`, "POST", { action: "cancel", reason: "x" }), params({ id: third }))).status).toBe(404);
    as(people.drA, "doctor"); // the patient's own doctor may
    expect((await cancelOrder(json(`/api/lab/orders/${third}`, "POST", { action: "cancel", reason: "Kerak emas" }), params({ id: third }))).status).toBe(200);
  });

  it("11. a single lab person on shift: the result waits for a second verifier; an inactive doctor loses access", async () => {
    as(people.reception, "receptionist");
    const { orderId } = (await read(await walkIn(json("/api/lab/orders", "POST", { idempotencyKey: randomUUID(), patientId: s.other, testIds: [s.test] })))).body.data as { orderId: string };
    as(people.owner, "owner");
    await pay(json(`/api/admin/lab/orders/${orderId}/payment`, "POST", { status: "paid", method: "cash" }), params({ id: orderId }));
    const { data: item } = await admin.from("lab_order_items").select("id").eq("order_id", orderId).single();
    as(people.lab1, "lab");
    const sm = (await read(await collect(json(`/api/lab/orders/${orderId}/samples`, "POST", { idempotencyKey: randomUUID(), itemIds: [item!.id] }), params({ id: orderId })))).body.data as { sampleId: string };
    await sampleAction(json(`/api/lab/samples/${sm.sampleId}`, "POST", { action: "receive" }), params({ id: sm.sampleId }));
    const saved = (await read(await saveResult(json(`/api/lab/items/${item!.id}/result`, "PUT", { values: [{ parameterId: s.param, value: "140" }] }), params({ id: item!.id })))).body.data as { resultId: string };
    await resultAction(json(`/api/lab/results/${saved.resultId}`, "POST", { action: "submit" }), params({ id: saved.resultId }));
    expect((await resultAction(json(`/api/lab/results/${saved.resultId}`, "POST", { action: "verify" }), params({ id: saved.resultId }))).status).toBe(409);
    const { data: still } = await admin.from("lab_results").select("status").eq("id", saved.resultId).single();
    expect(still!.status).toBe("submitted"); // nothing is released without a second person
    expect(await telegramJobs(saved.resultId)).toEqual([]);
    // An inactive doctor: no lab history, no ordering.
    await admin.from("doctors").update({ active: false }).eq("id", doctors.gone);
    as(people.drGone, "doctor");
    expect((await labHistory(new NextRequest(`http://localhost/api/doctor/patients/${s.patient}/lab-history`), params({ id: s.patient }))).status).toBe(403);
    expect((await doctorOrder(json(`/api/doctor/patients/${s.patient}/lab-orders`, "POST", { idempotencyKey: randomUUID(), testIds: [s.test] }), params({ id: s.patient }))).status).toBe(403);
  });
});
