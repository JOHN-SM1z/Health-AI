"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/browser";
import type { Database } from "@/lib/supabase/database.types";
import { PageHeader, Card, ABadge, ATable, AEmpty, AError, AButton, ATextArea } from "@/components/admin/ui";
import { adminApi, AdminApiError, formatDateTime } from "@/lib/admin/client";

type Conversation = {
  id: string;
  status: Database["public"]["Enums"]["conversation_status"];
  ai_enabled: boolean;
  updated_at: string;
  patient_id: string | null;
  patients: { full_name: string | null; phone: string | null } | null;
};

type Message = {
  id: string;
  role: string;
  content: string | null;
  created_at: string;
};

export default function ConversationsPage() {
  const [list, setList] = useState<Conversation[] | null>(null);
  const [open, setOpen] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [reply, setReply] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    const supabase = createClient();
    const { data, error: err } = await supabase
      .from("conversations")
      .select("id, status, ai_enabled, updated_at, patient_id, patients(full_name, phone)")
      .order("updated_at", { ascending: false })
      .limit(100);
    if (err) {
      setError("Suhbatlarni yuklab bo‘lmadi");
      return;
    }
    setList(data ?? []);
    setError(null);
  };

  useEffect(() => {
    void load();
  }, []);

  const openConversation = async (c: Conversation) => {
    setOpen(c);
    setMessages(null);
    const supabase = createClient();
    const { data } = await supabase
      .from("messages")
      .select("id, role, content, created_at")
      .eq("conversation_id", c.id)
      .order("created_at", { ascending: true })
      .limit(100);
    setMessages(data ?? []);
  };

  const toggleTakeover = async () => {
    if (!open) return;
    setBusy("takeover");
    try {
      const isAssigned = open.status === "assigned";
      await adminApi.post(`/api/admin/conversations/${open.id}`, { action: isAssigned ? "release" : "takeover" });
      setOpen({ ...open, status: isAssigned ? "open" : "assigned", ai_enabled: isAssigned });
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
      await openConversation(open);
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Yuborib bo‘lmadi");
    } finally {
      setBusy(null);
    }
  };

  const isAssigned = open?.status === "assigned";

  return (
    <div>
      <PageHeader title="Suhbatlar" subtitle="Telegram orqali bemorlar bilan bot/operator suhbatlari" />
      {error && <AError message={error} />}

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          {list === null ? (
            <Card><div className="h-2 w-full animate-pulse rounded bg-hairline" /></Card>
          ) : list.length === 0 ? (
            <Card><AEmpty title="Suhbatlar yo‘q" subtitle="Bemorlar Telegram orqali yozganda bu yerda paydo bo‘ladi" /></Card>
          ) : (
            <ATable headers={["Bemor", "Holat", "Oxirgi faoliyat", ""]}>
              {list.map((c) => (
                <tr key={c.id} className="cursor-pointer hover:bg-sand" onClick={() => void openConversation(c)}>
                  <td className="px-4 py-3">
                    <p className="font-medium text-foreground">{c.patients?.full_name ?? "Noma’lum"}</p>
                    {c.patients?.phone && <p className="text-xs text-ink-muted">{c.patients.phone}</p>}
                  </td>
                  <td className="px-4 py-3">
                    {c.status === "assigned" ? (
                      <ABadge tone="purple">Operatorda</ABadge>
                    ) : c.ai_enabled ? (
                      <ABadge tone="blue">Bot</ABadge>
                    ) : (
                      <ABadge tone="amber">Kutmoqda</ABadge>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-ink-muted">{formatDateTime(c.updated_at)}</td>
                  <td className="px-4 py-3"><AButton size="sm" variant="ghost">Ochish</AButton></td>
                </tr>
              ))}
            </ATable>
          )}
        </div>

        <div>
          {!open ? (
            <Card><AEmpty title="Suhbatni tanlang" subtitle="Chapdagi ro‘yxatdan birini oching" /></Card>
          ) : (
            <Card className="flex h-[480px] flex-col">
              <div className="mb-3 flex items-center justify-between border-b border-hairline pb-3">
                <div>
                  <p className="font-bold text-foreground">{open.patients?.full_name ?? "Noma’lum"}</p>
                  <p className="text-xs text-ink-muted">
                    {isAssigned ? "Operator qabul qilgan" : open.ai_enabled ? "Bot javob beradi" : "Bot to‘xtatilgan"}
                  </p>
                </div>
                <AButton size="sm" variant={isAssigned ? "outline" : "primary"} loading={busy === "takeover"} onClick={() => void toggleTakeover()}>
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