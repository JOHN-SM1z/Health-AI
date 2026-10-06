import { createHmac, timingSafeEqual } from "node:crypto";
import {
  fail,
  type CreateOrderOutcome,
  type ExternalOrderRequest,
  type ExternalResult,
  type LabProviderAdapter,
  type ProviderContext,
  type ProviderStatus,
  type ResultOutcome,
  type StatusOutcome,
  type WebhookEvent,
  type WebhookOutcome,
} from "@/lib/labs/providers/types";

/**
 * A fake external laboratory (Phase 15) — proves the abstraction; never
 * available in production (productionReady = false, refused by the registry).
 *
 * It keeps its orders in memory (per server process) and behaves like a
 * provider would, driven by the provider's settings:
 *   requireCredential   refuse calls without the credential ("misconfigured")
 *                       or with "wrong" ("auth")
 *   failCreateTimes     the first N createOrder calls of a request fail as
 *                       network errors ("retryable")…
 *   lostResponse        …after the order was already created (the response
 *                       was lost): the retry must not create a second order
 *   rejectTests         test codes it refuses ("rejected")
 *   completeAfterPolls  status polls before an order is completed (default 1)
 *   invalidStatus       answers status polls with garbage ("invalid_response")
 *   results             per test code: [{ code, value, unit }] it returns
 * Webhooks: JSON { events: [...] } signed with HMAC-SHA256 of the raw body
 * under the credential, in the x-mock-signature header.
 */

type Order = { externalOrderId: string; requestId: string; testCode: string; polls: number; status: ProviderStatus };

const orders = new Map<string, Order>();
const byRequest = new Map<string, string>();
const createCalls = new Map<string, number>();
let sequence = 0;

/** Test helpers: what the fake provider holds, and a clean slate. */
export function mockProviderOrders(): Order[] {
  return [...orders.values()];
}
export function resetMockProvider() {
  orders.clear();
  byRequest.clear();
  createCalls.clear();
}

type MockConfig = {
  requireCredential?: boolean;
  failCreateTimes?: number;
  lostResponse?: boolean;
  rejectTests?: string[];
  completeAfterPolls?: number;
  invalidStatus?: boolean;
  results?: Record<string, Array<{ code: string; value: number | string | boolean; unit?: string | null }>>;
};

const cfg = (ctx: ProviderContext) => ctx.config as MockConfig;

function authenticate(ctx: ProviderContext) {
  if (!cfg(ctx).requireCredential) return null;
  if (!ctx.credential) return fail("misconfigured", "credential_missing");
  if (ctx.credential === "wrong") return fail("auth", "credential_refused");
  return null;
}

export function mockSignature(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

const STATUSES: ReadonlySet<string> = new Set(["received", "in_progress", "completed", "rejected", "cancelled"]);

function readResult(raw: unknown): ExternalResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.externalResultId !== "string" || !r.externalResultId || !Array.isArray(r.values)) return null;
  const values: ExternalResult["values"] = [];
  for (const v of r.values) {
    if (!v || typeof v !== "object") return null;
    const { code, value, unit } = v as Record<string, unknown>;
    if (typeof code !== "string" || !["number", "string", "boolean"].includes(typeof value)) return null;
    values.push({ code, value: value as number | string | boolean, unit: typeof unit === "string" ? unit : null });
  }
  return {
    externalResultId: r.externalResultId,
    performedAt: typeof r.performedAt === "string" ? r.performedAt : null,
    values,
  };
}

export const mockLabProvider: LabProviderAdapter = {
  kind: "mock",
  productionReady: false,

  validateConfig(config) {
    const c = config as MockConfig;
    if (c.failCreateTimes !== undefined && (!Number.isInteger(c.failCreateTimes) || c.failCreateTimes < 0 || c.failCreateTimes > 10)) return "bad_fail_create_times";
    if (c.completeAfterPolls !== undefined && (!Number.isInteger(c.completeAfterPolls) || c.completeAfterPolls < 0 || c.completeAfterPolls > 10)) return "bad_complete_after_polls";
    if (c.rejectTests !== undefined && !Array.isArray(c.rejectTests)) return "bad_reject_tests";
    return null;
  },

  async createOrder(ctx, order: ExternalOrderRequest): Promise<CreateOrderOutcome> {
    const denied = authenticate(ctx);
    if (denied) return denied;
    const c = cfg(ctx);
    const calls = (createCalls.get(order.requestId) ?? 0) + 1;
    createCalls.set(order.requestId, calls);

    // Idempotency: the same request id is the same order.
    const existing = byRequest.get(order.requestId);
    if (calls <= (c.failCreateTimes ?? 0)) {
      if (c.lostResponse && !existing) {
        const externalOrderId = `MOCK-${++sequence}`;
        orders.set(externalOrderId, { externalOrderId, requestId: order.requestId, testCode: order.testCode, polls: 0, status: "received" });
        byRequest.set(order.requestId, externalOrderId);
      }
      return fail("retryable", "network_error");
    }
    if (existing) return { ok: true, externalOrderId: existing, status: orders.get(existing)!.status };
    if ((c.rejectTests ?? []).includes(order.testCode)) return fail("rejected", "test_not_offered");

    const externalOrderId = `MOCK-${++sequence}`;
    orders.set(externalOrderId, { externalOrderId, requestId: order.requestId, testCode: order.testCode, polls: 0, status: "received" });
    byRequest.set(order.requestId, externalOrderId);
    return { ok: true, externalOrderId, status: "received" };
  },

  async getOrderStatus(ctx, externalOrderId): Promise<StatusOutcome> {
    const denied = authenticate(ctx);
    if (denied) return denied;
    if (cfg(ctx).invalidStatus) return fail("invalid_response", "unreadable_status");
    const order = orders.get(externalOrderId);
    if (!order) return fail("rejected", "unknown_order");
    order.polls++;
    if (order.status === "received" || order.status === "in_progress") {
      order.status = order.polls >= (cfg(ctx).completeAfterPolls ?? 1) ? "completed" : "in_progress";
    }
    return { ok: true, status: order.status };
  },

  async getResult(ctx, externalOrderId): Promise<ResultOutcome> {
    const denied = authenticate(ctx);
    if (denied) return denied;
    const order = orders.get(externalOrderId);
    if (!order) return fail("rejected", "unknown_order");
    if (order.status !== "completed") return { ok: true, result: null };
    const values = cfg(ctx).results?.[order.testCode];
    if (!values) return fail("invalid_response", "no_result_configured");
    return { ok: true, result: { externalResultId: `${externalOrderId}-R1`, performedAt: new Date().toISOString(), values } };
  },

  async parseWebhook(ctx, { headers, rawBody }): Promise<WebhookOutcome> {
    // Authenticate before reading anything.
    if (!ctx.credential) return { ok: false, kind: "unauthenticated" };
    const given = headers.get("x-mock-signature") ?? "";
    const expected = mockSignature(ctx.credential, rawBody);
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, kind: "unauthenticated" };

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return { ok: false, kind: "invalid" };
    }
    const list = (body as { events?: unknown })?.events;
    if (!Array.isArray(list) || list.length === 0 || list.length > 50) return { ok: false, kind: "invalid" };
    const events: WebhookEvent[] = [];
    for (const e of list) {
      const ev = e as Record<string, unknown>;
      if (typeof ev?.externalOrderId !== "string" || !ev.externalOrderId) return { ok: false, kind: "invalid" };
      if (ev.type === "status" && typeof ev.status === "string" && STATUSES.has(ev.status)) {
        events.push({ type: "status", externalOrderId: ev.externalOrderId, status: ev.status as ProviderStatus });
      } else if (ev.type === "result") {
        const result = readResult(ev.result);
        if (!result) return { ok: false, kind: "invalid" };
        events.push({ type: "result", externalOrderId: ev.externalOrderId, result });
      } else {
        return { ok: false, kind: "invalid" };
      }
    }
    return { ok: true, events };
  },
};
