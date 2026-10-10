import { notFound } from "next/navigation";
import { HeartPulse } from "lucide-react";
import { getStaffContext, hasAnyRole } from "@/lib/auth/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPayee } from "@/lib/billing/invoices";
import { formatUzs } from "@/lib/billing/status";
import { PrintButton } from "./print-button";

export const metadata = { title: "Hisob-faktura" };

const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("uz-UZ", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—");

/** A printable invoice (browser “Save as PDF”) for the clinic's own subscription invoice; owner only. */
export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getStaffContext();
  if (!ctx?.clinicId || !hasAnyRole(ctx.roles, ["owner"])) notFound();

  const db = createAdminClient();
  const { data: inv } = await db
    .from("subscription_invoices")
    .select("number, amount_uzs, months, status, issued_at, due_at, paid_at, subscription_plans(name), clinics(name, address, city, phone)")
    .eq("id", id)
    .eq("clinic_id", ctx.clinicId)
    .maybeSingle();
  if (!inv) notFound();
  const payee = await getPayee();

  return (
    <div className="mx-auto max-w-2xl bg-white p-8 text-[#10282e] print:p-0">
      <div className="flex items-start justify-between border-b border-hairline pb-6">
        <div className="flex items-center gap-3">
          <span className="brand-tile flex h-10 w-10 items-center justify-center rounded-xl text-white">
            <HeartPulse className="h-5 w-5" />
          </span>
          <div>
            <p className="font-display text-lg font-bold">Health AI</p>
            <p className="text-xs text-ink-muted">Klinikalar uchun boshqaruv tizimi</p>
          </div>
        </div>
        <div className="text-right">
          <p className="font-display text-xl font-bold">Hisob-faktura</p>
          <p className="font-numeric text-sm">{inv.number}</p>
          <p className="text-xs text-ink-muted">{date(inv.issued_at)}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-6 py-6 text-sm">
        <div>
          <p className="font-numeric text-[10px] uppercase tracking-[0.16em] text-ink-muted">To‘lovchi</p>
          <p className="mt-1 font-semibold">{inv.clinics?.name}</p>
          <p className="text-ink-muted">{[inv.clinics?.city, inv.clinics?.address].filter(Boolean).join(", ")}</p>
          <p className="text-ink-muted">{inv.clinics?.phone}</p>
        </div>
        <div>
          <p className="font-numeric text-[10px] uppercase tracking-[0.16em] text-ink-muted">Oluvchi</p>
          <p className="mt-1 font-semibold">{payee.legalName || "—"}</p>
          <p>STIR: {payee.tin || "—"}</p>
          <p>Bank: {payee.bankName || "—"}</p>
          <p>H/r: {payee.bankAccount || "—"}</p>
          <p>MFO: {payee.mfo || "—"}</p>
        </div>
      </div>

      <table className="w-full text-sm">
        <thead>
          <tr className="border-y border-hairline text-left text-xs text-ink-muted">
            <th className="py-2">Xizmat</th>
            <th className="py-2">Muddat</th>
            <th className="py-2 text-right">Summa</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-hairline">
            <td className="py-3">Health AI obunasi — “{inv.subscription_plans?.name}” tarifi</td>
            <td className="py-3">{inv.months} oy</td>
            <td className="font-numeric py-3 text-right">{formatUzs(inv.amount_uzs)}</td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <td className="pt-3 font-semibold" colSpan={2}>
              Jami to‘lov
            </td>
            <td className="font-numeric pt-3 text-right text-lg font-bold">{formatUzs(inv.amount_uzs)}</td>
          </tr>
        </tfoot>
      </table>

      <div className="mt-6 rounded-xl bg-sand p-4 text-sm">
        <p>
          <span className="font-semibold">To‘lov maqsadi:</span> Health AI obunasi, hisob-faktura {inv.number}
        </p>
        <p>
          <span className="font-semibold">To‘lov muddati:</span> {date(inv.due_at)}
        </p>
        <p className="mt-1">
          <span className="font-semibold">Holat:</span> {inv.status === "paid" ? `To‘langan (${date(inv.paid_at)})` : inv.status === "void" ? "Bekor qilingan" : "To‘lanmagan"}
        </p>
      </div>
      <div className="mt-6 print:hidden">
        <PrintButton />
      </div>
    </div>
  );
}
