"use client";

import { use, useEffect, useState } from "react";
import { HeartPulse, Printer } from "lucide-react";
import { AButton, AError, LoadingRow } from "@/components/admin/ui";
import { adminApi, AdminApiError } from "@/lib/admin/client";
import { formatUzs } from "@/lib/billing/status";

type PrintInvoice = {
  number: string;
  amountUzs: number;
  months: number;
  status: "issued" | "paid" | "void";
  issuedAt: string;
  dueAt: string;
  paidAt: string | null;
  planName: string;
  clinic: { name: string; address: string; phone: string };
  payee: { legalName: string; tin: string; bankName: string; bankAccount: string; mfo: string };
};

const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("uz-UZ", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—");

/** A printable invoice (browser “Save as PDF”) for the clinic's own subscription invoice; the API admits the owner only. */
export default function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [inv, setInv] = useState<PrintInvoice | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminApi
      .get<PrintInvoice>(`/api/admin/billing/invoice?id=${encodeURIComponent(id)}`)
      .then(setInv)
      .catch((e) => setError(e instanceof AdminApiError ? e.message : "Hisob-fakturani yuklab bo‘lmadi"));
  }, [id]);

  if (error) return <AError message={error} />;
  if (!inv) return <LoadingRow />;

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
          <p className="text-xs text-ink-muted">{date(inv.issuedAt)}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-6 py-6 text-sm">
        <div>
          <p className="font-numeric text-[10px] uppercase tracking-[0.16em] text-ink-muted">To‘lovchi</p>
          <p className="mt-1 font-semibold">{inv.clinic.name}</p>
          <p className="text-ink-muted">{inv.clinic.address}</p>
          <p className="text-ink-muted">{inv.clinic.phone}</p>
        </div>
        <div>
          <p className="font-numeric text-[10px] uppercase tracking-[0.16em] text-ink-muted">Oluvchi</p>
          <p className="mt-1 font-semibold">{inv.payee.legalName || "—"}</p>
          <p>STIR: {inv.payee.tin || "—"}</p>
          <p>Bank: {inv.payee.bankName || "—"}</p>
          <p>H/r: {inv.payee.bankAccount || "—"}</p>
          <p>MFO: {inv.payee.mfo || "—"}</p>
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
            <td className="py-3">Health AI obunasi — “{inv.planName}” tarifi</td>
            <td className="py-3">{inv.months} oy</td>
            <td className="font-numeric py-3 text-right">{formatUzs(inv.amountUzs)}</td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <td className="pt-3 font-semibold" colSpan={2}>
              Jami to‘lov
            </td>
            <td className="font-numeric pt-3 text-right text-lg font-bold">{formatUzs(inv.amountUzs)}</td>
          </tr>
        </tfoot>
      </table>

      <div className="mt-6 rounded-xl bg-sand p-4 text-sm">
        <p>
          <span className="font-semibold">To‘lov maqsadi:</span> Health AI obunasi, hisob-faktura {inv.number}
        </p>
        <p>
          <span className="font-semibold">To‘lov muddati:</span> {date(inv.dueAt)}
        </p>
        <p className="mt-1">
          <span className="font-semibold">Holat:</span> {inv.status === "paid" ? `To‘langan (${date(inv.paidAt)})` : inv.status === "void" ? "Bekor qilingan" : "To‘lanmagan"}
        </p>
      </div>
      <div className="mt-6 print:hidden">
        <AButton onClick={() => window.print()}>
          <Printer className="h-4 w-4" /> Chop etish yoki PDF saqlash
        </AButton>
      </div>
    </div>
  );
}
