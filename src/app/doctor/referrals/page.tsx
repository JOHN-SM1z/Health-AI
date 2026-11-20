"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Send } from "lucide-react";
import { PageHeader, Card, ABadge, AEmpty, AError, AButton, LoadingRow } from "@/components/admin/ui";
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
  patientId: string;
  patientName: string | null;
  reason: string;
  handoffNote: string | null;
  referringDoctor: { id: string; name: string } | null;
  referredToDoctor: { id: string; name: string } | null;
};

const TABS: Array<{ box: Box; label: string }> = [
  { box: "incoming", label: "Menga yo‘llangan bemorlar" },
  { box: "outgoing", label: "Men yo‘llagan bemorlar" },
];

/** A referral that still opens the patient's workspace for the receiving doctor. */
const OPEN = ["pending", "accepted", "in_progress"];

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-ink-muted">{label}</p>
      <div className="text-sm text-foreground">{children}</div>
    </div>
  );
}

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

  const incoming = box === "incoming";

  return (
    <div>
      <PageHeader title="Yo‘llanmalar" subtitle="Sizga yo‘llangan bemorlar va siz hamkasblaringizga yo‘llagan bemorlar" />
      {error && <AError message={error} />}

      <div className="mb-4 flex flex-wrap gap-2" role="tablist">
        {TABS.map((t) => (
          <AButton key={t.box} size="sm" variant={box === t.box ? "primary" : "outline"} onClick={() => setBox(t.box)}>
            {t.label}
          </AButton>
        ))}
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
            title={incoming ? "Sizga yo‘llangan bemor yo‘q" : "Siz hali bemor yo‘llamagansiz"}
            subtitle={
              incoming
                ? "Hamkasblaringiz bemorni sizga yo‘llasa, shu yerda ko‘rinadi. Muddati o‘tgan yoki bekor qilingan yo‘llanmalar ko‘rsatilmaydi."
                : "Yo‘llanma bemor kartasidagi yoki “Bugungi navbat”dagi qabuldan beriladi"
            }
            icon={<Send className="h-6 w-6" />}
          />
        </Card>
      ) : (
        <section aria-label={incoming ? "Menga yo‘llangan bemorlar" : "Men yo‘llagan bemorlar"} className="flex flex-col gap-3">
          {rows.map((r) => (
            <Card key={r.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-display text-base font-bold text-foreground">{r.patientName ?? "—"}</p>
                  <p className="text-sm text-ink-muted">
                    {incoming ? `Yo‘llagan: ${r.referringDoctor?.name ?? "—"}` : `Qabul qiluvchi: ${r.referredToDoctor?.name ?? "—"}`}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <ABadge tone={r.priority === "urgent" ? "red" : "neutral"}>{REFERRAL_PRIORITY_LABELS[r.priority] ?? r.priority}</ABadge>
                  <ABadge tone={REFERRAL_STATUS_TONES[r.status] ?? "gray"}>{REFERRAL_STATUS_LABELS[r.status] ?? r.status}</ABadge>
                </div>
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Detail label="Yo‘llanma sababi">
                  <p className="whitespace-pre-wrap">{r.reason}</p>
                </Detail>
                <Detail label="Shifokor uchun izoh">
                  <p className="whitespace-pre-wrap">{r.handoffNote ?? "—"}</p>
                </Detail>
                <Detail label="Yuborilgan">{formatDateTime(r.createdAt)}</Detail>
                <Detail label="Amal qilish muddati">{formatDateTime(r.expiresAt)}</Detail>
              </div>

              <div className="mt-3 flex flex-wrap gap-3 text-sm">
                <Link href={`/doctor/referrals/${r.id}`} className="font-medium text-pine hover:underline">
                  Yo‘llanmani ochish
                </Link>
                {(!incoming || OPEN.includes(r.status)) && (
                  <Link href={`/doctor/patients/${r.patientId}`} className="font-medium text-pine hover:underline">
                    Bemor kartasi
                  </Link>
                )}
              </div>
            </Card>
          ))}
        </section>
      )}
    </div>
  );
}
