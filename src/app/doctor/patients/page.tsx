"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Users } from "lucide-react";
import { PageHeader, Card, ABadge, ATable, AEmpty, AError, AInput, LoadingRow } from "@/components/admin/ui";
import { adminApi, AdminApiError, formatDateTime, REFERRAL_STATUS_LABELS, REFERRAL_STATUS_TONES } from "@/lib/admin/client";

type PatientRow = {
  id: string;
  fullName: string | null;
  phone: string | null;
  relationship: "own" | "referred";
  lastVisitAt: string | null;
  referral: { id: string; status: string; referringDoctorName: string | null } | null;
};

/**
 * The doctor's own patients and those actively referred to them. The server
 * decides who is listed; this page only searches and links.
 */
export default function DoctorPatientsPage() {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<PatientRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notLinked, setNotLinked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      adminApi
        .get<{ patients: PatientRow[] }>(`/api/doctor/patients?q=${encodeURIComponent(query.trim())}`)
        .then((res) => {
          if (cancelled) return;
          setRows(res.patients);
          setError(null);
        })
        .catch((e) => {
          if (cancelled) return;
          setRows([]);
          if (e instanceof AdminApiError && e.code === "doctor_not_linked") setNotLinked(true);
          else setError(e instanceof AdminApiError ? e.message : "Bemorlarni yuklab bo‘lmadi");
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  return (
    <div>
      <PageHeader title="Bemorlarim" subtitle="Siz ko‘rgan bemorlar va sizga yo‘llangan bemorlar" />
      {error && <AError message={error} />}
      <div className="mb-4 max-w-md">
        <AInput value={query} onChange={setQuery} placeholder="Ism yoki telefon bo‘yicha qidirish" aria-label="Bemorni qidirish" />
      </div>

      {notLinked ? (
        <Card>
          <AEmpty title="Shifokor hisobi ulanmagan" subtitle="Admin panelda shifokor kartasiga profilingizni bog‘lang." icon={<Users className="h-6 w-6" />} />
        </Card>
      ) : rows === null ? (
        <Card>
          <LoadingRow />
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <AEmpty
            title={query.trim() ? "Hech narsa topilmadi" : "Hali bemorlaringiz yo‘q"}
            subtitle={query.trim() ? "Boshqa ism yoki telefon raqamini sinab ko‘ring" : "Qabul qilgan yoki sizga yo‘llangan bemorlar shu yerda ko‘rinadi"}
            icon={<Users className="h-6 w-6" />}
          />
        </Card>
      ) : (
        <ATable headers={["Bemor", "Telefon", "Oxirgi qabul", "Holat"]}>
          {rows.map((p) => (
            <tr key={p.id} className="hover:bg-sand">
              <td className="px-4 py-3">
                <Link href={`/doctor/patients/${p.id}`} className="font-medium text-foreground hover:text-pine hover:underline">
                  {p.fullName ?? "—"}
                </Link>
              </td>
              <td className="px-4 py-3 text-foreground">{p.phone ?? "—"}</td>
              <td className="px-4 py-3 text-foreground">{p.lastVisitAt ? formatDateTime(p.lastVisitAt) : "—"}</td>
              <td className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  {p.relationship === "own" && <ABadge tone="green">Mening bemorim</ABadge>}
                  {p.referral && (
                    <ABadge tone={REFERRAL_STATUS_TONES[p.referral.status] ?? "blue"}>
                      Yo‘llanma: {REFERRAL_STATUS_LABELS[p.referral.status] ?? p.referral.status}
                    </ABadge>
                  )}
                  {p.referral?.referringDoctorName && <span className="text-xs text-ink-muted">{p.referral.referringDoctorName}</span>}
                </div>
              </td>
            </tr>
          ))}
        </ATable>
      )}
    </div>
  );
}
