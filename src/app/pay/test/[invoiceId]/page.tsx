import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { testOnlineProvider } from "@/lib/payments/online/test-provider";
import { TestPayButton } from "./pay-button";

export const dynamic = "force-dynamic";

/**
 * The TEST payment provider's page (local development and E2E only): stands in for Rahmat's checkout until its adapter
 * exists. 404 wherever the test provider is not allowed.
 */
export default async function TestPaymentPage({ params }: { params: Promise<{ invoiceId: string }> }) {
  if (process.env.ONLINE_PAYMENT_PROVIDER !== "test_online" || !testOnlineProvider.configured()) notFound();
  const { invoiceId } = await params;
  if (!/^[0-9a-f-]{36}$/.test(invoiceId)) notFound();
  const { data: invoice } = await createAdminClient().from("payment_invoices").select("id, amount, currency, status").eq("id", invoiceId).maybeSingle();
  if (!invoice) notFound();
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col gap-4 px-4 py-10">
      <p className="text-xs font-semibold uppercase tracking-widest text-amber-700">Test to‘lov tizimi — haqiqiy pul emas</p>
      <h1 className="text-xl font-semibold">To‘lov</h1>
      <p className="text-3xl font-bold">
        {Number(invoice.amount).toLocaleString("uz-UZ")} {invoice.currency}
      </p>
      <TestPayButton invoiceId={invoice.id} alreadyPaid={invoice.status === "paid"} />
    </main>
  );
}
