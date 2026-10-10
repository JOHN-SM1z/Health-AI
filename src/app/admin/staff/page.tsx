"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { UserCog } from "lucide-react";
import { PageHeader, Card, ABadge, ATable, AEmpty, AError, AButton, AInput, ASelect, LoadingRow } from "@/components/admin/ui";
import { adminApi, AdminApiError } from "@/lib/admin/client";
import { isValidLogin, normalizeLogin, suggestLogin } from "@/lib/auth/login";

type Role = "owner" | "admin" | "manager" | "receptionist" | "cashier" | "doctor" | "lab";
type Member = {
  profileId: string;
  fullName: string;
  login: string | null;
  email: string | null;
  role: Role;
  departmentId: string | null;
  departmentName: string | null;
  passwordPending: boolean;
  isSelf: boolean;
  linkedDoctorName: string | null;
};
type Department = { id: string; name: string };

const ROLE_LABELS: Record<Role, string> = {
  owner: "Klinika egasi",
  admin: "Administrator",
  manager: "Menejer",
  receptionist: "Qabulxona",
  cashier: "Kassir",
  doctor: "Shifokor",
  lab: "Laboratoriya",
};
const ASSIGNABLE: Array<{ value: Exclude<Role, "owner">; label: string }> = [
  { value: "receptionist", label: ROLE_LABELS.receptionist },
  { value: "cashier", label: ROLE_LABELS.cashier },
  { value: "doctor", label: ROLE_LABELS.doctor },
  { value: "lab", label: ROLE_LABELS.lab },
  { value: "manager", label: ROLE_LABELS.manager },
  { value: "admin", label: ROLE_LABELS.admin },
];
/** Where each role works once signed in — one login page, each person lands on their own panel. */
const ROLE_PANEL: Record<Role, string> = {
  owner: "Boshqaruv paneli",
  admin: "Boshqaruv paneli",
  manager: "Boshqaruv paneli",
  receptionist: "Qabulxona va navbat",
  cashier: "Kassa",
  doctor: "Shifokor ish joyi",
  lab: "Laboratoriya",
};

type Handover = { fullName: string; login: string; password: string | null; role: Role; reset?: boolean };

/** The clinic owner's staff page: who signs in to this clinic, with which login, in which role and department. */
export default function StaffPage() {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fullName, setFullName] = useState("");
  const [login, setLogin] = useState("");
  const [loginTouched, setLoginTouched] = useState(false);
  const [role, setRole] = useState<Exclude<Role, "owner">>("receptionist");
  const [departmentId, setDepartmentId] = useState("");
  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [handover, setHandover] = useState<Handover | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const [staff, depts] = await Promise.all([
        adminApi.get<{ staff: Member[] }>("/api/admin/staff/members"),
        adminApi.get<{ departments: Department[] }>("/api/admin/departments").catch(() => ({ departments: [] })),
      ]);
      setMembers(staff.staff);
      setDepartments(depts.departments);
    } catch (e) {
      setMembers([]);
      setError(e instanceof AdminApiError && e.status === 403 ? "Xodimlarni faqat klinika egasi boshqaradi." : "Xodimlarni yuklab bo‘lmadi");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const departmentOptions = useMemo(() => [{ value: "", label: "Bo‘limsiz" }, ...departments.map((d) => ({ value: d.id, label: d.name }))], [departments]);
  const shown = useMemo(
    () => (members ?? []).filter((m) => filter === "all" || (filter === "none" ? !m.departmentId : m.departmentId === filter)),
    [members, filter],
  );

  const onName = (v: string) => {
    setFullName(v);
    if (!loginTouched) setLogin(suggestLogin(v));
  };

  const add = async () => {
    const wanted = normalizeLogin(login);
    if (!fullName.trim()) return setError("Xodimning to‘liq ismini kiriting");
    if (!isValidLogin(wanted)) return setError("Login 3–32 belgi: lotin harflari, raqamlar, nuqta, chiziqcha (masalan: dilnoza.qabul)");
    setBusy("add");
    setError(null);
    setCopied(false);
    try {
      const added = await adminApi.post<{ profileId: string; login: string; temporaryPassword: string | null }>("/api/admin/staff/members", {
        login: wanted,
        fullName: fullName.trim(),
        role,
        departmentId: departmentId || null,
      });
      setHandover({ fullName: fullName.trim(), login: added.login, password: added.temporaryPassword, role });
      setFullName("");
      setLogin("");
      setLoginTouched(false);
      await load();
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Xodimni qo‘shib bo‘lmadi");
    } finally {
      setBusy(null);
    }
  };

  const patch = async (m: Member, body: Record<string, unknown>, failure: string) => {
    setBusy(m.profileId);
    setError(null);
    try {
      const result = await adminApi.patch<{ temporaryPassword?: string }>("/api/admin/staff/members", { profileId: m.profileId, ...body });
      await load();
      return result;
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : failure);
      return null;
    } finally {
      setBusy(null);
    }
  };

  const resetPassword = async (m: Member) => {
    setCopied(false);
    const result = await patch(m, { resetPassword: true }, "Parolni tiklab bo‘lmadi");
    if (result?.temporaryPassword) {
      setHandover({ fullName: m.fullName, login: m.login ?? m.email ?? "", password: result.temporaryPassword, role: m.role, reset: true });
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
      <PageHeader title="Xodimlar" subtitle="Har bir xodim bitta login va parol bilan o‘z paneliga kiradi" />
      {error && <AError message={error} />}

      {handover && (
        <Card className="mb-4 flex flex-col gap-2 border-pine/40">
          <p className="text-sm font-bold text-foreground">
            {handover.reset ? "Yangi vaqtinchalik parol" : "Xodim qo‘shildi"}: {handover.fullName}
          </p>
          {handover.password ? (
            <>
              <p className="text-sm text-ink-muted">
                Quyidagilarni xodimga shaxsan bering. Parol faqat hozir ko‘rsatiladi; xodim birinchi kirishda o‘z parolini o‘rnatadi.
              </p>
              <dl className="grid max-w-md grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 rounded-xl bg-sand p-3 text-sm">
                <dt className="text-ink-muted">Kirish manzili</dt>
                <dd className="font-numeric break-all">{typeof window === "undefined" ? "/login" : `${window.location.origin}/login`}</dd>
                <dt className="text-ink-muted">Login</dt>
                <dd className="font-numeric font-semibold" data-testid="handover-login">{handover.login}</dd>
                <dt className="text-ink-muted">Parol</dt>
                <dd className="font-numeric font-semibold break-all" data-testid="temporary-password">{handover.password}</dd>
                <dt className="text-ink-muted">Panel</dt>
                <dd>{ROLE_PANEL[handover.role]}</dd>
              </dl>
              <div>
                <AButton
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const text = `Health AI\nKirish: ${window.location.origin}/login\nLogin: ${handover.login}\nParol: ${handover.password}`;
                    void navigator.clipboard?.writeText(text).then(() => setCopied(true));
                  }}
                >
                  {copied ? "Nusxa olindi" : "Hammasini nusxalash"}
                </AButton>
              </div>
            </>
          ) : (
            <p className="text-sm text-ink-muted">Bu login bilan hisob allaqachon bor — xodim o‘z paroli bilan kiradi.</p>
          )}
          {handover.role === "doctor" && !handover.reset && (
            <p className="text-sm text-ink-muted">Shifokor hisobini «Shifokorlar» bo‘limida shifokor yozuviga bog‘lang.</p>
          )}
          <div>
            <AButton size="sm" variant="ghost" onClick={() => setHandover(null)}>
              Yopish
            </AButton>
          </div>
        </Card>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-ink-muted">Bo‘lim:</span>
        <div className="w-56">
          <ASelect
            value={filter}
            onChange={setFilter}
            options={[{ value: "all", label: "Hammasi" }, { value: "none", label: "Bo‘limsiz" }, ...departments.map((d) => ({ value: d.id, label: d.name }))]}
            aria-label="Bo‘lim bo‘yicha saralash"
          />
        </div>
        <span className="text-xs text-ink-muted">{members ? `${shown.length} / ${members.length} xodim` : ""}</span>
      </div>

      {members === null ? (
        <Card>
          <LoadingRow />
        </Card>
      ) : shown.length === 0 ? (
        <Card>
          <AEmpty title="Xodimlar yo‘q" subtitle="Quyida xodim qo‘shing" icon={<UserCog className="h-6 w-6" />} />
        </Card>
      ) : (
        <ATable headers={["Xodim", "Rol", "Bo‘lim", "Amallar"]}>
          {shown.map((m) => {
            const locked = m.role === "owner" || m.isSelf;
            return (
              <tr key={m.profileId} className="hover:bg-sand">
                <td className="px-4 py-3">
                  <p className="font-medium text-foreground">
                    {m.fullName}
                    {m.isSelf && <span className="ml-2 text-xs text-ink-muted">(siz)</span>}
                  </p>
                  <p className="font-numeric text-xs text-ink-muted break-all">{m.login ?? m.email ?? "—"}</p>
                  {m.passwordPending && <ABadge tone="amber">Vaqtinchalik parol</ABadge>}
                  {m.role === "doctor" && (
                    <p className="text-xs text-ink-muted">{m.linkedDoctorName ? `Shifokor yozuvi: ${m.linkedDoctorName}` : "Shifokor yozuviga bog‘lanmagan"}</p>
                  )}
                </td>
                <td className="px-4 py-3">
                  {locked ? (
                    <ABadge tone={m.role === "owner" ? "purple" : "neutral"}>{ROLE_LABELS[m.role]}</ABadge>
                  ) : (
                    <div className="w-40">
                      <ASelect value={m.role} onChange={(v) => void patch(m, { role: v }, "Rolni o‘zgartirib bo‘lmadi")} options={ASSIGNABLE} aria-label={`${m.fullName} roli`} />
                    </div>
                  )}
                </td>
                <td className="px-4 py-3">
                  <div className="w-44">
                    <ASelect
                      value={m.departmentId ?? ""}
                      onChange={(v) => void patch(m, { departmentId: v || null }, "Bo‘limni o‘zgartirib bo‘lmadi")}
                      options={departmentOptions}
                      aria-label={`${m.fullName} bo‘limi`}
                    />
                  </div>
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
                    <div className="flex flex-wrap gap-1.5">
                      <AButton size="sm" variant="outline" loading={busy === m.profileId} onClick={() => void resetPassword(m)}>
                        Parolni tiklash
                      </AButton>
                      <AButton size="sm" variant="ghost" onClick={() => setConfirmRemove(m.profileId)}>
                        Olib tashlash
                      </AButton>
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </ATable>
      )}

      <Card className="mt-4 flex flex-col gap-3">
        <p className="text-sm font-bold text-foreground">Yangi xodim</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <AInput value={fullName} onChange={onName} placeholder="To‘liq ism (masalan: Dilnoza Karimova)" aria-label="Xodimning to‘liq ismi" />
          <AInput
            value={login}
            onChange={(v) => {
              setLoginTouched(true);
              setLogin(v);
            }}
            placeholder="Login (masalan: dilnoza.qabul)"
            aria-label="Xodimning logini"
            autoComplete="off"
          />
          <ASelect value={role} onChange={(v) => setRole(v as Exclude<Role, "owner">)} options={ASSIGNABLE} aria-label="Yangi xodim roli" />
          <ASelect value={departmentId} onChange={setDepartmentId} options={departmentOptions} aria-label="Yangi xodim bo‘limi" />
        </div>
        <p className="text-xs text-ink-muted">
          Login lotin harflari, raqamlar va nuqtadan iborat bo‘ladi. Vaqtinchalik parolni tizim yaratadi va faqat bir marta ko‘rsatadi.
        </p>
        <div>
          <AButton onClick={() => void add()} loading={busy === "add"}>
            Xodim qo‘shish
          </AButton>
        </div>
      </Card>
    </div>
  );
}
