"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/browser";
import type { Database } from "@/lib/supabase/database.types";
import { PageHeader, Card, ABadge, ATable, AEmpty, AError, AButton, ATextArea, AInput, ASelect, LoadingRow } from "@/components/admin/ui";
import { MessagesSquare } from "lucide-react";
import { adminApi, AdminApiError, formatDateTime } from "@/lib/admin/client";

type Conversation = {
  id: string;
  status: Database["public"]["Enums"]["conversation_status"];
  ai_enabled: boolean;
  updated_at: string;
  last_message_at: string | null;
  patient_id: string | null;
  taken_over_by: string | null;
  admin_seen_at: string | null;
  patients: {
    full_name: string | null;
    phone: string | null;
    telegram_username: string | null;
    telegram_first_name: string | null;
  } | null;
  profiles: { full_name: string | null } | null;
};

type Message = {
  id: string;
  role: string;
  content: string | null;
  created_at: string;
};

type MessagePreview = { role: string; content: string | null; created_at: string };

const POLL_MS = 5000;
const EPOCH = "1970-01-01T00:00:00.000Z";

const STATUS_FILTERS = [
  { value: "all", label: "Barcha suhbatlar" },
  { value: "attention", label: "Diqqat talab" },
  { value: "bot", label: "Botda" },
  { value: "assigned", label: "Operatorda" },
  { value: "closed", label: "Yopilgan" },
] as const;

export default function ConversationsPage() {
  const [list, setList] = useState<Conversation[] | null>(null);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [previews, setPreviews] = useState<Record<string, MessagePreview>>({});
  const [open, setOpen] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [reply, setReply] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_FILTERS)[number]["value"]>("all");
  const openIdRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    const supabase = createClient();
    const { data, error: err } = await supabase
      .from("conversations")
      .select(
        "id, status, ai_enabled, updated_at, last_message_at, patient_id, taken_over_by, admin_seen_at, patients(full_name, phone, telegram_username, telegram_first_name), profiles!conversations_taken_over_by_fkey(full_name)",
      )
      .order("updated_at", { ascending: false })
      .limit(100);
    if (err) {
      setError("Suhbatlarni yuklab bo‘lmadi");
      return;
    }
    const rows = data ?? [];
    setList(rows);

    // Unread counts: patient messages newer than the operator's last view.
    const counts: Record<string, number> = {};
    for (const c of rows) {
      if (c.status === "closed") continue;
      const { count } = await supabase
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("conversation_id", c.id)
        .eq("role", "patient")
        .gt("created_at", c.admin_seen_at ?? EPOCH);
      if (count) counts[c.id] = count;
    }
    setUnread((prev) => {
      if (JSON.stringify(prev) === JSON.stringify(counts)) return prev;
      return counts;
    });

    // Last-message previews: newest messages first, first hit per conversation.
    const { data: latest } = await supabase
      .from("messages")
      .select("conversation_id, role, content, created_at")
      .order("created_at", { ascending: false })
      .limit(200);
    if (latest) {
      const byConv: Record<string, MessagePreview> = {};
      for (const m of latest) {
        if (!byConv[m.conversation_id]) {
          byConv[m.conversation_id] = { role: m.role, content: m.content, created_at: m.created_at };
        }
      }
      setPreviews(byConv);
    }

    // Keep the open conversation view honest (another operator may have
    // released it, or the patient may have closed it with the exit button).
    const currentId = openIdRef.current;
    if (currentId) {
      const fresh = rows.find((r) => r.id === currentId);
      if (fresh) setOpen(fresh);
    }
    setError(null);
  }, []);

  const loadMessages = useCallback(async (conversationId: string) => {
    const supabase = createClient();
    const { data } = await supabase
      .from("messages")
      .select("id, role, content, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .limit(200);
    setMessages(data ?? []);
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (!open) return;
    void loadMessages(open.id);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadMessages(open.id);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [open, loadMessages]);

  const openConversation = async (c: Conversation) => {
    openIdRef.current = c.id;
    setOpen(c);
    setMessages(null);
    // Mark this conversation as seen by the current operator (server-verified).
    try {
      await adminApi.post(`/api/admin/conversations/${c.id}`, { action: "mark_seen" });
      await load();
    } catch {
      // Read-tracking must never block opening the conversation.
    }
    await loadMessages(c.id);
  };

  const toggleTakeover = async () => {
    if (!open) return;
    setBusy("takeover");
    try {
      const isAssigned = open.status === "assigned";
      await adminApi.post(`/api/admin/conversations/${open.id}`, { action: isAssigned ? "release" : "takeover" });
      await load();
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Xatolik");
    } finally {
      setBusy(null);
    }
  };

  const sendReply = async () => {
    if (!open || !reply.trim()) return;
    setBusy("reply");
    try {
      await adminApi.put(`/api/admin/conversations/${open.id}`, { text: reply.trim() });
      setReply("");
      await Promise.all([load(), loadMessages(open.id)]);
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Yuborib bo‘lmadi");
    } finally {
      setBusy(null);
    }
  };

  const isAssigned = open?.status === "assigned";

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (list ?? []).filter((c) => {
      if (statusFilter === "attention" && !(c.status === "open" && !c.ai_enabled)) return false;
      if (statusFilter === "bot" && !(c.ai_enabled && c.status !== "closed")) return false;
      if (statusFilter === "assigned" && c.status !== "assigned") return false;
      if (statusFilter === "closed" && c.status !== "closed") return false;
      if (!needle) return true;
      const preview = previews[c.id];
      return (
        (c.patients?.full_name ?? "").toLowerCase().includes(needle) ||
        (c.patients?.phone ?? "").toLowerCase().includes(needle) ||
        (c.patients?.telegram_username ?? "").toLowerCase().includes(needle) ||
        (c.patients?.telegram_first_name ?? "").toLowerCase().includes(needle) ||
        (preview?.content ?? "").toLowerCase().includes(needle)
      );
    });
  }, [list, q, statusFilter, previews]);

  return (
    <div>
      <PageHeader title="Suhbatlar" subtitle="Telegram orqali bemorlar bilan bot/operator suhbatlari" />
      {error && <AError message={error} />}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="w-56">
          <AInput value={q} onChange={setQ} placeholder="Qidirish: bemor, telefon, xabar…" />
        </div>
        <div className="w-48">
          <ASelect
            value={statusFilter}
            onChange={(v) => setStatusFilter(v as (typeof STATUS_FILTERS)[number]["value"])}
            options={[...STATUS_FILTERS]}
            aria-label="Holat filtri"
          />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          {list === null ? (
            <Card><LoadingRow /></Card>
          ) : visible.length === 0 ? (
            <Card>
              <AEmpty
                title={list.length === 0 ? "Suhbatlar yo‘q" : "Topilmadi"}
                subtitle={
                  list.length === 0
                    ? "Bemorlar Telegram orqali yozganda bu yerda paydo bo‘ladi"
                    : "Filtr yoki qidiruv so‘zini o‘zgartiring"
                }
                icon={<MessagesSquare className="h-6 w-6" />}
              />
            </Card>
          ) : (
            <ATable headers={["Bemor", "Holat", "Oxirgi xabar", ""]}>
              {visible.map((c) => {
                const preview = previews[c.id];
                const unreadCount = unread[c.id] ?? 0;
                const needsAttention = c.status === "open" && !c.ai_enabled;
                return (
                  <tr key={c.id} className="cursor-pointer hover:bg-sand" onClick={() => void openConversation(c)}>
                    <td className="px-4 py-3">
                      <p className="flex items-center gap-2 font-medium text-foreground">
                        {c.patients?.full_name ?? c.patients?.telegram_first_name ?? "Noma’lum"}
                        {unreadCount > 0 && (
                          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-clay px-1.5 font-numeric text-[10px] font-bold text-white">
                            {unreadCount}
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-ink-muted">
                        {c.patients?.phone ?? (c.patients?.telegram_username ? `@${c.patients.telegram_username}` : "Telegram")}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      {c.status === "assigned" ? (
                        <ABadge tone="purple">Operatorda{c.profiles?.full_name ? `: ${c.profiles.full_name}` : ""}</ABadge>
                      ) : needsAttention ? (
                        <ABadge tone="clay">Diqqat talab</ABadge>
                      ) : c.ai_enabled ? (
                        <ABadge tone="blue">Bot</ABadge>
                      ) : (
                        <ABadge tone="amber">Kutmoqda</ABadge>
                      )}
                    </td>
                    <td className="max-w-[220px] px-4 py-3">
                      {preview ? (
                        <>
                          <p className="truncate text-sm text-foreground">
                            <span className={preview.role === "patient" ? "" : "text-ink-muted"}>
                              {preview.role === "patient" ? "Bemor: " : preview.role === "admin" ? "Operator: " : ""}
                            </span>
                            {preview.content ?? "…"}
                          </p>
                          <p className="text-xs text-ink-muted">{formatDateTime(preview.created_at)}</p>
                        </>
                      ) : (
                        <p className="text-xs text-ink-muted">{formatDateTime(c.updated_at)}</p>
                      )}
                    </td>
                    <td className="px-4 py-3"><AButton size="sm" variant="ghost">Ochish</AButton></td>
                  </tr>
                );
              })}
            </ATable>
          )}
        </div>

        <div>
          {!open ? (
            <Card>
              <AEmpty
                title="Suhbatni tanlang"
                subtitle="Chapdagi ro‘yxatdan birini oching"
                icon={<MessagesSquare className="h-6 w-6" />}
              />
            </Card>
          ) : (
            <Card className="flex h-[480px] flex-col">
              <div className="mb-3 flex items-center justify-between border-b border-hairline pb-3">
                <div>
                  <p className="font-bold text-foreground">
                    {open.patients?.full_name ?? open.patients?.telegram_first_name ?? "Noma’lum"}
                  </p>
                  <p className="text-xs text-ink-muted">
                    {isAssigned
                      ? `Operator qabul qilgan${open.profiles?.full_name ? `: ${open.profiles.full_name}` : ""}`
                      : open.ai_enabled
                        ? "Bot javob beradi"
                        : "Diqqat talab — operator javobi kerak"}
                  </p>
                </div>
                <AButton
                  size="sm"
                  variant={isAssigned ? "outline" : "primary"}
                  loading={busy === "takeover"}
                  onClick={() => void toggleTakeover()}
                >
                  {isAssigned ? "Qo‘yib yuborish" : "Qabul qilish"}
                </AButton>
              </div>

              <div className="flex-1 space-y-2 overflow-y-auto pr-1">
                {messages === null ? (
                  <div className="h-2 w-full animate-pulse rounded bg-hairline" />
                ) : messages.length === 0 ? (
                  <p className="py-6 text-center text-sm text-ink-muted">Xabarlar yo‘q</p>
                ) : (
                  messages.map((m) => (
                    <div
                      key={m.id}
                      className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${
                        m.role === "patient"
                          ? "rounded-tl-sm bg-pine text-white"
                          : m.role === "admin"
                            ? "rounded-tr-sm bg-foreground text-white"
                            : "rounded-tr-sm bg-sand text-ink-muted"
                      }`}
                    >
                      <p className="whitespace-pre-wrap break-words">{m.content}</p>
                      <p className={`mt-1 text-[10px] ${m.role === "patient" ? "text-pine-tint" : "text-ink-muted"}`}>
                        {formatDateTime(m.created_at)}
                      </p>
                    </div>
                  ))
                )}
              </div>

              <div className="mt-3 flex gap-2 border-t border-hairline pt-3">
                <ATextArea value={reply} onChange={setReply} placeholder="Javob yozing…" rows={2} className="flex-1" />
                <AButton loading={busy === "reply"} onClick={() => void sendReply()}>Yuborish</AButton>
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}