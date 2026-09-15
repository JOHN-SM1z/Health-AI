"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PageHeader, Card, ABadge, ATable, AEmpty, AError, AButton, AInput, ATextArea, LoadingRow } from "@/components/admin/ui";
import { Users } from "lucide-react";
import { adminApi, AdminApiError, formatDateTime, STATUS_LABELS, STATUS_TONES, CHANNEL_LABELS } from "@/lib/admin/client";

type PatientRow = {
  id: string;
  full_name: string | null;
  phone: string | null;
  telegram_username: string | null;
  telegram_first_name: string | null;
  telegram_last_name: string | null;
  consent_given: boolean;
  consent_given_at: string | null;
  last_seen_at: string | null;
  created_at: string;
  appointments_count: number;
  conversations_count: number;
};

type PatientDetail = {
  id: string;
  full_name: string | null;
  phone: string | null;
  telegram_username: string | null;
  telegram_first_name: string | null;
  telegram_last_name: string | null;
  consent_given: boolean;
  consent_given_at: string | null;
  last_seen_at: string | null;
  created_at: string;
  operational_notes: string | null;
};

type AppointmentLite = {
  id: string;
  start_at: string;
  status: string;
  source: string;
  services: { name: string | null } | null;
  doctors: { name: string | null } | null;
};

type ConversationLite = {
  id: string;
  status: string;
  channel: string;
  updated_at: string;
};

type ListResponse = {
  patients: PatientRow[];
  total: number;
  page: number;
  pageSize: number;
};

type DetailResponse = {
  patient: PatientDetail | null;
  appointments: AppointmentLite[];
  conversations: ConversationLite[];
};

export default function PatientsPage() {
  const searchParams = useSearchParams();
  const [rows, setRows] = useState<PatientRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  // Deep-linkable from elsewhere (e.g. the receptionist dashboard's patient
  // search) via ?q= and ?id= — read once at mount, not kept in sync after.
  const [q, setQ] = useState(() => searchParams.get("q") ?? "");
  const [search, setSearch] = useState(() => searchParams.get("q") ?? "");
  const [onlyTelegram, setOnlyTelegram] = useState(false);
  const [noConsent, setNoConsent] = useState(false);
  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notesDraft, setNotesDraft] = useState("");
  const [notesSaving, setNotesSaving] = useState(false);
  const [notesSaved, setNotesSaved] = useState(false);

  const load = useCallback(async (pageNum: number, term: string, tg: boolean, nc: boolean) => {
    const params = new URLSearchParams({ page: String(pageNum) });
    if (term) params.set("q", term);
    if (tg) params.set("telegram", "1");
    if (nc) params.set("noConsent", "1");
    try {
      const res = await adminApi.get<ListResponse>(`/api/admin/patients?${params.toString()}`);
      setRows(res.patients);
      setTotal(res.total);
      setError(null);
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Bemorlarni yuklab bo‘lmadi");
    }
  }, []);

  // Debounced search.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(q);
      setPage(1);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [q]);

  useEffect(() => {
    void load(page, search, onlyTelegram, noConsent);
  }, [page, search, onlyTelegram, noConsent, load]);

  const openDetail = async (id: string) => {
    setDetailId(id);
    setDetail(null);
    setBusy(true);
    setNotesSaved(false);
    try {
      const res = await adminApi.get<DetailResponse>(`/api/admin/patients?id=${id}`);
      setDetail(res);
      setNotesDraft(res.patient?.operational_notes ?? "");
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Bemor ma'lumotlarini yuklab bo‘lmadi");
      setDetailId(null);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const id = searchParams.get("id");
    if (id) void openDetail(id);
    // Mount-only: deep-links into a specific patient's detail panel (e.g.
    // from the receptionist dashboard's search) without re-triggering on
    // every searchParams identity change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveNotes = async () => {
    if (!detailId) return;
    setNotesSaving(true);
    setNotesSaved(false);
    try {
      await adminApi.patch(`/api/admin/patients`, { patientId: detailId, operationalNotes: notesDraft });
      setDetail((prev) => (prev?.patient ? { ...prev, patient: { ...prev.patient, operational_notes: notesDraft.trim() || null } } : prev));
      setNotesSaved(true);
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Izohni saqlab bo‘lmadi");
    } finally {
      setNotesSaving(false);
    }
  };

  const pageCount = Math.max(1, Math.ceil(total / 25));
  const selected = detail?.patient ?? null;
  const notesDirty = notesDraft.trim() !== (selected?.operational_notes ?? "").trim();

  const visitStats = useMemo(() => {
    const completed = (detail?.appointments ?? []).filter((a) => a.status === "completed");
    return { count: completed.length, lastVisit: completed[0]?.start_at ?? null };
  }, [detail]);

  return (
    <div>
      <PageHeader title="Bemorlar" subtitle="Klinikangiz bemorlari — Telegram identifikatori, rozilik va tayinlovlar" />
      {error && <AError message={error} />}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <AInput
          value={q}
          onChange={setQ}
          placeholder="Ism, telefon yoki Telegram username qidirish…"
          className="max-w-xs"
          aria-label="Bemorlarni qidirish"
        />
        <AButton
          variant={onlyTelegram ? "primary" : "outline"}
          size="sm"
          onClick={() => setOnlyTelegram((v) => !v)}
        >
          Telegram orqali
        </AButton>
        <AButton
          variant={noConsent ? "primary" : "outline"}
          size="sm"
          onClick={() => setNoConsent((v) => !v)}
        >
          Roziliksiz
        </AButton>
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <div className="lg:col-span-3">
          {rows === null ? (
            <Card><LoadingRow /></Card>
          ) : rows.length === 0 ? (
            <Card>
              <AEmpty
                title="Bemorlar topilmadi"
                subtitle="Qidiruv shartlarini o‘zgartiring yoki yangi bemor qabulga yozilsin"
                icon={<Users className="h-6 w-6" />}
              />
            </Card>
          ) : (
            <Card className="p-0">
              <ATable headers={["Bemor", "Aloqa", "Rozilik", "Tayinlovlar", "Oxirgi faoliyat", ""]}>
                {rows.map((p) => (
                  <tr key={p.id} className="cursor-pointer hover:bg-sand" onClick={() => void openDetail(p.id)}>
                    <td className="px-4 py-3">
                      <p className="font-medium text-foreground">
                        {p.full_name ?? ([p.telegram_first_name, p.telegram_last_name].filter(Boolean).join(" ") || "Noma’lum")}
                      </p>
                      {p.telegram_username && <p className="text-xs text-ink-muted">@{p.telegram_username}</p>}
                    </td>
                    <td className="px-4 py-3 text-sm text-ink-muted">{p.phone ?? "—"}</td>
                    <td className="px-4 py-3">
                      {p.consent_given ? (
                        <ABadge tone="green">Rozilik bor</ABadge>
                      ) : (
                        <ABadge tone="amber">Roziliksiz</ABadge>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-foreground">{p.appointments_count}</td>
                    <td className="px-4 py-3 text-xs text-ink-muted">{formatDateTime(p.last_seen_at ?? p.created_at)}</td>
                    <td className="px-4 py-3"><AButton size="sm" variant="ghost">Batafsil</AButton></td>
                  </tr>
                ))}
              </ATable>
              {pageCount > 1 && (
                <div className="flex items-center justify-between border-t border-hairline px-4 py-3">
                  <p className="text-xs text-ink-muted">
                    {total} ta bemor — {page} / {pageCount}
                  </p>
                  <div className="flex gap-2">
                    <AButton size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                      Oldingi
                    </AButton>
                    <AButton size="sm" variant="outline" disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)}>
                      Keyingi
                    </AButton>
                  </div>
                </div>
              )}
            </Card>
          )}
        </div>

        <div className="lg:col-span-2">
          {!detailId ? (
            <Card>
              <AEmpty
                title="Bemorni tanlang"
                subtitle="Ro‘yxatdan birini oching — tayinlovlar va suhbatlar tarixi ko‘rinadi"
                icon={<Users className="h-6 w-6" />}
              />
            </Card>
          ) : busy || !detail ? (
            <Card><LoadingRow /></Card>
          ) : selected ? (
            <Card className="flex flex-col gap-4">
              <div>
                <p className="font-bold text-foreground">
                  {selected.full_name ?? ([selected.telegram_first_name, selected.telegram_last_name].filter(Boolean).join(" ") || "Noma’lum")}
                </p>
                <p className="text-sm text-ink-muted">
                  {selected.phone ?? "Telefon yo‘q"}
                  {selected.telegram_username ? ` · @${selected.telegram_username}` : ""}
                </p>
              </div>
              <div className="flex flex-wrap gap-2 text-xs">
                {selected.consent_given ? (
                  <ABadge tone="green">Ovozli xabarlar roziligi: bor</ABadge>
                ) : (
                  <ABadge tone="amber">Ovozli xabarlar roziligi: yo‘q</ABadge>
                )}
                {selected.telegram_first_name && <ABadge tone="blue">Telegram</ABadge>}
              </div>
              <div className="space-y-1 text-sm text-ink-muted">
                <p>Qo‘shilgan: {formatDateTime(selected.created_at)}</p>
                {selected.last_seen_at && <p>Oxirgi faollik: {formatDateTime(selected.last_seen_at)}</p>}
                <p>
                  Oxirgi tashrif: {visitStats.lastVisit ? formatDateTime(visitStats.lastVisit) : "Hali bo‘lmagan"}
                  {" · "}
                  Yakunlangan tashriflar: {visitStats.count}
                </p>
              </div>

              <div>
                <p className="mb-2 font-display text-sm font-bold text-foreground">Operatsion izoh</p>
                <p className="mb-2 text-xs text-ink-muted">
                  Faqat xizmat ko‘rsatish uchun — masalan, qulay vaqt yoki aloqa bo‘yicha eslatma. Tibbiy ma‘lumot emas.
                </p>
                <ATextArea
                  value={notesDraft}
                  onChange={(v) => {
                    setNotesDraft(v);
                    setNotesSaved(false);
                  }}
                  placeholder="Masalan: ertalabki vaqtlarni afzal ko‘radi"
                  rows={3}
                />
                <div className="mt-2 flex items-center gap-2">
                  <AButton size="sm" loading={notesSaving} disabled={!notesDirty} onClick={() => void saveNotes()}>
                    Izohni saqlash
                  </AButton>
                  {notesSaved && !notesDirty && <span className="text-xs text-pine-deep">Saqlandi ✓</span>}
                </div>
              </div>

              <div>
                <p className="mb-2 font-display text-sm font-bold text-foreground">Tayinlovlar ({detail.appointments.length})</p>
                {detail.appointments.length === 0 ? (
                  <p className="text-sm text-ink-muted">Tayinlovlar yo‘q</p>
                ) : (
                  <div className="space-y-2">
                    {detail.appointments.map((a) => (
                      <div key={a.id} className="flex items-center justify-between rounded-xl border border-hairline px-3 py-2">
                        <div>
                          <p className="text-sm font-medium text-foreground">
                            {a.services?.name ?? "Xizmat"} — {a.doctors?.name ?? "Shifokor"}
                          </p>
                          <p className="text-xs text-ink-muted">{formatDateTime(a.start_at)}</p>
                        </div>
                        <ABadge tone={STATUS_TONES[a.status] ?? "neutral"}>{STATUS_LABELS[a.status] ?? a.status}</ABadge>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <p className="mb-2 font-display text-sm font-bold text-foreground">Suhbatlar ({detail.conversations.length})</p>
                {detail.conversations.length === 0 ? (
                  <p className="text-sm text-ink-muted">Suhbatlar yo‘q</p>
                ) : (
                  <div className="space-y-2">
                    {detail.conversations.map((c) => (
                      <div key={c.id} className="flex items-center justify-between rounded-xl border border-hairline px-3 py-2">
                        <div>
                          <p className="text-sm font-medium text-foreground">{CHANNEL_LABELS[c.channel] ?? c.channel}</p>
                          <p className="text-xs text-ink-muted">{formatDateTime(c.updated_at)}</p>
                        </div>
                        <ABadge tone={c.status === "assigned" ? "purple" : c.status === "open" ? "blue" : "neutral"}>
                          {c.status === "assigned" ? "Operatorda" : c.status === "open" ? "Bot" : "Yopiq"}
                        </ABadge>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Card>
          ) : (
            <Card>
              <AEmpty title="Bemor topilmadi" subtitle="Ushbu bemor klinikangizga tegishli emas" />
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}