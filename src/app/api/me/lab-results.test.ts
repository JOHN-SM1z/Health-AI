import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { localDbAvailable } from "@/test/local-db";

vi.mock("@/lib/telegram/bot", () => ({
  sendTelegramMessage: vi.fn(async () => 4242),
  getTelegramFileUrl: vi.fn(async () => null),
  telegramConfigured: vi.fn(() => true),
}));

import { sendTelegramMessage } from "@/lib/telegram/bot";
import { processDueNotificationJobs, labResultUrl } from "@/lib/notifications/processor";
import { POST as listResults } from "./lab-results/route";
import { POST as getResult } from "./lab-results/[itemId]/route";
import { POST as getDocument } from "./lab-documents/[id]/route";

/**
 * Patient lab results in Telegram and the Mini App (Phase 12), with the real
 * database, real Telegram initData signatures and the real notification
 * worker (Telegram itself mocked): the "result ready" job is queued once per
 * verified version and sent without values; the Mini App shows a patient
 * only their own verified results of the clinic whose bot signed their
 * identity — never another patient's, another clinic's, an unverified or
 * withheld result, or a withdrawn / foreign document.
 */

const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const describeDb = describe.skipIf(!localDbAvailable());

type Body = { ok: boolean; data?: Record<string, unknown>; code?: string };
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Body });

function signInitData(botToken: string, telegramUserId: number, authDate = Math.floor(Date.now() / 1000)) {
  const user = JSON.stringify({ id: telegramUserId, first_name: "Bemor" });
  const fields: Array<[string, string]> = [
    ["auth_date", String(authDate)],
    ["query_id", "AAHdF6IQAAAAAN0XohDhrOrc"],
    ["user", user],
  ];
  const check = fields.map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return `${fields.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}&hash=${hash}`;
}

describeDb("patient lab results (real database, signed initData)", () => {
  let admin: SupabaseClient;
  const suffix = Date.now().toString(36);
  const seed = Math.floor(Math.random() * 1_000_000);
  const clinicA: string = randomUUID();
  const clinicB: string = randomUUID();
  const BOT_A = `${700000 + (seed % 1000)}:AA${suffix}botA${"x".repeat(20)}`;
  const BOT_B = `${800000 + (seed % 1000)}:BB${suffix}botB${"y".repeat(20)}`;
  const tg = { alice: 900_000_000 + seed, bob: 900_100_000 + seed, carol: 900_200_000 + seed, nobody: 900_300_000 + seed };
  const people = { reception: randomUUID(), lab: randomUUID(), reviewer: randomUUID(), labB: randomUUID(), reviewerB: randomUUID() };
  const patients = { alice: "", bob: "", carol: "", noTelegram: "" };
  let test = "";
  let testB = "";
  let hgb = "";
  let hgbB = "";
  const results: Record<string, { itemId: string; resultId: string; orderId: string }> = {};
  const docs: Record<string, string> = {};
  const paths: string[] = [];

  const call = async (handler: (r: NextRequest, c: never) => Promise<Response>, path: string, initData: string | null, clinicId: string | null = clinicA, params?: Record<string, string>) => {
    const url = `http://localhost${path}${clinicId ? `?clinic=${clinicId}` : ""}`;
    const req = new NextRequest(url, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `10.9.${seed % 250}.${Math.floor(Math.random() * 250)}` }, body: JSON.stringify(initData === null ? {} : { initData }) });
    return read(await handler(req, { params: Promise.resolve(params ?? {}) } as never));
  };
  const list = (initData: string | null, clinicId: string | null = clinicA) => call(listResults as never, "/api/me/lab-results", initData, clinicId);
  const detail = (itemId: string, initData: string | null, clinicId: string | null = clinicA) => call(getResult as never, `/api/me/lab-results/${itemId}`, initData, clinicId, { itemId });
  const document = (id: string, initData: string | null, clinicId: string | null = clinicA) => call(getDocument as never, `/api/me/lab-documents/${id}`, initData, clinicId, { id });
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await admin.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  };

  /** A result for `patient` (clinic A unless given), entered and submitted; verified unless told otherwise. */
  async function labResult(patientId: string, value: number, opts: { verify?: boolean; clinicId?: string; doc?: boolean } = {}) {
    const clinicId = opts.clinicId ?? clinicA;
    const b = clinicId === clinicB;
    const o = (await rpc("create_lab_order", { p_clinic_id: clinicId, p_patient_id: patientId, p_ordered_by: b ? people.labB : people.reception, p_source: "walk_in", p_test_ids: [b ? testB : test], p_panel_ids: [] })) as Array<{ lab_order_id: string }>;
    const orderId = o[0].lab_order_id;
    const { data: item } = await admin.from("lab_order_items").select("id").eq("order_id", orderId).single();
    const s = (await rpc("collect_lab_sample", { p_clinic_id: clinicId, p_order_id: orderId, p_item_ids: [item!.id], p_collected_by: b ? people.labB : people.reception })) as Array<{ lab_sample_id: string }>;
    await rpc("receive_lab_sample", { p_clinic_id: clinicId, p_sample_id: s[0].lab_sample_id, p_received_by: b ? people.labB : people.lab });
    const r = (await rpc("save_lab_result_draft", { p_clinic_id: clinicId, p_order_item_id: item!.id, p_entered_by: b ? people.labB : people.lab, p_values: [{ parameter_id: b ? hgbB : hgb, value_numeric: value }] })) as Array<{ lab_result_id: string }>;
    const resultId = r[0].lab_result_id;
    await rpc("submit_lab_result", { p_clinic_id: clinicId, p_result_id: resultId, p_submitted_by: b ? people.labB : people.lab });
    const out = { itemId: item!.id as string, resultId, orderId };
    if (opts.doc) docs[`${resultId}`] = await attach(out, clinicId);
    if (opts.verify !== false) await rpc("verify_lab_result", { p_clinic_id: clinicId, p_result_id: resultId, p_verified_by: b ? people.reviewerB : people.reviewer });
    return out;
  }

  async function attach(r: { resultId: string; orderId: string }, clinicId = clinicA, withdrawn = false) {
    const id = randomUUID();
    const path = `${clinicId}/${id}`;
    const bytes = new TextEncoder().encode(`%PDF-1.4 patient report ${suffix}`);
    await admin.storage.from("lab-documents").upload(path, bytes, { contentType: "application/pdf" });
    paths.push(path);
    const { data: res } = await admin.from("lab_results").select("patient_id").eq("id", r.resultId).single();
    const { error } = await admin.from("lab_documents").insert({
      id, clinic_id: clinicId, patient_id: res!.patient_id, order_id: r.orderId, result_id: r.resultId, kind: "report",
      storage_path: path, mime_type: "application/pdf", size_bytes: bytes.length, sha256: "c".repeat(64), uploaded_by: clinicId === clinicB ? people.labB : people.lab,
    });
    if (error) throw new Error(error.message);
    if (withdrawn) await admin.from("lab_documents").update({ withdrawn_by: people.lab, withdraw_reason: "x", withdrawn_at: new Date().toISOString() }).eq("id", id);
    return id;
  }

  // Other test files run the (global) notification worker in parallel; this
  // suite's jobs are parked a day ahead and made due only right before its
  // own worker run, so no other worker (or its Telegram mock) claims them.
  const park = () =>
    admin.from("notification_jobs").update({ scheduled_for: new Date(Date.now() + 86_400_000).toISOString() }).in("clinic_id", [clinicA, clinicB]).eq("status", "pending");
  const makeDue = () =>
    admin.from("notification_jobs").update({ scheduled_for: new Date(Date.now() - 1000).toISOString() }).in("clinic_id", [clinicA, clinicB]).eq("status", "pending");

  const jobsFor = async (resultId: string) =>
    // The patient's Telegram jobs (staff in-app notifications, Phase 16, are another channel).
    (await admin.from("notification_jobs").select("id, type, status, patient_telegram_user_id, idempotency_key, error").eq("lab_result_id", resultId).eq("channel", "telegram")).data ?? [];

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    await admin.from("clinics").insert([
      { id: clinicA, name: `Patient A ${suffix}`, slug: `patient-a-${suffix}`, timezone: "Asia/Tashkent" },
      { id: clinicB, name: `Patient B ${suffix}`, slug: `patient-b-${suffix}`, timezone: "Asia/Tashkent" },
    ]);
    await admin.from("clinic_telegram_integrations").insert([
      { clinic_id: clinicA, telegram_bot_token: BOT_A, telegram_bot_id: 700000 + seed, telegram_username: `pa_${suffix}_bot`, telegram_bot_name: "A", status: "active", enabled: true, validated_at: new Date().toISOString() },
      { clinic_id: clinicB, telegram_bot_token: BOT_B, telegram_bot_id: 800000 + seed, telegram_username: `pb_${suffix}_bot`, telegram_bot_name: "B", status: "active", enabled: true, validated_at: new Date().toISOString() },
    ]);
    for (const [name, id] of Object.entries(people)) {
      const { error } = await admin.auth.admin.createUser({ id, email: `patient-${name}-${suffix}@test.local`, email_confirm: true, password: `Pw-${randomUUID()}` });
      if (error) throw new Error(error.message);
      await admin.from("profiles").insert({ id, full_name: name });
    }
    await admin.from("staff_roles").insert([
      { clinic_id: clinicA, profile_id: people.reception, role: "receptionist" },
      { clinic_id: clinicA, profile_id: people.lab, role: "lab" },
      { clinic_id: clinicA, profile_id: people.reviewer, role: "lab" },
      { clinic_id: clinicB, profile_id: people.labB, role: "lab" },
      { clinic_id: clinicB, profile_id: people.reviewerB, role: "lab" },
    ]);
    const { data: t } = await admin.from("lab_tests").insert({ clinic_id: clinicA, code: `PT${suffix}`, name: `Umumiy qon tahlili ${suffix}`, sample_type: "Qon", price: 1000 }).select("id").single();
    test = t!.id;
    const { data: p } = await admin.from("lab_test_parameters").insert({ clinic_id: clinicA, test_id: test, code: "HGB", name: "Gemoglobin", value_type: "numeric", unit: "g/L" }).select("id").single();
    hgb = p!.id;
    await admin.from("lab_reference_ranges").insert({ clinic_id: clinicA, parameter_id: hgb, low: 120, high: 160 });
    const { data: tb } = await admin.from("lab_tests").insert({ clinic_id: clinicB, code: `PTB${suffix}`, name: `B tahlil ${suffix}`, sample_type: "Qon", price: 1000 }).select("id").single();
    testB = tb!.id;
    const { data: pb } = await admin.from("lab_test_parameters").insert({ clinic_id: clinicB, test_id: testB, code: "HGB", name: "Gemoglobin", value_type: "numeric", unit: "g/L" }).select("id").single();
    hgbB = pb!.id;

    const patient = async (clinicId: string, name: string, telegram: number | null) =>
      (await admin.from("patients").insert({ clinic_id: clinicId, full_name: `${name} ${suffix}`, date_of_birth: "1985-01-01", telegram_user_id: telegram }).select("id").single()).data!.id as string;
    patients.alice = await patient(clinicA, "Alisa", tg.alice);
    patients.bob = await patient(clinicA, "Bobur", tg.bob);
    patients.carol = await patient(clinicB, "Karima", tg.carol); // another clinic
    patients.noTelegram = await patient(clinicA, "Telegramsiz", null);

    results.aliceOld = await labResult(patients.alice, 118, { doc: true });
    results.alicePending = await labResult(patients.alice, 140, { verify: false, doc: true });
    results.bob = await labResult(patients.bob, 150, { doc: true });
    results.carol = await labResult(patients.carol, 130, { clinicId: clinicB, doc: true });
    results.noTelegram = await labResult(patients.noTelegram, 125);
    docs.aliceWithdrawn = await attach(results.alicePending, clinicA, true);
    await park();
  });

  afterAll(async () => {
    if (!admin) return;
    if (paths.length) await admin.storage.from("lab-documents").remove(paths);
    await admin.from("clinics").delete().in("id", [clinicA, clinicB]);
    for (const id of Object.values(people)) await admin.auth.admin.deleteUser(id);
  });

  beforeEach(async () => {
    await admin.from("app_settings").delete().eq("clinic_id", clinicA).eq("key", "lab");
  });

  it("queues exactly one 'result ready' job per verified version, only for patients with Telegram", async () => {
    expect(await jobsFor(results.aliceOld.resultId)).toEqual([
      expect.objectContaining({ type: "lab_result_ready", status: expect.any(String), patient_telegram_user_id: tg.alice, idempotency_key: `lab_result_ready:${results.aliceOld.resultId}` }),
    ]);
    expect(await jobsFor(results.alicePending.resultId)).toEqual([]); // not verified
    expect(await jobsFor(results.noTelegram.resultId)).toEqual([]); // no Telegram identity
    // A correction is a new version: its own job ("updated" message).
    const c = (await rpc("start_lab_result_correction", { p_clinic_id: clinicA, p_result_id: results.aliceOld.resultId, p_by: people.lab, p_reason: "Qayta tekshirildi" })) as Array<{ lab_result_id: string }>;
    await rpc("save_lab_result_draft", { p_clinic_id: clinicA, p_order_item_id: results.aliceOld.itemId, p_entered_by: people.lab, p_values: [{ parameter_id: hgb, value_numeric: 121 }] });
    await rpc("submit_lab_result", { p_clinic_id: clinicA, p_result_id: c[0].lab_result_id, p_submitted_by: people.lab });
    await rpc("verify_lab_result", { p_clinic_id: clinicA, p_result_id: c[0].lab_result_id, p_verified_by: people.reviewer });
    results.aliceCorrected = { ...results.aliceOld, resultId: c[0].lab_result_id };
    expect(await jobsFor(c[0].lab_result_id)).toHaveLength(1);
    await park();
  });

  it("withholds the notification when the clinic does not release results to patients", async () => {
    await admin.from("app_settings").upsert({ clinic_id: clinicA, key: "lab", value: { releaseToPatient: false } });
    const r = await labResult(patients.bob, 133);
    expect(await jobsFor(r.resultId)).toEqual([]);
  });

  it("the worker sends the date only — no test name, never values — with a button that opens the result", async () => {
    process.env.VERCEL_URL = "clinic.example";
    const send = vi.mocked(sendTelegramMessage);
    send.mockClear();
    await makeDue();
    await processDueNotificationJobs(200, [clinicA, clinicB]);
    const toBob = send.mock.calls.filter(([payload]) => Number(payload.chatId) === tg.bob);
    expect(toBob.length).toBe(1);
    const [payload, clinicId] = toBob[0];
    expect(clinicId).toBe(clinicA);
    expect(payload.text).toContain("Laboratoriya natijangiz tayyor");
    // A notification preview may be read on a locked screen: no test name (Phase 16).
    expect(payload.text).not.toContain("Umumiy qon tahlili");
    expect(payload.text).toMatch(/Sana: \d{2}\.\d{2}\.\d{4}/);
    expect(payload.text).not.toMatch(/150|g\/L|Gemoglobin/);
    const button = (payload.replyMarkup as { inline_keyboard: Array<Array<{ text: string; web_app?: { url: string } }>> }).inline_keyboard[0][0];
    expect(button.text).toBe("📄 Natijani ko‘rish");
    expect(button.web_app!.url).toBe(`https://clinic.example/lab-results/${results.bob.itemId}?clinic=${clinicA}`);
    expect((await jobsFor(results.bob.resultId))[0]).toMatchObject({ status: "sent" });

    // Alice's first version was superseded by its correction: only the correction is announced, as an update.
    const toAlice = send.mock.calls.filter(([p]) => Number(p.chatId) === tg.alice);
    expect(toAlice).toHaveLength(1);
    expect(toAlice[0][0].text).toContain("yangilandi (tuzatilgan)");
    expect((await jobsFor(results.aliceOld.resultId))[0]).toMatchObject({ status: "skipped", error: "result no longer current" });

    // Running again sends nothing twice.
    send.mockClear();
    await processDueNotificationJobs(200, [clinicA, clinicB]);
    expect(send.mock.calls.filter(([p]) => [tg.alice, tg.bob].includes(Number(p.chatId)))).toEqual([]);
    delete process.env.VERCEL_URL;
  });

  it("skips a queued notification if release is switched off or the patient's Telegram changes before sending", async () => {
    const r1 = await labResult(patients.bob, 131);
    await park();
    await admin.from("app_settings").upsert({ clinic_id: clinicA, key: "lab", value: { releaseToPatient: false } });
    await makeDue();
    await processDueNotificationJobs(200, [clinicA, clinicB]);
    expect((await jobsFor(r1.resultId))[0]).toMatchObject({ status: "skipped", error: "results not released to patients" });
  });

  it("deep-links to a t.me Mini App with startapp=lab_<item> when no HTTPS app URL exists", () => {
    // Local and CI app URLs are http://localhost (never an HTTPS web_app URL), so with
    // the Vercel URLs cleared only the t.me link remains.
    const saved = { app: process.env.NEXT_PUBLIC_APP_URL, vercel: process.env.VERCEL_URL, prod: process.env.VERCEL_PROJECT_PRODUCTION_URL };
    delete process.env.VERCEL_URL;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    process.env.NEXT_PUBLIC_APP_URL = "https://t.me/clinic_bot/app";
    try {
      expect(labResultUrl(clinicA, results.bob.itemId)).toEqual({ href: `https://t.me/clinic_bot/app?startapp=lab_${results.bob.itemId}`, webApp: false });
    } finally {
      process.env.NEXT_PUBLIC_APP_URL = saved.app;
      if (saved.vercel) process.env.VERCEL_URL = saved.vercel;
      if (saved.prod) process.env.VERCEL_PROJECT_PRODUCTION_URL = saved.prod;
    }
  });

  it("the correct patient sees only their own verified results — the current version", async () => {
    const alice = signInitData(BOT_A, tg.alice);
    const res = await list(alice);
    expect(res.status).toBe(200);
    const rows = res.body.data!.results as Array<{ itemId: string; corrected: boolean; outsideRange: number }>;
    expect(res.body.data!.released).toBe(true);
    expect(rows).toEqual([expect.objectContaining({ itemId: results.aliceOld.itemId, corrected: true, outsideRange: 0 })]);

    const d = await detail(results.aliceOld.itemId, alice);
    expect(d.status).toBe(200);
    expect(d.body.data!.result).toMatchObject({ corrected: true, values: [{ parameter: "Gemoglobin", value: "121", unit: "g/L", rangeLow: 120, rangeHigh: 160, flag: "normal" }] });
    const { data: audit } = await admin.from("audit_events").select("actor_type, actor_id, patient_id, entity_id").eq("action", "lab_result_viewed").eq("patient_id", patients.alice);
    expect(audit).toEqual([{ actor_type: "patient", actor_id: null, patient_id: patients.alice, entity_id: results.aliceCorrected.resultId }]);
  });

  it("a wrong patient gets nothing — not even with a guessed id", async () => {
    const bob = signInitData(BOT_A, tg.bob);
    const rows = (await list(bob)).body.data!.results as Array<{ itemId: string }>;
    expect(rows.map((r) => r.itemId)).not.toContain(results.aliceOld.itemId);
    expect((await detail(results.aliceOld.itemId, bob)).status).toBe(404);
    expect((await document(docs[results.aliceOld.resultId] ?? randomUUID(), bob)).status).toBe(404);
    // A brand-new Telegram user of the clinic has no results at all.
    expect(((await list(signInitData(BOT_A, tg.nobody))).body.data!.results as unknown[]).length).toBe(0);
  });

  it("a wrong clinic fails: another clinic's bot cannot vouch here, and its patient cannot reach this clinic's results", async () => {
    // Clinic B's signature presented to clinic A.
    expect((await list(signInitData(BOT_B, tg.alice), clinicA)).status).toBe(401);
    // Carol, verified by clinic B, asks for clinic A's and her own result through B.
    const carolB = signInitData(BOT_B, tg.carol);
    expect((await detail(results.aliceOld.itemId, carolB, clinicB)).status).toBe(404);
    expect((await detail(results.carol.itemId, carolB, clinicB)).status).toBe(200);
    // Alice's valid clinic-A identity cannot read clinic B's result.
    expect((await detail(results.carol.itemId, signInitData(BOT_A, tg.alice))).status).toBe(404);
    expect((await document(docs[results.carol.resultId], signInitData(BOT_A, tg.alice))).status).toBe(404);
  });

  it("expired, tampered or missing identity and invalid result ids fail", async () => {
    const expired = signInitData(BOT_A, tg.alice, Math.floor(Date.now() / 1000) - 2 * 24 * 3600);
    expect((await list(expired)).status).toBe(401);
    const tampered = signInitData(BOT_A, tg.alice).replace(/hash=([0-9a-f])/, (_m, c) => `hash=${c === "0" ? "1" : "0"}`);
    expect((await list(tampered)).status).toBe(401);
    expect((await list(null)).status).toBe(401);
    expect((await list("dev")).status).toBe(403);

    const alice = signInitData(BOT_A, tg.alice);
    expect((await detail(results.alicePending.itemId, alice)).status).toBe(404); // awaiting review
    expect((await detail(randomUUID(), alice)).status).toBe(404);
    expect((await detail("../../admin", alice)).status).toBe(404);
  });

  it("withholds everything while the clinic does not release results", async () => {
    await admin.from("app_settings").upsert({ clinic_id: clinicA, key: "lab", value: { releaseToPatient: false } });
    const bob = signInitData(BOT_A, tg.bob);
    expect((await list(bob)).body.data).toEqual({ released: false, results: [] });
    expect((await detail(results.bob.itemId, bob)).status).toBe(404);
    expect((await document(docs[results.bob.resultId], bob)).status).toBe(404);
  });

  it("documents: own verified result only, through a 60-second download link; withdrawn and unverified ones refused", async () => {
    const bob = signInitData(BOT_A, tg.bob);
    const res = await document(docs[results.bob.resultId], bob);
    expect(res.status).toBe(200);
    expect(res.body.data!.expiresIn).toBe(60);
    const file = await fetch(res.body.data!.url as string);
    expect(await file.text()).toContain(`patient report ${suffix}`);
    const { data: audit } = await admin.from("audit_events").select("actor_type, patient_id").eq("action", "lab_document_viewed").eq("entity_id", docs[results.bob.resultId]);
    expect(audit).toEqual([{ actor_type: "patient", patient_id: patients.bob }]);

    const alice = signInitData(BOT_A, tg.alice);
    expect((await document(docs[results.alicePending.resultId], alice)).status).toBe(404); // result in review
    expect((await document(docs.aliceWithdrawn, alice)).status).toBe(404); // withdrawn
    expect((await document(docs[results.bob.resultId], alice)).status).toBe(404); // someone else's
    expect((await document("not-a-uuid", alice)).status).toBe(404);
  });
});
