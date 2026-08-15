"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/browser";
import { PageHeader, Card, ABadge, ATable, AEmpty, AError, AButton, AInput, ATextArea, LoadingRow } from "@/components/admin/ui";
import { MessagesSquare } from "lucide-react";
import { adminApi, AdminApiError } from "@/lib/admin/client";

type Faq = { id: string; question: string; answer: string; category: string | null; active: boolean };

export default function FaqsPage() {
  const [rows, setRows] = useState<Faq[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Faq | null>(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [category, setCategory] = useState("");

  const load = async () => {
    const supabase = createClient();
    const { data, error: err } = await supabase.from("faq_entries").select("*").order("sort_order");
    if (err) {
      setError("Savollarni yuklab bo‘lmadi");
      return;
    }
    setRows(data ?? []);
  };

  useEffect(() => {
    void load();
  }, []);

  const save = async () => {
    if (!question.trim() || !answer.trim()) {
      setError("Savol va javob kiritilishi shart");
      return;
    }
    try {
      const payload = { question: question.trim(), answer: answer.trim(), category: category || undefined };
      if (editing?.id) {
        await adminApi.patch(`/api/admin/faqs?id=${editing.id}`, payload);
      } else {
        await adminApi.post("/api/admin/faqs", payload);
      }
      setEditing(null);
      setQuestion("");
      setAnswer("");
      setCategory("");
      setError(null);
      void load();
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Saqlab bo‘lmadi");
    }
  };

  return (
    <div>
      <PageHeader title="Savol-javoblar" subtitle="Bot AI bilim bazasi manbasi" />
      {error && <AError message={error} />}
      {rows === null ? (
        <Card><LoadingRow /></Card>
      ) : rows.length === 0 ? (
        <Card>
          <AEmpty
            title="Savollar yo‘q"
            subtitle="Bot javob berishi uchun kamida bir nechta savol qo‘shing"
            icon={<MessagesSquare className="h-6 w-6" />}
          />
        </Card>
      ) : (
        <ATable headers={["Savol", "Kategoriya", "Holat", "Amallar"]}>
          {rows.map((f) => (
            <tr key={f.id} className="hover:bg-sand">
              <td className="px-4 py-3">
                <p className="font-medium text-foreground">{f.question}</p>
                <p className="max-w-md truncate text-xs text-ink-muted">{f.answer}</p>
              </td>
              <td className="px-4 py-3 text-ink-muted">{f.category ?? "—"}</td>
              <td className="px-4 py-3"><ABadge tone={f.active ? "green" : "gray"}>{f.active ? "Faol" : "Nofaol"}</ABadge></td>
              <td className="px-4 py-3">
                <div className="flex gap-1.5">
                  <AButton
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setEditing(f);
                      setQuestion(f.question);
                      setAnswer(f.answer);
                      setCategory(f.category ?? "");
                    }}
                  >
                    Tahrirlash
                  </AButton>
                  <AButton size="sm" variant="danger" onClick={() => { void adminApi.del(`/api/admin/faqs?id=${f.id}`).then(() => void load()); }}>
                    O‘chirish
                  </AButton>
                </div>
              </td>
            </tr>
          ))}
        </ATable>
      )}

      <Card className="mt-4 flex flex-col gap-3">
        <p className="text-sm font-bold text-foreground">{editing?.id ? "Savolni tahrirlash" : "Yangi savol"}</p>
        <AInput value={question} onChange={setQuestion} placeholder="Savol" aria-label="Savol" />
        <ATextArea value={answer} onChange={setAnswer} placeholder="Javob" />
        <AInput value={category} onChange={setCategory} placeholder="Kategoriya (masalan: Qabul)" aria-label="Kategoriya" />
        <div className="flex gap-2">
          {editing?.id && <AButton variant="outline" onClick={() => { setEditing(null); setQuestion(""); setAnswer(""); setCategory(""); }}>Bekor</AButton>}
          <AButton onClick={() => void save()}>Saqlash</AButton>
        </div>
      </Card>
    </div>
  );
}