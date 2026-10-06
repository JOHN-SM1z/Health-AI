import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { localDbAvailable } from "@/test/local-db";

/**
 * Lab result documents (Phase 11) through the real routes, the real database
 * and the real storage API — including direct URL / API attacks: anonymous
 * and signed-in clients going straight to the bucket or the table, public
 * URLs, forged file types, oversized files, other clinics' ids, final
 * results, withdrawn documents.
 */

const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

const session = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/staff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/staff")>();
  return { ...actual, getStaffContext: async () => session.ctx };
});

import { GET as listDocs, POST as uploadDoc } from "./orders/[id]/documents/route";
import { GET as docLink, POST as docAction } from "./documents/[id]/route";
import { POST as resultAction } from "./results/[id]/route";

const describeDb = describe.skipIf(!localDbAvailable());

type Body = { ok: boolean; data?: Record<string, unknown>; code?: string };
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Body });

const PDF = new TextEncoder().encode("%PDF-1.4\n% lab report body\n%%EOF");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

describeDb("lab documents (real database and storage)", () => {
  let admin: SupabaseClient;
  const suffix = Date.now().toString(36);
  const clinicA = randomUUID();
  const clinicB = randomUUID();
  const passwords = { lab: `Pw-${randomUUID()}`, labB: `Pw-${randomUUID()}` };
  const people = { reception: randomUUID(), owner: randomUUID(), doctor: randomUUID(), lab: randomUUID(), reviewer: randomUUID(), labB: randomUUID() };
  let test = "";
  let hgb = "";
  const uploadedPaths: string[] = [];

  const as = (profileId: string, role: string, clinicId = clinicA) => {
    session.ctx = { profileId, clinicId, clinicName: "Docs", clinicTimezone: "Asia/Tashkent", roles: [role], platformAdmin: false };
  };
  const upload = async (orderId: string, file: Blob | string | null, fields: Record<string, string> = { kind: "report" }) => {
    const form = new FormData();
    if (file !== null) form.set("file", file);
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    const res = await read(await uploadDoc(new NextRequest(`http://localhost/api/lab/orders/${orderId}/documents`, { method: "POST", body: form }), { params: Promise.resolve({ id: orderId }) }));
    if (res.status === 201) uploadedPaths.push(`${clinicA}/${res.body.data!.id as string}`);
    return res;
  };
  const list = async (orderId: string) =>
    read(await listDocs(new NextRequest(`http://localhost/api/lab/orders/${orderId}/documents`), { params: Promise.resolve({ id: orderId }) }));
  const link = async (id: string) => read(await docLink(new NextRequest(`http://localhost/api/lab/documents/${id}`), { params: Promise.resolve({ id }) }));
  const withdraw = async (id: string, reason = "Noto‘g‘ri fayl") =>
    read(
      await docAction(new NextRequest(`http://localhost/api/lab/documents/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "withdraw", reason }) }), {
        params: Promise.resolve({ id }),
      }),
    );
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await admin.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  };

  /** An order with a received sample and a draft result (or a later state). */
  async function order(state: "draft" | "submitted" | "verified" = "draft") {
    const { data: patient } = await admin.from("patients").insert({ clinic_id: clinicA, full_name: `Hujjat bemor ${suffix}`, date_of_birth: "1990-01-01" }).select("id").single();
    const o = (await rpc("create_lab_order", { p_clinic_id: clinicA, p_patient_id: patient!.id, p_ordered_by: people.reception, p_source: "walk_in", p_test_ids: [test], p_panel_ids: [] })) as Array<{ lab_order_id: string }>;
    const orderId = o[0].lab_order_id;
    const { data: item } = await admin.from("lab_order_items").select("id").eq("order_id", orderId).single();
    const s = (await rpc("collect_lab_sample", { p_clinic_id: clinicA, p_order_id: orderId, p_item_ids: [item!.id], p_collected_by: people.reception })) as Array<{ lab_sample_id: string }>;
    await rpc("receive_lab_sample", { p_clinic_id: clinicA, p_sample_id: s[0].lab_sample_id, p_received_by: people.lab });
    const r = (await rpc("save_lab_result_draft", { p_clinic_id: clinicA, p_order_item_id: item!.id, p_entered_by: people.lab, p_values: [{ parameter_id: hgb, value_numeric: 130 }] })) as Array<{ lab_result_id: string }>;
    const resultId = r[0].lab_result_id;
    if (state !== "draft") await rpc("submit_lab_result", { p_clinic_id: clinicA, p_result_id: resultId, p_submitted_by: people.lab });
    if (state === "verified") await rpc("verify_lab_result", { p_clinic_id: clinicA, p_result_id: resultId, p_verified_by: people.reviewer });
    return { orderId, resultId };
  }

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    await admin.from("clinics").insert([
      { id: clinicA, name: `Docs A ${suffix}`, slug: `docs-a-${suffix}`, timezone: "Asia/Tashkent" },
      { id: clinicB, name: `Docs B ${suffix}`, slug: `docs-b-${suffix}`, timezone: "Asia/Tashkent" },
    ]);
    for (const [name, id] of Object.entries(people)) {
      const password = (passwords as Record<string, string>)[name] ?? `Pw-${randomUUID()}`;
      const { error } = await admin.auth.admin.createUser({ id, email: `docs-${name}-${suffix}@test.local`, email_confirm: true, password });
      if (error) throw new Error(error.message);
      await admin.from("profiles").insert({ id, full_name: name });
    }
    await admin.from("staff_roles").insert([
      { clinic_id: clinicA, profile_id: people.reception, role: "receptionist" },
      { clinic_id: clinicA, profile_id: people.owner, role: "owner" },
      { clinic_id: clinicA, profile_id: people.doctor, role: "doctor" },
      { clinic_id: clinicA, profile_id: people.lab, role: "lab" },
      { clinic_id: clinicA, profile_id: people.reviewer, role: "lab" },
      { clinic_id: clinicB, profile_id: people.labB, role: "lab" },
    ]);
    const { data: t } = await admin.from("lab_tests").insert({ clinic_id: clinicA, code: `DOC${suffix}`, name: `Hujjat test ${suffix}`, sample_type: "Qon", price: 1000 }).select("id").single();
    test = t!.id;
    const { data: p } = await admin.from("lab_test_parameters").insert({ clinic_id: clinicA, test_id: test, code: "HGB", name: "HGB", value_type: "numeric", unit: "g/L" }).select("id").single();
    hgb = p!.id;
  });

  afterAll(async () => {
    if (!admin) return;
    if (uploadedPaths.length) await admin.storage.from("lab-documents").remove(uploadedPaths);
    await admin.from("clinics").delete().in("id", [clinicA, clinicB]);
    for (const id of Object.values(people)) await admin.auth.admin.deleteUser(id);
  });

  beforeEach(() => as(people.lab, "lab"));

  it("uploads a PDF to a draft result with full provenance; the stored bytes and hash match", async () => {
    const { orderId, resultId } = await order();
    const res = await upload(orderId, new Blob([PDF], { type: "application/octet-stream" }), { kind: "report", resultId });
    expect(res.status).toBe(201);
    const id = res.body.data!.id as string;
    expect(res.body.data).toMatchObject({ mimeType: "application/pdf", sizeBytes: PDF.byteLength });
    const { data: row } = await admin.from("lab_documents").select("clinic_id, order_id, result_id, kind, uploaded_by, storage_path, mime_type, size_bytes, sha256, created_at").eq("id", id).single();
    expect(row).toMatchObject({ clinic_id: clinicA, order_id: orderId, result_id: resultId, kind: "report", uploaded_by: people.lab, storage_path: `${clinicA}/${id}`, mime_type: "application/pdf" });
    const { createHash } = await import("node:crypto");
    expect(row!.sha256).toBe(createHash("sha256").update(PDF).digest("hex"));
    const { data: stored } = await admin.storage.from("lab-documents").download(`${clinicA}/${id}`);
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(PDF);

    // A PNG scan to the order itself (no result), e.g. the imported source page.
    expect((await upload(orderId, new Blob([PNG]), { kind: "import_source" })).status).toBe(201);
    const docs = (await list(orderId)).body.data!.documents as Array<{ id: string; resultId: string | null; resultVersion: number | null; uploadedByName: string }>;
    expect(docs.map((d) => [d.resultId, d.resultVersion, d.uploadedByName])).toEqual([[resultId, 1, "lab"], [null, null, "lab"]]);

    const { data: audit } = await admin.from("audit_events").select("action, actor_id, new_values").eq("entity_id", id);
    expect(audit).toEqual([expect.objectContaining({ action: "lab_document_uploaded", actor_id: people.lab })]);
  });

  it("checks the file type from its bytes, never the declared type or name; enforces the size limits", async () => {
    const { orderId } = await order();
    for (const fake of [
      new File([new TextEncoder().encode("MZ\x90\x00 not a pdf")], "report.pdf", { type: "application/pdf" }),
      new File([new TextEncoder().encode("<html><script>alert(1)</script>")], "scan.png", { type: "image/png" }),
      new File([new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>")], "x.svg", { type: "image/svg+xml" }),
    ]) {
      const res = await upload(orderId, fake);
      expect(res.status, fake.name).toBe(415);
    }
    expect((await upload(orderId, new Blob([]))).status).toBe(400);
    expect((await upload(orderId, new Blob([new Uint8Array(20 * 1024 * 1024 + 1)]))).status).toBe(413);
    expect((await upload(orderId, null)).status).toBe(400);
    expect((await upload(orderId, "%PDF-1.4 as a string field")).status).toBe(400);
    expect((await upload(orderId, new Blob([PDF]), { kind: "virus" })).status).toBe(400);
    const { count } = await admin.from("lab_documents").select("id", { count: "exact", head: true }).eq("order_id", orderId);
    expect(count).toBe(0);
  });

  it("refuses an upload posted from another site", async () => {
    const { orderId } = await order();
    const form = new FormData();
    form.set("file", new Blob([PDF]));
    form.set("kind", "report");
    const res = await read(
      await uploadDoc(
        new NextRequest(`http://localhost/api/lab/orders/${orderId}/documents`, { method: "POST", body: form, headers: { origin: "https://evil.example", host: "localhost" } }),
        { params: Promise.resolve({ id: orderId }) },
      ),
    );
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("cross_site_request");
    const sandboxed = new FormData();
    sandboxed.set("file", new Blob([PDF]));
    sandboxed.set("kind", "report");
    const nullOrigin = await uploadDoc(
      new NextRequest(`http://localhost/api/lab/orders/${orderId}/documents`, { method: "POST", body: sandboxed, headers: { origin: "null", host: "localhost" } }),
      { params: Promise.resolve({ id: orderId }) },
    );
    expect(nullOrigin.status).toBe(403);
    const same = new FormData();
    same.set("file", new Blob([PDF]));
    same.set("kind", "report");
    const ok = await uploadDoc(
      new NextRequest(`http://localhost/api/lab/orders/${orderId}/documents`, { method: "POST", body: same, headers: { origin: "http://localhost", host: "localhost" } }),
      { params: Promise.resolve({ id: orderId }) },
    );
    expect(ok.status).toBe(201);
    uploadedPaths.push(`${clinicA}/${((await ok.json()) as Body).data!.id as string}`);
  });

  it("is for lab staff only", async () => {
    const { orderId } = await order();
    for (const [p, role] of [[people.reception, "receptionist"], [people.owner, "owner"], [people.doctor, "doctor"]] as const) {
      as(p, role);
      expect((await upload(orderId, new Blob([PDF]))).status, role).toBe(403);
      expect((await list(orderId)).status, role).toBe(403);
    }
    session.ctx = null;
    expect((await upload(orderId, new Blob([PDF]))).status).toBe(401);
  });

  it("attaches only to a result of the same order that is not yet final; a draft with documents is not discarded", async () => {
    const a = await order();
    const b = await order();
    expect((await upload(a.orderId, new Blob([PDF]), { kind: "report", resultId: b.resultId })).status).toBe(404);
    const verified = await order("verified");
    const res = await upload(verified.orderId, new Blob([PDF]), { kind: "report", resultId: verified.resultId });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("result_final");
    expect((await upload((await order("submitted")).orderId, new Blob([PDF]), { kind: "report" })).status).toBe(201);

    expect((await upload(a.orderId, new Blob([PDF]), { kind: "report", resultId: a.resultId })).status).toBe(201);
    const discard = await read(
      await resultAction(new NextRequest(`http://localhost/api/lab/results/${a.resultId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "discard" }) }), {
        params: Promise.resolve({ id: a.resultId }),
      }),
    );
    expect(discard.body.code).toBe("draft_has_documents");
  });

  it("delivers files only through a short-lived signed link after the check; withdrawal keeps the file and closes the link", async () => {
    const { orderId, resultId } = await order();
    const id = (await upload(orderId, new Blob([PDF]), { kind: "report", resultId })).body.data!.id as string;
    const res = await link(id);
    expect(res.body.data!.expiresIn).toBe(60);
    const url = res.body.data!.url as string;
    expect(url).toMatch(/\/storage\/v1\/object\/sign\/lab-documents\//);
    expect(await (await fetch(url)).text()).toContain("lab report body");
    // Tampering with the signed path is refused.
    expect((await fetch(url.replace(id, randomUUID()))).status).toBeGreaterThanOrEqual(400);

    expect((await withdraw(id, "")).status).toBe(400);
    expect((await withdraw(id)).body.data).toEqual({ changed: true });
    expect((await withdraw(id)).status).toBe(409);
    expect((await link(id)).status).toBe(404);
    const { data: row } = await admin.from("lab_documents").select("withdrawn_by, withdraw_reason").eq("id", id).single();
    expect(row).toEqual({ withdrawn_by: people.lab, withdraw_reason: "Noto‘g‘ri fayl" });
    const { data: still } = await admin.storage.from("lab-documents").download(`${clinicA}/${id}`);
    expect(still).not.toBeNull(); // retained
    const { data: audit } = await admin.from("audit_events").select("action, actor_id, new_values").eq("entity_id", id).order("created_at");
    expect(audit!.map((a) => [a.action, a.actor_id])).toEqual([
      ["lab_document_uploaded", people.lab],
      ["lab_document_viewed", people.lab],
      ["lab_document_withdrawn", people.lab],
    ]);
    expect(JSON.stringify(audit)).not.toContain("Noto‘g‘ri");
  });

  it("another clinic's staff reach none of it through the API", async () => {
    const { orderId, resultId } = await order();
    const id = (await upload(orderId, new Blob([PDF]), { kind: "report", resultId })).body.data!.id as string;
    as(people.labB, "lab", clinicB);
    expect((await list(orderId)).status).toBe(404);
    expect((await upload(orderId, new Blob([PDF]))).status).toBe(404);
    expect((await link(id)).status).toBe(404);
    expect((await withdraw(id)).status).toBe(404);
    for (const bad of ["..%2F..%2Fetc", "not-a-uuid", `${clinicA}/${id}`]) {
      expect((await read(await docLink(new NextRequest("http://localhost"), { params: Promise.resolve({ id: bad }) }))).status).toBe(404);
    }
  });

  it("direct attacks on the bucket and the table fail: anonymous, signed-in staff, public URLs", async () => {
    const { orderId, resultId } = await order();
    const id = (await upload(orderId, new Blob([PDF]), { kind: "report", resultId })).body.data!.id as string;
    const path = `${clinicA}/${id}`;

    const anon = createClient(URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const signedIn = createClient(URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error: signInError } = await signedIn.auth.signInWithPassword({ email: `docs-lab-${suffix}@test.local`, password: passwords.lab });
    expect(signInError).toBeNull();

    for (const [who, client] of [["anonymous", anon], ["signed-in lab staff", signedIn]] as const) {
      const { data: downloaded } = await client.storage.from("lab-documents").download(path);
      expect(downloaded, `${who} download`).toBeNull();
      const { data: listed } = await client.storage.from("lab-documents").list(clinicA);
      expect(listed ?? [], `${who} list`).toEqual([]);
      const { data: signed } = await client.storage.from("lab-documents").createSignedUrl(path, 3600);
      expect(signed, `${who} sign`).toBeNull();
      const { error: putError } = await client.storage.from("lab-documents").upload(`${clinicA}/${randomUUID()}`, PDF, { contentType: "application/pdf" });
      expect(putError, `${who} upload`).not.toBeNull();
      const { error: removeError, data: removed } = await client.storage.from("lab-documents").remove([path]);
      expect(removeError !== null || (removed ?? []).length === 0, `${who} remove`).toBe(true);
      const { data: rows } = await client.from("lab_documents").select("id, storage_path").eq("id", id);
      expect(rows ?? [], `${who} table`).toEqual([]);
    }
    // The public URL of a private bucket serves nothing.
    const publicUrl = anon.storage.from("lab-documents").getPublicUrl(path).data.publicUrl;
    expect((await fetch(publicUrl)).status).toBeGreaterThanOrEqual(400);
    // Another clinic's signed-in lab staff cannot reach it either.
    const other = createClient(URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    await other.auth.signInWithPassword({ email: `docs-labB-${suffix}@test.local`, password: passwords.labB });
    expect((await other.storage.from("lab-documents").download(path)).data).toBeNull();
    // The file is untouched.
    const { data: still } = await admin.storage.from("lab-documents").download(path);
    expect(new Uint8Array(await still!.arrayBuffer())).toEqual(PDF);
  });
});
