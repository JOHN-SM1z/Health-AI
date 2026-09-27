"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Send } from "lucide-react";
import { PageHeader, Card, ABadge, ATable, AEmpty, AError, AButton, LoadingRow } from "@/components/admin/ui";
import {
  adminApi,
  AdminApiError,
  formatDateTime,
  REFERRAL_PRIORITY_LABELS,
  REFERRAL_STATUS_LABELS,
  REFERRAL_STATUS_TONES,
} from "@/lib/admin/client";

type Box = "incoming" | "outgoing";

type Referral = {
  id: string;
  status: string;
  priority: string;
  createdAt: string;
  expiresAt: string;
  patientName: string | null;
  referringDoctor: { id: string; name: string } | null;
  referredToDoctor: { id: string; name: string } | null;
};

export default function DoctorReferralsPage() {
  const [box, setBox] = useState<Box>("incoming");
  const [rows, setRows] = useState<Referral[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notLinked, setNotLinked] = useState(false);

  const load = useCallback(async (which: Box) => {
    setRows(null);
    try {
      const res = await adminApi.get<{ referrals: Referral[] }>(`/api/doctor/referrals?box=${which}`);
      setRows(res.referrals);
      setError(null);
    } catch (e) {
      if (e instanceof AdminApiError && e.code === "doctor_not_linked") setNotLinked(true);
      else setError(e instanceof AdminApiError ? e.message : "Yo‘llanmalarni yuklab bo‘lmadi");
      setRows([]);
    }
  }, []);

  useEffect(() => {
    void load(box);
  }, [box, load]);

  const otherDoctor = (r: Referral) => (box === "incoming" ? r.referringDoctor?.name : r.referredToDoctor?.name) ?? "—";

  return (
    <div>
      <PageHeader title="Yo‘llanmalar" subtitle="Hamkasblaringizga yuborilgan va sizga kelgan yo‘llanmalar" />
      {error && <AError message={error} />}

      <div className="mb-4 flex gap-2">
        <AButton size="sm" variant={box === "incoming" ? "primary" : "outline"} onClick={() => setBox("incoming")}>
          Kelgan
        </AButton>
        <AButton size="sm" variant={box === "outgoing" ? "primary" : "outline"} onClick={() => setBox("outgoing")}>
          Yuborilgan
        </AButton>
      </div>

      {notLinked ? (
        <Card>
          <AEmpty
            title="Shifokor hisobi ulanmagan"
            subtitle="Admin panelda shifokor kartasiga profilingizni bog‘lang."
            icon={<Send className="h-6 w-6" />}
          />
        </Card>
      ) : rows === null ? (
        <Card>
          <LoadingRow />
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <AEmpty
            title={box === "incoming" ? "Sizga yo‘llanma kelmagan" : "Siz hali yo‘llanma bermagansiz"}
            subtitle={
              box === "incoming"
                ? "Hamkasblaringiz bemorni sizga yo‘llasa, shu yerda ko‘rinadi"
                : "Yo‘llanma “Bugungi navbat”dagi boshlangan yoki yakunlangan qabuldan beriladi"
            }
            icon={<Send className="h-6 w-6" />}
          />
        </Card>
      ) : (
        <ATable headers={["Sana", "Bemor", box === "incoming" ? "Yo‘llagan shifokor" : "Qabul qiluvchi shifokor", "Muhimlik", "Holat", "Amal qiladi", ""]}>
          {rows.map((r) => (
            <tr key={r.id} className="hover:bg-sand">
              <td className="px-4 py-3 text-foreground">{formatDateTime(r.createdAt)}</td>
              <td className="px-4 py-3 font-medium text-foreground">{r.patientName ?? "—"}</td>
              <td className="px-4 py-3 text-foreground">{otherDoctor(r)}</td>
              <td className="px-4 py-3">
                <ABadge tone={r.priority === "urgent" ? "red" : "neutral"}>{REFERRAL_PRIORITY_LABELS[r.priority] ?? r.priority}</ABadge>
              </td>
              <td className="px-4 py-3">
                <ABadge tone={REFERRAL_STATUS_TONES[r.status] ?? "gray"}>{REFERRAL_STATUS_LABELS[r.status] ?? r.status}</ABadge>
              </td>
              <td className="px-4 py-3 text-xs text-ink-muted">{formatDateTime(r.expiresAt)}</td>
              <td className="px-4 py-3">
                <Link href={`/doctor/referrals/${r.id}`} className="text-sm font-medium text-pine hover:underline">
                  Ochish
                </Link>
              </td>
            </tr>
          ))}
        </ATable>
      )}
    </div>
  );
}
