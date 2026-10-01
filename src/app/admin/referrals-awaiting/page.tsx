"use client";

import { useEffect, useState } from "react";
import { PageHeader, Card, ABadge, ATable, AEmpty, AError, AButton, ATextArea, AModal, LoadingRow } from "@/components/admin/ui";
import { Send } from "lucide-react";
import { adminApi, AdminApiError, formatDateTime } from "@/lib/admin/client";

type Overview = {
  total: number;
  departments: Array<{ id: string; name: string; count: number }>;
  referrals: Array<{
    id: string;
    createdAt: string;
    expiresAt: string;
    priority: "routine" | "urgent";
    patientName: string | null;
    referringDoctor: string | null;
    department: { id: string; name: string };
  }>;
};

/**
 * Department referrals that no doctor can take (the department has none who
 * could): an operational overview for owner/admin/manager. Only metadata —
 * the reason and handoff note are never part of it. Management either gets
 * the department staffed (the referral then reaches its doctors by itself)
 * or withdraws the referral.
 */
export default function ReferralsAwaitingPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [department, setDepartment] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<Overview["referrals"][number] | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setData(await adminApi.get<Overview>("/api/admin/referrals/awaiting-doctor"));
      setError(null);
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Yo‘llanmalarni yuklab bo‘lmadi");
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const revoke = async () => {
    if (!revoking) return;
    setBusy(true);
    try {
      await adminApi.patch(`/api/admin/referrals/${revoking.id}`, { action: "revoke", reason: reason.trim() });
      setRevoking(null);
      setReason("");
      await load();
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Bekor qilib bo‘lmadi");
    } finally {
      setBusy(false);
    }
  };

  const shown = data?.referrals.filter((r) => !department || r.department.id === department) ?? [];

  return (
    <div>
      <PageHeader
        title="Shifokor kutayotgan yo‘llanmalar"
        subtitle="Bo‘limga yo‘llangan, lekin qabul qila oladigan faol shifokori bo‘lmagan yo‘llanmalar"
      />
      {error && <AError message={error} />}
      {data === null && !error ? (
        <Card>
          <LoadingRow />
        </Card>
      ) : data && data.total === 0 ? (
        <Card>
          <AEmpty
            title="Shifokor kutayotgan yo‘llanma yo‘q"
            subtitle="Barcha bo‘lim yo‘llanmalarini qabul qila oladigan shifokor bor"
            icon={<Send className="h-6 w-6" />}
          />
        </Card>
      ) : data ? (
        <>
          <div className="mb-4 flex flex-wrap gap-2">
            <button type="button" onClick={() => setDepartment(null)} aria-pressed={department === null}>
              <ABadge tone={department === null ? "pine" : "gray"}>Barchasi: {data.total}</ABadge>
            </button>
            {data.departments.map((d) => (
              <button key={d.id} type="button" onClick={() => setDepartment(d.id)} aria-pressed={department === d.id}>
                <ABadge tone={department === d.id ? "pine" : "amber"}>
                  {d.name}: {d.count}
                </ABadge>
              </button>
            ))}
          </div>
          <p className="mb-3 text-sm text-ink-muted">
            Bo‘limga faol shifokor qo‘shilsa, yo‘llanma unga o‘zi ko‘rinadi. Aks holda uni bekor qiling — yo‘llagan shifokor ham bu haqda ogohlantirilgan.
          </p>
          <ATable headers={["Bo‘lim", "Bemor", "Yo‘llagan shifokor", "Yuborilgan", "Muddati", "Muhimlik", "Amallar"]}>
            {shown.map((r) => (
              <tr key={r.id} className="hover:bg-sand">
                <td className="px-4 py-3 font-medium text-foreground">{r.department.name}</td>
                <td className="px-4 py-3 text-foreground">{r.patientName ?? "—"}</td>
                <td className="px-4 py-3 text-foreground">{r.referringDoctor ?? "—"}</td>
                <td className="px-4 py-3 text-ink-muted">{formatDateTime(r.createdAt)}</td>
                <td className="px-4 py-3 text-ink-muted">{formatDateTime(r.expiresAt)}</td>
                <td className="px-4 py-3">
                  <ABadge tone={r.priority === "urgent" ? "red" : "neutral"}>{r.priority === "urgent" ? "Shoshilinch" : "Odatiy"}</ABadge>
                </td>
                <td className="px-4 py-3">
                  <AButton size="sm" variant="danger" onClick={() => setRevoking(r)}>
                    Bekor qilish
                  </AButton>
                </td>
              </tr>
            ))}
          </ATable>
        </>
      ) : null}

      {revoking && (
        <AModal title="Yo‘llanmani bekor qilish" onClose={() => (busy ? undefined : setRevoking(null))}>
          <p className="mb-3 text-sm text-ink-muted">
            {revoking.patientName ?? "Bemor"} — {revoking.department.name}. Bekor qilish sababini yozing (yo‘llagan shifokor ko‘radi).
          </p>
          <ATextArea aria-label="Sabab" value={reason} onChange={setReason} rows={3} />
          <div className="mt-4 flex justify-end gap-2">
            <AButton variant="outline" onClick={() => setRevoking(null)} disabled={busy}>
              Yopish
            </AButton>
            <AButton variant="danger" loading={busy} disabled={reason.trim().length < 3} onClick={() => void revoke()}>
              Bekor qilish
            </AButton>
          </div>
        </AModal>
      )}
    </div>
  );
}
