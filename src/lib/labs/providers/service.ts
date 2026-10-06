import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { logger } from "@/lib/logger";
import type { ClinicStaff } from "@/lib/labs/guards";
import type { Database, Json } from "@/lib/supabase/database.types";
import { getLabAdapter } from "@/lib/labs/providers/registry";
import { normalizeUnit, readValue } from "@/lib/labs/import/fields";
import type { LabValueType } from "@/lib/labs/values";
import type {
  ExternalOrderRequest,
  ExternalResult,
  LabProviderAdapter,
  ProviderContext,
  ProviderError,
  ProviderStatus,
} from "@/lib/labs/providers/types";

/**
 * The laboratory integration service (Phase 15): Health AI's side of every
 * provider adapter.
 *
 *   send-out    lab staff send a received test to a configured provider
 *               (request_external_lab: one live send-out per test).
 *   worker      claims due send-outs (SKIP LOCKED + lease), sends queued
 *               ones (createOrder, idempotent on the send-out id), polls the
 *               others (getOrderStatus → getResult), retries with back-off,
 *               and maps provider statuses onto the normalized lifecycle.
 *   webhook     a provider pushes status or results; the adapter
 *               authenticates the request before anything is read.
 *   results     provider parameter codes → the clinic's parameters (code
 *               table), values read by each parameter's type, units must
 *               match (never converted). Anything that does not map cleanly
 *               is NOT recorded: the send-out is flagged for review. A clean
 *               result becomes a result version (source external) submitted
 *               for a second person's verification — never verified here.
 *
 * Logs and audit rows carry ids, statuses and codes only — never values,
 * patient data or provider payloads.
 */

type RequestRow = Database["public"]["Tables"]["lab_external_requests"]["Row"];
type ProviderRow = Pick<
  Database["public"]["Tables"]["lab_providers"]["Row"],
  "id" | "clinic_id" | "code" | "name" | "adapter" | "active" | "config" | "credential_ref" | "send_patient_name"
>;

const MAX_ATTEMPTS = 6;
const BACKOFF_SECONDS = [30, 120, 600, 1800, 7200, 21600];
const DEFAULT_POLL_SECONDS = 300;
const REVIEW_HOLD_SECONDS = 86_400;

const SEND_ERRORS: Array<[RegExp, number, string, string]> = [
  [/lab_external_unknown_item/, 404, "Tahlil topilmadi", "not_found"],
  [/lab_external_unknown_provider/, 404, "Tashqi laboratoriya topilmadi yoki faol emas", "provider_not_found"],
  [/lab_external_already_sent/, 409, "Tahlil allaqachon boshqa laboratoriyaga yuborilgan", "already_sent"],
  [/lab_external_imported/, 409, "Import qilingan natijalar yuborilmaydi", "imported_order"],
  [/lab_external_item_not_ready/, 409, "Tahlil namunasi laboratoriyaga qabul qilingandan keyin yuboriladi", "item_not_ready"],
  [/lab_external_has_result/, 409, "Tahlilning natijasi allaqachon bor", "has_result"],
  [/lab_external_unmapped_test/, 409, "Bu laboratoriyada ushbu tahlilning kodi sozlanmagan", "unmapped_test"],
  [/lab_external_forbidden/, 403, "Ruxsat yo‘q", "forbidden"],
];

function sendError(error: { message?: string; code?: string }, what: string): ApiError {
  const known = SEND_ERRORS.find(([p]) => p.test(error.message ?? ""));
  if (known) return new ApiError(known[1], known[2], known[3]);
  logger.error(`lab external: ${what} failed`, { code: error.code });
  return new ApiError(500, "Tashqi laboratoriyaga yuborib bo‘lmadi", "send_failed");
}

const plus = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

function pollSeconds(config: Json): number {
  const v = (config as Record<string, unknown> | null)?.pollSeconds;
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(86_400, Math.floor(v))) : DEFAULT_POLL_SECONDS;
}

function contextOf(p: ProviderRow): ProviderContext {
  return {
    providerId: p.id,
    clinicId: p.clinic_id,
    config: (p.config ?? {}) as Record<string, unknown>,
    // The secret lives in the environment, under a LAB_PROVIDER_… name (CHECK constraint).
    credential: p.credential_ref ? (process.env[p.credential_ref] ?? null) : null,
  };
}

async function loadProvider(providerId: string): Promise<ProviderRow | null> {
  const { data, error } = await createAdminClient()
    .from("lab_providers")
    .select("id, clinic_id, code, name, adapter, active, config, credential_ref, send_patient_name")
    .eq("id", providerId)
    .maybeSingle();
  if (error) throw new Error(`provider lookup failed: ${error.code}`);
  return data;
}

/** Updates a send-out only while it is still in one of `from` (another worker or a webhook may have moved it). */
async function updateRequest(id: string, from: RequestRow["status"][], patch: Database["public"]["Tables"]["lab_external_requests"]["Update"]) {
  const { error } = await createAdminClient().from("lab_external_requests").update(patch).eq("id", id).in("status", from);
  if (error) logger.error("lab external: update failed", { requestId: id, code: error.code });
}

const LIVE: RequestRow["status"][] = ["queued", "sent", "in_progress"];

async function applyError(row: RequestRow, err: ProviderError) {
  if (err.kind === "rejected") {
    await updateRequest(row.id, LIVE, { status: "rejected", last_error_code: err.code, lease_until: null });
  } else if (err.kind === "auth" || err.kind === "misconfigured") {
    // Nothing will change by retrying: staff fix the configuration and send again.
    await updateRequest(row.id, LIVE, { status: "failed", last_error_code: err.code, lease_until: null });
  } else {
    const attempts = row.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await updateRequest(row.id, LIVE, { status: "failed", attempts, last_error_code: err.code, lease_until: null });
    } else {
      await updateRequest(row.id, LIVE, { attempts, last_error_code: err.code, next_attempt_at: plus(BACKOFF_SECONDS[attempts - 1]), lease_until: null });
    }
  }
  logger.warn("lab external: provider call failed", { requestId: row.id, kind: err.kind, code: err.code });
}

async function flagForReview(row: RequestRow, reason: string) {
  await updateRequest(row.id, ["sent", "in_progress"], { status: "in_progress", review_reason: reason, next_attempt_at: plus(REVIEW_HOLD_SECONDS), lease_until: null });
}

/** The order as the provider gets it: the test's provider code, the specimen, minimum patient data. */
async function buildOrder(row: RequestRow, provider: ProviderRow): Promise<ExternalOrderRequest | null> {
  const db = createAdminClient();
  const { data: item } = await db.from("lab_order_items").select("test_id").eq("id", row.order_item_id).single();
  const [{ data: code }, { data: sample }, { data: patient }] = await Promise.all([
    db.from("lab_provider_codes").select("external_code").eq("provider_id", provider.id).eq("kind", "test").eq("internal_id", item!.test_id).maybeSingle(),
    db
      .from("lab_sample_items")
      .select("lab_samples!lab_sample_items_sample_fkey(sample_code, sample_type, collected_at, status)")
      .eq("order_item_id", row.order_item_id),
    db.from("patients").select("sex, date_of_birth, full_name").eq("id", row.patient_id).eq("clinic_id", row.clinic_id).single(),
  ]);
  if (!code) return null;
  const specimen = ((sample ?? []) as unknown as Array<{ lab_samples: { sample_code: string; sample_type: string; collected_at: string; status: string } | null }>)
    .map((s) => s.lab_samples)
    .find((s) => s && s.status !== "rejected");
  return {
    requestId: row.id,
    testCode: code.external_code,
    sample: { code: specimen?.sample_code ?? null, type: specimen?.sample_type ?? null, collectedAt: specimen?.collected_at ?? null },
    patient: {
      reference: row.id,
      sex: patient?.sex ?? null,
      dateOfBirth: patient?.date_of_birth ?? null,
      ...(provider.send_patient_name ? { fullName: patient?.full_name ?? null } : {}),
    },
  };
}

/** Provider status → the normalized lifecycle (or the result step). */
async function applyStatus(row: RequestRow, provider: ProviderRow, adapter: LabProviderAdapter, status: ProviderStatus) {
  const ctx = contextOf(provider);
  if (status === "completed") {
    const outcome = await adapter.getResult(ctx, row.external_order_id!);
    if (!outcome.ok) return applyError(row, outcome);
    if (!outcome.result) {
      return updateRequest(row.id, ["sent", "in_progress"], { status: "in_progress", attempts: 0, next_attempt_at: plus(pollSeconds(provider.config)), lease_until: null });
    }
    return applyResult(row, provider, outcome.result);
  }
  if (status === "rejected") return updateRequest(row.id, LIVE, { status: "rejected", last_error_code: "provider_rejected", lease_until: null });
  if (status === "cancelled") {
    return updateRequest(row.id, LIVE, { status: "cancelled", cancelled_at: new Date().toISOString(), last_error_code: "provider_cancelled", lease_until: null });
  }
  return updateRequest(row.id, ["sent", "in_progress"], {
    status: status === "in_progress" ? "in_progress" : row.status === "queued" ? "sent" : row.status,
    attempts: 0,
    last_error_code: null,
    next_attempt_at: plus(pollSeconds(provider.config)),
    lease_until: null,
  });
}

/** A provider result → the clinic's parameters → a result version, or a review flag. */
export async function applyResult(row: RequestRow, provider: ProviderRow, result: ExternalResult): Promise<"recorded" | "review" | "duplicate"> {
  const db = createAdminClient();
  const { data: item } = await db.from("lab_order_items").select("test_id").eq("id", row.order_item_id).single();
  const [{ data: codes }, { data: params }] = await Promise.all([
    db.from("lab_provider_codes").select("internal_id, external_code").eq("provider_id", provider.id).eq("kind", "parameter"),
    db.from("lab_test_parameters").select("id, code, value_type, decimals, choices, unit").eq("test_id", item!.test_id).eq("clinic_id", row.clinic_id),
  ]);
  const paramOf = new Map((params ?? []).map((p) => [p.id, p]));
  const byCode = new Map((codes ?? []).filter((c) => paramOf.has(c.internal_id)).map((c) => [c.external_code, paramOf.get(c.internal_id)!]));

  const values: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const v of result.values) {
    const param = byCode.get(v.code);
    if (!param || seen.has(param.id)) {
      await flagForReview(row, param ? "duplicate_parameter" : "unmapped_parameter");
      return "review";
    }
    seen.add(param.id);
    if (v.unit && normalizeUnit(v.unit) !== normalizeUnit(param.unit)) {
      await flagForReview(row, "unit_mismatch");
      return "review";
    }
    const read = readValue(String(v.value), { code: param.code, valueType: param.value_type as LabValueType, decimals: param.decimals, choices: param.choices, unit: param.unit });
    if (!read.ok) {
      await flagForReview(row, "invalid_value");
      return "review";
    }
    values.push({ parameter_id: param.id, value_numeric: read.value.numeric, value_text: read.value.text, value_boolean: read.value.boolean });
  }

  const { data, error } = await db.rpc("record_external_lab_result", {
    p_clinic_id: row.clinic_id,
    p_request_id: row.id,
    p_external_result_id: result.externalResultId,
    p_values: values as Json,
    p_performed_at: result.performedAt ?? undefined,
  });
  if (error) {
    const reason = /result_conflict/.test(error.message) ? "result_conflict" : /expects a|configured choices|decimal places/.test(error.message) ? "value_rejected" : null;
    if (reason) {
      await flagForReview(row, reason);
      return "review";
    }
    if (/not_awaiting_result/.test(error.message)) return "duplicate";
    logger.error("lab external: recording the result failed", { requestId: row.id, code: error.code });
    await applyError(row, { ok: false, kind: "retryable", code: "record_failed" });
    return "review";
  }
  return data?.[0]?.replayed ? "duplicate" : "recorded";
}

/** One claimed send-out: send it, or poll it. */
async function handle(row: RequestRow) {
  const provider = await loadProvider(row.provider_id);
  const adapter = provider ? getLabAdapter(provider.adapter) : null;
  if (!provider || !adapter || !provider.active) {
    await updateRequest(row.id, LIVE, { status: "failed", last_error_code: "adapter_unavailable", lease_until: null });
    return;
  }
  const ctx = contextOf(provider);

  if (row.status === "queued") {
    const order = await buildOrder(row, provider);
    if (!order) {
      await updateRequest(row.id, LIVE, { status: "failed", last_error_code: "unmapped_test", lease_until: null });
      return;
    }
    const outcome = await adapter.createOrder(ctx, order);
    if (!outcome.ok) return applyError(row, outcome);
    const { error } = await createAdminClient()
      .from("lab_external_requests")
      .update({
        status: outcome.status === "in_progress" ? "in_progress" : "sent",
        external_order_id: outcome.externalOrderId,
        sent_at: new Date().toISOString(),
        attempts: 0,
        last_error_code: null,
        next_attempt_at: plus(pollSeconds(provider.config)),
        lease_until: null,
      })
      .eq("id", row.id)
      .eq("status", "queued");
    if (error) {
      // The provider gave an order id another send-out already holds.
      await updateRequest(row.id, LIVE, { status: "failed", last_error_code: error.code === "23505" ? "duplicate_external_order" : "record_failed", lease_until: null });
    }
    return;
  }

  const outcome = await adapter.getOrderStatus(ctx, row.external_order_id!);
  if (!outcome.ok) return applyError(row, outcome);
  return applyStatus(row, provider, adapter, outcome.status);
}

/** The worker: claims due send-outs and moves each one step. */
export async function processExternalLabRequests(limit = 20): Promise<{ claimed: number; failed: number }> {
  const { data, error } = await createAdminClient().rpc("claim_external_lab_requests", { p_limit: limit });
  if (error) {
    logger.error("lab external: claim failed", { code: error.code });
    return { claimed: 0, failed: 0 };
  }
  let failed = 0;
  for (const row of (data ?? []) as RequestRow[]) {
    try {
      await handle(row);
    } catch (e) {
      failed++;
      logger.error("lab external: handling threw", { requestId: row.id, error: e instanceof Error ? e.message : String(e) });
      await updateRequest(row.id, LIVE, { last_error_code: "worker_error", next_attempt_at: plus(BACKOFF_SECONDS[0]), lease_until: null });
    }
  }
  return { claimed: data?.length ?? 0, failed };
}

/** A provider's push (the provider's submitResult). Authenticated by the adapter first. */
export async function handleProviderWebhook(providerId: string, request: { headers: Headers; rawBody: string }) {
  const provider = await loadProvider(providerId);
  const adapter = provider?.active ? getLabAdapter(provider.adapter) : null;
  if (!provider || !adapter) throw new ApiError(404, "not found", "not_found");
  const parsed = await adapter.parseWebhook(contextOf(provider), request);
  if (!parsed.ok) {
    throw parsed.kind === "unauthenticated" ? new ApiError(401, "unauthenticated", "unauthenticated") : new ApiError(400, "invalid payload", "invalid_payload");
  }
  const counts = { applied: 0, duplicate: 0, review: 0, unknown: 0 };
  for (const event of parsed.events) {
    const { data: row } = await createAdminClient()
      .from("lab_external_requests")
      .select("*")
      .eq("provider_id", provider.id)
      .eq("clinic_id", provider.clinic_id)
      .eq("external_order_id", event.externalOrderId)
      .maybeSingle();
    if (!row) {
      counts.unknown++;
      continue;
    }
    if (event.type === "result") {
      const outcome = row.status === "resulted" && row.external_result_id === event.result.externalResultId ? "duplicate" : await applyResult(row, provider, event.result);
      counts[outcome === "recorded" ? "applied" : outcome]++;
    } else if (LIVE.includes(row.status) && event.status !== "completed") {
      await applyStatus(row, provider, adapter, event.status);
      counts.applied++;
    } else {
      // "completed" without a result: the next poll fetches it.
      await updateRequest(row.id, ["sent", "in_progress"], { next_attempt_at: new Date().toISOString() });
      counts.applied++;
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Lab staff: send out, see status
// ---------------------------------------------------------------------------

export async function sendOutItem(staff: ClinicStaff, itemId: string, providerId: string) {
  const { data, error } = await createAdminClient().rpc("request_external_lab", {
    p_clinic_id: staff.clinicId,
    p_order_item_id: itemId,
    p_provider_id: providerId,
    p_actor: staff.profileId,
  });
  if (error) throw sendError(error, "send out");
  const row = data?.[0];
  if (!row) throw new ApiError(500, "Tashqi laboratoriyaga yuborib bo‘lmadi", "send_failed");
  // Send right away when possible; anything that fails stays queued for the worker.
  if (!row.replayed) {
    try {
      const { data: claimed } = await createAdminClient()
        .from("lab_external_requests")
        .update({ lease_until: plus(120) })
        .eq("id", row.lab_external_request_id)
        .eq("status", "queued")
        .is("lease_until", null)
        .select("*")
        .maybeSingle();
      if (claimed) await handle(claimed);
    } catch (e) {
      logger.warn("lab external: immediate send deferred to the worker", { error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { requestId: row.lab_external_request_id, replayed: row.replayed };
}

/**
 * Lab staff stop a live send-out (sample lost, result held for review…). The
 * provider is not told — no adapter cancels yet — and the lab may then enter
 * the result itself.
 */
export async function cancelSendOut(staff: ClinicStaff, requestId: string) {
  const { data, error } = await createAdminClient()
    .from("lab_external_requests")
    .update({ status: "cancelled", cancelled_at: new Date().toISOString(), cancelled_by: staff.profileId, lease_until: null })
    .eq("id", requestId)
    .eq("clinic_id", staff.clinicId)
    .in("status", LIVE)
    .select("id");
  if (error) throw new ApiError(500, "Bekor qilib bo‘lmadi", "save_failed");
  if (!data?.length) throw new ApiError(409, "Yuborish faol emas (allaqachon yakunlangan yoki bekor qilingan)", "not_live");
  return { status: "cancelled" as const };
}

export type SendOutView = {
  id: string;
  itemId: string;
  providerName: string;
  status: RequestRow["status"];
  externalOrderId: string | null;
  lastErrorCode: string | null;
  reviewReason: string | null;
  attempts: number;
  requestedAt: string;
};

/** Send-out status of the given tests (status only, no values). */
export async function listSendOuts(staff: ClinicStaff, itemIds: string[]): Promise<SendOutView[]> {
  if (!itemIds.length) return [];
  const { data, error } = await createAdminClient()
    .from("lab_external_requests")
    .select("id, order_item_id, status, external_order_id, last_error_code, review_reason, attempts, requested_at, lab_providers!lab_external_requests_provider_fkey(name)")
    .eq("clinic_id", staff.clinicId)
    .in("order_item_id", itemIds.slice(0, 300))
    .order("requested_at", { ascending: false });
  if (error) throw new ApiError(500, "Yuborish holatini yuklab bo‘lmadi", "load_failed");
  return ((data ?? []) as unknown as Array<RequestRow & { lab_providers: { name: string } | null }>).map((r) => ({
    id: r.id,
    itemId: r.order_item_id,
    providerName: r.lab_providers?.name ?? "—",
    status: r.status,
    externalOrderId: r.external_order_id,
    lastErrorCode: r.last_error_code,
    reviewReason: r.review_reason,
    attempts: r.attempts,
    requestedAt: r.requested_at,
  }));
}

/** Active providers and the tests each can take (for the send-out choice). */
export async function listSendOutProviders(staff: ClinicStaff) {
  const db = createAdminClient();
  const { data, error } = await db.from("lab_providers").select("id, name, adapter").eq("clinic_id", staff.clinicId).eq("active", true).order("name");
  if (error) throw new ApiError(500, "Laboratoriyalarni yuklab bo‘lmadi", "load_failed");
  const usable = (data ?? []).filter((p) => getLabAdapter(p.adapter));
  const { data: codes } = usable.length
    ? await db.from("lab_provider_codes").select("provider_id, internal_id").eq("clinic_id", staff.clinicId).eq("kind", "test").in("provider_id", usable.map((p) => p.id))
    : { data: [] };
  return usable.map((p) => ({ id: p.id, name: p.name, testIds: (codes ?? []).filter((c) => c.provider_id === p.id).map((c) => c.internal_id) }));
}

// ---------------------------------------------------------------------------
// Configuration (catalog.configure)
// ---------------------------------------------------------------------------

export type ProviderInput = {
  code: string;
  name: string;
  adapter: string;
  active: boolean;
  config: Record<string, unknown>;
  credentialRef: string | null;
  sendPatientName: boolean;
};

function checkProviderInput(input: Pick<ProviderInput, "adapter" | "config">) {
  const adapter = getLabAdapter(input.adapter);
  if (!adapter) throw new ApiError(400, "Bunday integratsiya adapteri yo‘q", "unknown_adapter");
  const problem = adapter.validateConfig(input.config);
  if (problem) throw new ApiError(400, "Sozlamalar noto‘g‘ri", `bad_config_${problem}`);
  const poll = input.config.pollSeconds;
  if (poll !== undefined && (typeof poll !== "number" || poll < 0 || poll > 86_400)) throw new ApiError(400, "Sozlamalar noto‘g‘ri", "bad_config_poll_seconds");
}

export async function listProviders(staff: ClinicStaff) {
  const db = createAdminClient();
  const { data, error } = await db
    .from("lab_providers")
    .select("id, code, name, adapter, active, config, credential_ref, send_patient_name, lab_provider_codes(kind, internal_id, external_code)")
    .eq("clinic_id", staff.clinicId)
    .order("name");
  if (error) throw new ApiError(500, "Laboratoriyalarni yuklab bo‘lmadi", "load_failed");
  return (data ?? []).map((p) => ({
    id: p.id,
    code: p.code,
    name: p.name,
    adapter: p.adapter,
    adapterAvailable: getLabAdapter(p.adapter) !== null,
    active: p.active,
    config: p.config,
    credentialRef: p.credential_ref,
    // Whether the secret is present — never the secret.
    credentialPresent: p.credential_ref ? Boolean(process.env[p.credential_ref]) : null,
    sendPatientName: p.send_patient_name,
    codes: (p.lab_provider_codes as Array<{ kind: string; internal_id: string; external_code: string }>).map((c) => ({ kind: c.kind, internalId: c.internal_id, externalCode: c.external_code })),
  }));
}

export async function createProvider(staff: ClinicStaff, input: ProviderInput) {
  checkProviderInput(input);
  const { data, error } = await createAdminClient()
    .from("lab_providers")
    .insert({
      clinic_id: staff.clinicId,
      code: input.code,
      name: input.name,
      adapter: input.adapter,
      active: input.active,
      config: input.config as Json,
      credential_ref: input.credentialRef,
      send_patient_name: input.sendPatientName,
      created_by: staff.profileId,
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") throw new ApiError(409, "Bu kod band", "code_taken");
    if (error.code === "23514") throw new ApiError(400, "Ma’lumot noto‘g‘ri", "invalid");
    throw new ApiError(500, "Saqlab bo‘lmadi", "save_failed");
  }
  return { id: data.id };
}

export async function updateProvider(staff: ClinicStaff, id: string, input: Omit<ProviderInput, "code">) {
  checkProviderInput(input);
  const { data, error } = await createAdminClient()
    .from("lab_providers")
    .update({
      name: input.name,
      adapter: input.adapter,
      active: input.active,
      config: input.config as Json,
      credential_ref: input.credentialRef,
      send_patient_name: input.sendPatientName,
    })
    .eq("id", id)
    .eq("clinic_id", staff.clinicId)
    .select("id");
  if (error) throw new ApiError(error.code === "23514" ? 400 : 500, "Saqlab bo‘lmadi", "save_failed");
  if (!data?.length) throw new ApiError(404, "Laboratoriya topilmadi", "provider_not_found");
  return { id };
}

/** Replaces the provider's code table (tests and parameters of this clinic). */
export async function setProviderCodes(staff: ClinicStaff, id: string, codes: Array<{ kind: "test" | "parameter"; internalId: string; externalCode: string }>) {
  const db = createAdminClient();
  const { data: provider } = await db.from("lab_providers").select("id").eq("id", id).eq("clinic_id", staff.clinicId).maybeSingle();
  if (!provider) throw new ApiError(404, "Laboratoriya topilmadi", "provider_not_found");
  // Check every reference first: a bad request never wipes the existing table.
  for (const kind of ["test", "parameter"] as const) {
    const list = codes.filter((c) => c.kind === kind);
    if (new Set(list.map((c) => c.internalId)).size !== list.length || new Set(list.map((c) => c.externalCode)).size !== list.length) {
      throw new ApiError(409, "Kod takrorlangan", "duplicate_code");
    }
    if (!list.length) continue;
    const ids = list.map((c) => c.internalId);
    const { data: found, error: findError } = await db.from(kind === "test" ? "lab_tests" : "lab_test_parameters").select("id").eq("clinic_id", staff.clinicId).in("id", ids);
    if (findError) throw new ApiError(500, "Saqlab bo‘lmadi", "save_failed");
    if ((found ?? []).length !== ids.length) throw new ApiError(400, "Tahlil yoki ko‘rsatkich topilmadi", "unknown_reference");
  }
  const { error: delError } = await db.from("lab_provider_codes").delete().eq("provider_id", id).eq("clinic_id", staff.clinicId);
  if (delError) throw new ApiError(500, "Saqlab bo‘lmadi", "save_failed");
  if (codes.length) {
    const { error } = await db
      .from("lab_provider_codes")
      .insert(codes.map((c) => ({ clinic_id: staff.clinicId, provider_id: id, kind: c.kind, internal_id: c.internalId, external_code: c.externalCode })));
    if (error) {
      if (error.code === "23505") throw new ApiError(409, "Kod takrorlangan", "duplicate_code");
      throw new ApiError(400, "Tahlil yoki ko‘rsatkich topilmadi", "unknown_reference");
    }
  }
  return { count: codes.length };
}
