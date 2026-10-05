"use client";

import { useCallback, useEffect, useState } from "react";
import { UserCog } from "lucide-react";
import { PageHeader, Card, ABadge, ATable, AEmpty, AError, AButton, AInput, ASelect, LoadingRow } from "@/components/admin/ui";
import { adminApi, AdminApiError } from "@/lib/admin/client";

type Role = "owner" | "admin" | "manager" | "receptionist" | "doctor" | "lab";
type Member = { profileId: string; fullName: string; email: string | null; role: Role; isSelf: boolean; linkedDoctorName: string | null };

const ROLE_LABELS: Record<Role, string> = {
  owner: "Klinika egasi",
  admin: "Administrator",
  manager: "Menejer",
  receptionist: "Qabulxona",
  doctor: "Shifokor",
  lab: "Laboratoriya",
};
const ASSIGNABLE: Array<{ value: Exclude<Role, "owner">; label: string }> = [
  { value: "receptionist", label: ROLE_LABELS.receptionist },
  { value: "doctor", label: ROLE_LABELS.doctor },
  { value: "lab", label: ROLE_LABELS.lab },
  { value: "manager", label: ROLE_LABELS.manager },
  { value: "admin", label: ROLE_LABELS.admin },
];

/** The clinic owner's staff page: who signs in to this clinic, and in which role. */
export default function StaffPage() {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<Exclude<Role, "owner">>("receptionist");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [handover, setHandover] = useState<{ email: string; password: string | null; role: Role } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await adminApi.get<{ staff: Member[] }>("/api/admin/staff/members");
      setMembers(data.staff);
    } catch (e) {
      setMembers([]);
      setError(e instanceof AdminApiError && e.status === 403 ? "Xodimlarni faqat klinika egasi boshqaradi." : "Xodimlarni yuklab bo‘lmadi");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    if (!email.trim() || !fullName.trim()) return setError("Email va to‘liq ismni kiriting");
    setBusy("add");
    setError(null);
    setCopied(false);
    try {
      const added = await adminApi.post<{ profileId: string; temporaryPassword: string | null }>("/api/admin/staff/members", {
        email: email.trim(),
        fullName: fullName.trim(),
        role,
      });
      setHandover({ email: email.trim().toLowerCase(), password: added.temporaryPassword, role });
      setEmail("");
      setFullName("");
      await load();
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Xodimni qo‘shib bo‘lmadi");
    } finally {
      setBusy(null);
    }
  };

  const changeRole = async (m: Member, next: string) => {
    setBusy(m.profileId);
    setError(null);
    try {
      await adminApi.patch("/api/admin/staff/members", { profileId: m.profileId, role: next });
      await load();
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Rolni o‘zgartirib bo‘lmadi");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (m: Member) => {
    setBusy(m.profileId);
    setError(null);
    try {
      await adminApi.del(`/api/admin/staff/members?profileId=${m.profileId}`);
      setConfirmRemove(null);
      await load();
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Xodimni olib tashlab bo‘lmadi");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <PageHeader title="Xodimlar" subtitle="Klinika paneliga kim va qaysi rolda kira oladi" />
      {error && <AError message={error} />}

      {handover && (
        <Card className="mb-4 flex flex-col gap-2 border-pine/40">
          <p className="text-sm font-bold text-foreground">Xodim qo‘shildi: {handover.email}</p>
          {handover.password ? (
            <>
              <p className="text-sm text-ink-muted">
                Vaqtinchalik parol faqat hozir ko‘rsatiladi. Uni xodimga xavfsiz yo‘l bilan bering — u birinchi kirishdayoq
                «Parolni o‘zgartirish» bo‘limida o‘z parolini qo‘yadi.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <code className="rounded-lg bg-sand px-3 py-2 font-numeric text-sm break-all" data-testid="temporary-password">
                  {handover.password}
                </code>
                <AButton
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void navigator.clipboard?.writeText(handover.password ?? "").then(() => setCopied(true));
                  }}
                >
                  {copied ? "Nusxa olindi" : "Nusxa olish"}
                </AButton>
              </div>
            </>
          ) : (
            <p className="text-sm text-ink-muted">Bu email bilan hisob allaqachon bor — xodim o‘z paroli bilan kiradi.</p>
          )}
          {handover.role === "doctor" && (
            <p className="text-sm text-ink-muted">Shifokor hisobini «Shifokorlar» bo‘limida shifokor yozuviga bog‘lang.</p>
          )}
          <div>
            <AButton size="sm" variant="ghost" onClick={() => setHandover(null)}>
              Yopish
            </AButton>
          </div>
        </Card>
      )}

      {members === null ? (
        <Card>
          <LoadingRow />
        </Card>
      ) : members.length === 0 ? (
        <Card>
          <AEmpty title="Xodimlar yo‘q" subtitle="Quyida birinchi xodimni qo‘shing" icon={<UserCog className="h-6 w-6" />} />
        </Card>
      ) : (
        <ATable headers={["Xodim", "Rol", "Amallar"]}>
          {members.map((m) => {
            const locked = m.role === "owner" || m.isSelf;
            return (
              <tr key={m.profileId} className="hover:bg-sand">
                <td className="px-4 py-3">
                  <p className="font-medium text-foreground">
                    {m.fullName}
                    {m.isSelf && <span className="ml-2 text-xs text-ink-muted">(siz)</span>}
                  </p>
                  <p className="text-xs text-ink-muted break-all">{m.email ?? "—"}</p>
                  {m.role === "doctor" && (
                    <p className="text-xs text-ink-muted">{m.linkedDoctorName ? `Shifokor yozuvi: ${m.linkedDoctorName}` : "Shifokor yozuviga bog‘lanmagan"}</p>
                  )}
                </td>
                <td className="px-4 py-3">
                  {locked ? (
                    <ABadge tone={m.role === "owner" ? "purple" : "neutral"}>{ROLE_LABELS[m.role]}</ABadge>
                  ) : (
                    <div className="w-40">
                      <ASelect
                        value={m.role}
                        onChange={(v) => void changeRole(m, v)}
                        options={ASSIGNABLE}
                        aria-label={`${m.fullName} roli`}
                      />
                    </div>
                  )}
                </td>
                <td className="px-4 py-3">
                  {locked ? (
                    <span className="text-xs text-ink-muted">—</span>
                  ) : confirmRemove === m.profileId ? (
                    <div className="flex flex-wrap gap-1.5">
                      <AButton size="sm" variant="danger" loading={busy === m.profileId} onClick={() => void remove(m)}>
                        Ha, olib tashlash
                      </AButton>
                      <AButton size="sm" variant="outline" onClick={() => setConfirmRemove(null)}>
                        Bekor
                      </AButton>
                    </div>
                  ) : (
                    <AButton size="sm" variant="outline" onClick={() => setConfirmRemove(m.profileId)}>
                      Olib tashlash
                    </AButton>
                  )}
                </td>
              </tr>
            );
          })}
        </ATable>
      )}

      <Card className="mt-4 flex flex-col gap-3">
        <p className="text-sm font-bold text-foreground">Yangi xodim</p>
        <AInput value={fullName} onChange={setFullName} placeholder="To‘liq ism" aria-label="Xodimning to‘liq ismi" />
        <AInput type="email" value={email} onChange={setEmail} placeholder="Kirish uchun email" aria-label="Xodimning emaili" />
        <div className="w-56">
          <ASelect value={role} onChange={(v) => setRole(v as Exclude<Role, "owner">)} options={ASSIGNABLE} aria-label="Yangi xodim roli" />
        </div>
        <div>
          <AButton onClick={() => void add()} loading={busy === "add"}>
            Xodim qo‘shish
          </AButton>
        </div>
      </Card>
    </div>
  );
}
