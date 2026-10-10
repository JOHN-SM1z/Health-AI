import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { signTestEvent, testOnlineProvider, TEST_SIGNATURE_HEADER } from "@/lib/payments/online/test-provider";
import { handleOnlinePaymentWebhook } from "@/lib/payments/online/service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ invoiceId: string }> };

/**
 * The TEST provider "paying" an invoice (local development and E2E only — 404 anywhere the test provider is not
 * allowed). It builds the event a real provider would send, signs it, and hands it to the same webhook handler, so the
 * signature check and the settlement are exactly the production path.
 */
export async function POST(_request: NextRequest, ctx: RouteContext) {
  if (process.env.ONLINE_PAYMENT_PROVIDER !== "test_online" || !testOnlineProvider.configured()) {
    return NextResponse.json({ ok: false }, { status: 404 });
  }
  const { invoiceId } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(invoiceId)) return NextResponse.json({ ok: false }, { status: 404 });
  const { data: invoice } = await createAdminClient().from("payment_invoices").select("id, amount, currency, status").eq("id", invoiceId).maybeSingle();
  if (!invoice) return NextResponse.json({ ok: false }, { status: 404 });

  const body = JSON.stringify({ eventId: `test-${randomUUID()}`, invoiceId: invoice.id, amount: Number(invoice.amount), currency: invoice.currency, reference: `T${Date.now()}` });
  const headers = new Headers({ [TEST_SIGNATURE_HEADER]: signTestEvent(body) ?? "" });
  const result = await handleOnlinePaymentWebhook("test_online", body, headers);
  return NextResponse.json({ ok: !!result, outcome: result?.outcome ?? null });
}
