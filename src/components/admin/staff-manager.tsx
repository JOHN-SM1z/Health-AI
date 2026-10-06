"use client";

import { useEffect, useState } from "react";
import { PageHeader, Card, ABadge, ATable, AEmpty, AError, AButton, AInput, ASelect, AModal } from "@/components/admin/ui";
import { UserRoundPlus } from "lucide-react";
import { adminApi, AdminApiError } from "@/lib/admin/client";

type StaffMember = {
  profileId: string;
  fullName: string;
  role: "owner" | "admin" | "manager" | "doctor" | "receptionist";
};

const ROLE_LABELS: Record<StaffMember["role"], string> = {
  owner: "Egasi",
  admin: "Administrator",
  manager: "Menejer",
  doctor: "Shifokor",
  receptionist: "Qabulxona",
};

const ROLE_OPTIONS = (Object.keys(ROLE_LABELS) as StaffMember["role"][]).map((r) => ({
  value: r,
  label: ROLE_LABELS[r],
}));

export function StaffManager() {
  const [staff, setStaff] = useState<StaffMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);

  const load = () => {
    adminApi
      .get<{ staff: StaffMember[] }>("/api/admin/staff")
      .then((d) => setStaff(d.staff))
      .catch((e) => setError(e instanceof AdminApiError ? e.message : "Xodimlarni yuklab bo‘lmadi"));
  };

  useEffect(() => {
    load();
  }, []);

  const changeRole = async (member: StaffMember, role: StaffMember["role"]) => {
    if (role === member.role) return;
    if (!confirm(`${member.fullName} roli "${ROLE_LABELS[role]}" ga o‘zgaradi. Davom etamizmi?`)) return;
    setBusyId(member.profileId);
    setError(null);
    try {
      await adminApi.patch("/api/admin/staff", { profileId: member.profileId, role });
      setNotice(`${member.fullName}: rol yangilandi`);
      load();
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Rolni o‘zgartirib bo‘lmadi");
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (member: StaffMember) => {
    if (!confirm(`${member.fullName} klinika panelidan olib tashlanadi. Davom etamizmi?`)) return;
    setBusyId(member.profileId);
    setError(null);
    try {
      await adminApi.del(`/api/admin/staff?profileId=${member.profileId}`);
      setNotice(`${member.fullName} olib tashlandi`);
      load();
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "O‘chirib bo‘lmadi");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <PageHeader
        title="Xodimlar"
        subtitle="Rollarni boshqarish — faqat klinika egasi"
        action={
          <AButton size="md" onClick={() => setAddOpen(true)}>
            <UserRoundPlus className="mr-1.5 h-4 w-4" />
            Xodim qo‘shish
          </AButton>
        }
      />

      {error && <AError message={error} />}
      {notice && (
        <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-pine/25 bg-pine-tint px-4 py-3 text-sm font-medium text-pine-deep">
          <span aria-hidden>✓</span>
          <span>{notice}</span>
        </div>
      )}

      {staff === null ? (
        <Card>
          <p className="py-6 text-center text-sm text-ink-muted">Yuklanmoqda…</p>
        </Card>
      ) : staff.length === 0 ? (
        <Card>
          <AEmpty title="Xodimlar yo‘q" subtitle="Birinchi xodimni qo‘shing" icon={<UserRoundPlus className="h-6 w-6" />} />
        </Card>
      ) : (
        <ATable headers={["Ism", "Rol", "Amallar"]}>
          {staff.map((m) => (
            <tr key={m.profileId} className="hover:bg-sand">
              <td className="px-4 py-3 font-medium text-foreground">{m.fullName}</td>
              <td className="px-4 py-3">
                <ABadge tone={m.role === "owner" ? "pine" : m.role === "doctor" ? "blue" : "gray"}>
                  {ROLE_LABELS[m.role]}
                </ABadge>
              </td>
              <td className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <select
                    value={m.role}
                    disabled={busyId === m.profileId}
                    onChange={(e) => void changeRole(m, e.target.value as StaffMember["role"])}
                    aria-label={`${m.fullName} roli`}
                    className="rounded-lg border border-hairline bg-surface px-2.5 py-1.5 text-xs font-medium text-foreground focus:border-pine"
                  >
                    {ROLE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <AButton size="sm" variant="danger" loading={busyId === m.profileId} onClick={() => void remove(m)}>
                    Olib tashlash
                  </AButton>
                </div>
              </td>
            </tr>
          ))}
        </ATable>
      )}

      {addOpen && (
        <AddStaffModal
          onClose={() => setAddOpen(false)}
          onCreated={() => {
            setAddOpen(false);
            load();
          }}
          onError={setError}
        />
      )}
    </div>
  );
}

function AddStaffModal({ onClose, onCreated, onError }: { onClose: () => void; onCreated: () => void; onError: (m: string) => void }) {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<StaffMember["role"]>("receptionist");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [oneTime, setOneTime] = useState<string | null>(null);

  const valid = fullName.trim().length >= 2 && /.+@.+\..+/.test(email.trim()) && (password === "" || password.length >= 12);

  const submit = async () => {
    if (!valid) return;
    setSubmitting(true);
    onError("");
    try {
      const res = await adminApi.post<{ oneTimePassword: string | null }>("/api/admin/staff", {
        email: email.trim(),
        fullName: fullName.trim(),
        role,
        ...(password !== "" ? { password } : {}),
      });
      if (res.oneTimePassword) {
        setOneTime(res.oneTimePassword);
        setSubmitting(false);
      } else {
        onCreated();
      }
    } catch (e) {
      onError(e instanceof AdminApiError ? e.message : "Xodim qo‘shib bo‘lmadi");
      setSubmitting(false);
    }
  };

  if (oneTime) {
    return (
      <AModal title="Xodim qo‘shildi" onClose={onCreated}>
        <p className="text-sm text-ink-muted">
          Boshlang‘ich parol — uni xodimga yetkazing va shaxsiy kanal orqali yuboring. U bu parol bilan kirgach,
          o‘zgartirishi mumkin.
        </p>
        <div className="rounded-xl border border-hairline bg-sand px-4 py-3">
          <p className="font-numeric select-all text-center text-lg font-bold tracking-wide text-foreground">{oneTime}</p>
        </div>
        <p className="text-xs text-ink-muted">Bu parol boshqa ko‘rsatilmaydi.</p>
      </AModal>
    );
  }

  return (
    <AModal
      title="Xodim qo‘shish"
      onClose={onClose}
      footer={
        <>
          <AButton variant="ghost" size="md" onClick={onClose} disabled={submitting}>
            Bekor qilish
          </AButton>
          <AButton size="md" loading={submitting} disabled={!valid} onClick={() => void submit()}>
            Qo‘shish
          </AButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div>
          <label htmlFor="st-name" className="mb-1 block text-xs font-medium text-ink-muted">
            Ism familiya
          </label>
          <AInput id="st-name" value={fullName} onChange={setFullName} placeholder="Ism familiya" aria-label="Ism familiya" maxLength={120} />
        </div>
        <div>
          <label htmlFor="st-email" className="mb-1 block text-xs font-medium text-ink-muted">
            Email
          </label>
          <AInput id="st-email" value={email} onChange={setEmail} placeholder="xodim@klinika.uz" type="email" aria-label="Email" />
        </div>
        <div>
          <label htmlFor="st-role" className="mb-1 block text-xs font-medium text-ink-muted">
            Rol
          </label>
          <ASelect id="st-role" value={role} onChange={(v) => setRole(v as StaffMember["role"])} options={ROLE_OPTIONS} aria-label="Rol" />
        </div>
        <div>
          <label htmlFor="st-pass" className="mb-1 block text-xs font-medium text-ink-muted">
            Parol (ixtiyoriy — kamida 12 belgi; bo‘sh bo‘lsa avtomatik yaratiladi)
          </label>
          <AInput id="st-pass" value={password} onChange={setPassword} type="password" placeholder="Kamida 12 belgi" aria-label="Parol" maxLength={72} />
        </div>
      </div>
    </AModal>
  );
}
