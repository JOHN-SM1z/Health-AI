"use client";

import { useEffect, useState } from "react";
import { ABadge, AButton, AError, AInput, AModal, ASelect, ATextArea } from "@/components/admin/ui";
import { adminApi, AdminApiError, formatDateTime } from "@/lib/admin/client";
import { LAB_FLAG } from "@/components/doctor/lab-orders";
import { formatRange, parseParameterValue, type LabValueType } from "@/lib/labs/values";

/**
 * Structured result entry (Phase 8). One row per configured parameter: the
 * input for its type, the unit, the clinic's configured range for this
 * patient and — once saved — where the value sits against that range, as
 * computed by the database. The screen never interprets a value; it says
 * "outside the configured range", never what that might mean.
 *
 * Only the person who started a draft edits it; it is submitted for
 * verification by a second person (Phase 9) and then read-only here.
 */

type Range = { low: number | null; high: number | null; text: string | null; criticalLow: number | null; criticalHigh: number | null };
type Parameter = {
  id: string;
  code: string;
  name: string;
  valueType: LabValueType;
  unit: string | null;
  decimals: number | null;
  choices: string[] | null;
  active: boolean;
  range: Range | null;
  value: { numeric: string | null; text: string | null; boolean: boolean | null; flag: string } | null;
};
type Entry = {
  item: { id: string; testName: string; testCode: string; status: string; orderedAt: string };
  patient: { fullName: string | null; dateOfBirth: string | null; sex: string | null };
  result: { id: string; status: string; version: number; mine: boolean; enteredByName: string | null; enteredAt: string; submittedAt: string | null; labComment: string | null } | null;
  parameters: Parameter[];
};
type Input = string | boolean | null;

const SEX: Record<string, string> = { male: "erkak", female: "ayol", unknown: "jinsi noma’lum" };
const errorText = (e: unknown, fallback: string) => (e instanceof AdminApiError ? e.message : fallback);

function initialInput(p: Parameter): Input {
  if (!p.value) return p.valueType === "boolean" ? null : "";
  if (p.valueType === "boolean") return p.value.boolean;
  if (p.valueType === "numeric") return (p.value.numeric ?? "").replace(".", ",");
  return p.value.text ?? "";
}

function shownValue(p: Parameter): string {
  if (!p.value) return "—";
  if (p.valueType === "boolean") return p.value.boolean ? "Ha" : "Yo‘q";
  if (p.valueType === "numeric") return `${(p.value.numeric ?? "").replace(".", ",")}${p.unit ? ` ${p.unit}` : ""}`;
  return p.value.text ?? "—";
}

function rangeText(p: Parameter): string | null {
  const r = p.range;
  if (!r) return null;
  const base = formatRange({ low: r.low, high: r.high, text: r.text });
  if (!base) return null;
  return p.valueType === "boolean" && r.text ? (r.text === "true" ? "Ha" : r.text === "false" ? "Yo‘q" : r.text) : base;
}

export function ResultEntryDialog({ itemId, onClose, onChanged }: { itemId: string; onClose: () => void; onChanged: (message: string) => void }) {
  const [entry, setEntry] = useState<Entry | null>(null);
  const [inputs, setInputs] = useState<Record<string, Input>>({});
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<"save" | "submit" | "discard" | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const load = async () => {
    try {
      const res = await adminApi.get<{ entry: Entry }>(`/api/lab/items/${itemId}/result`);
      setEntry(res.entry);
      setInputs(Object.fromEntries(res.entry.parameters.map((p) => [p.id, initialInput(p)])));
      setComment(res.entry.result?.labComment ?? "");
    } catch (e) {
      setError(errorText(e, "Natijani yuklab bo‘lmadi"));
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per item
  }, [itemId]);

  const result = entry?.result ?? null;
  const editable = entry !== null && (result === null || (result.status === "draft" && result.mine));
  const params = entry?.parameters ?? [];
  const problems = Object.fromEntries(
    params.map((p) => {
      const parsed = parseParameterValue(p.id, { code: p.code, valueType: p.valueType, decimals: p.decimals, choices: p.choices }, inputs[p.id]);
      return [p.id, parsed.ok ? null : parsed.message];
    }),
  );
  const hasProblem = Object.values(problems).some(Boolean);
  const missing = params.filter((p) => p.active && (inputs[p.id] === null || inputs[p.id] === "")).length;

  const save = async (): Promise<string | null> => {
    const res = await adminApi.put<{ resultId: string }>(`/api/lab/items/${itemId}/result`, {
      values: params.map((p) => ({ parameterId: p.id, value: inputs[p.id] ?? null })),
      labComment: comment.trim() || null,
    });
    return res.resultId;
  };

  const run = async (kind: "save" | "submit" | "discard") => {
    setSaving(kind);
    setError(null);
    try {
      if (kind === "discard" && result) {
        await adminApi.post(`/api/lab/results/${result.id}`, { action: "discard" });
        onChanged(`${entry!.item.testName}: qoralama o‘chirildi`);
        return;
      }
      const id = await save();
      if (kind === "submit" && id) {
        await adminApi.post(`/api/lab/results/${id}`, { action: "submit" });
        onChanged(`${entry!.item.testName}: natija tekshiruvga yuborildi`);
        return;
      }
      await load();
    } catch (e) {
      setError(errorText(e, "Natijani saqlab bo‘lmadi"));
      await load().catch(() => {});
    } finally {
      setSaving(null);
    }
  };

  const title = entry ? `${entry.item.testName} — natija` : "Natija";
  return (
    <AModal
      title={title}
      onClose={onClose}
      maxWidth="max-w-3xl"
      footer={
        entry && editable ? (
          <>
            {result && <AButton variant="ghost" onClick={() => setConfirmDiscard(true)}>Qoralamani o‘chirish</AButton>}
            <AButton variant="outline" onClick={() => void run("save")} loading={saving === "save"} disabled={hasProblem || saving !== null}>Qoralamani saqlash</AButton>
            <AButton onClick={() => void run("submit")} loading={saving === "submit"} disabled={hasProblem || missing > 0 || saving !== null}>Saqlash va tekshiruvga yuborish</AButton>
          </>
        ) : entry && result?.status === "draft" && !result.mine ? (
          <>
            <AButton variant="ghost" onClick={onClose}>Yopish</AButton>
            <AButton variant="danger" onClick={() => setConfirmDiscard(true)}>Qoralamani o‘chirish</AButton>
          </>
        ) : (
          <AButton variant="ghost" onClick={onClose}>Yopish</AButton>
        )
      }
    >
      {error && <AError message={error} />}
      {entry === null ? (
        <div className="h-2 w-full animate-pulse rounded bg-hairline" />
      ) : (
        <>
          <p className="text-sm text-foreground">
            <span className="font-semibold">{entry.patient.fullName ?? "—"}</span>
            <span className="text-ink-muted">
              {" · "}
              {entry.patient.dateOfBirth ? entry.patient.dateOfBirth.split("-").reverse().join(".") : "tug‘ilgan sana yo‘q"}
              {" · "}
              {SEX[entry.patient.sex ?? "unknown"] ?? "jinsi noma’lum"}
            </span>
          </p>
          {result?.status === "submitted" && (
            <p className="rounded-lg bg-sand px-3 py-2 text-sm text-foreground" role="status">
              Tekshiruvga yuborilgan ({formatDateTime(result.submittedAt)}). Natijani boshqa xodim tasdiqlaydi; o‘zgartirib bo‘lmaydi.
            </p>
          )}
          {result?.status === "draft" && !result.mine && (
            <p className="rounded-lg bg-clay-tint px-3 py-2 text-sm text-foreground" role="status">
              Bu natijani {result.enteredByName ?? "boshqa xodim"} kiritmoqda ({formatDateTime(result.enteredAt)}). Faqat u o‘zgartira oladi; kerak bo‘lsa qoralamani o‘chirib, qaytadan kiritishingiz mumkin.
            </p>
          )}

          <div className="flex flex-col divide-y divide-hairline rounded-xl border border-hairline">
            {params.map((p) => {
              const flag = p.value ? LAB_FLAG[p.value.flag] : null;
              const range = rangeText(p);
              return (
                <div key={p.id} className="grid grid-cols-1 gap-2 px-3 py-2 sm:grid-cols-[1fr_12rem_9rem] sm:items-center">
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {p.name} <span className="font-numeric text-xs text-ink-muted">{p.code}</span>
                    </p>
                    <p className="text-xs text-ink-muted">
                      {range ? `Me’yor: ${range}${p.unit && p.valueType === "numeric" ? ` ${p.unit}` : ""}` : "Me’yor sozlanmagan"}
                      {!p.active && " · nofaol ko‘rsatkich"}
                    </p>
                  </div>
                  <div>
                    {!editable ? (
                      <p className="font-numeric text-sm text-foreground">{shownValue(p)}</p>
                    ) : p.valueType === "boolean" ? (
                      <ASelect
                        value={inputs[p.id] === null ? "" : String(inputs[p.id])}
                        onChange={(v) => setInputs((s) => ({ ...s, [p.id]: v === "" ? null : v === "true" }))}
                        options={[{ value: "", label: "—" }, { value: "true", label: "Ha" }, { value: "false", label: "Yo‘q" }]}
                        aria-label={`${p.name} qiymati`}
                      />
                    ) : p.valueType === "choice" ? (
                      <ASelect
                        value={String(inputs[p.id] ?? "")}
                        onChange={(v) => setInputs((s) => ({ ...s, [p.id]: v }))}
                        options={[{ value: "", label: "—" }, ...(p.choices ?? []).map((c) => ({ value: c, label: c }))]}
                        aria-label={`${p.name} qiymati`}
                      />
                    ) : (
                      <AInput
                        value={String(inputs[p.id] ?? "")}
                        onChange={(v) => setInputs((s) => ({ ...s, [p.id]: v }))}
                        placeholder={p.valueType === "numeric" ? (p.unit ?? "son") : "matn"}
                        aria-label={`${p.name} qiymati`}
                      />
                    )}
                    {editable && problems[p.id] && <p className="mt-1 text-xs text-danger">{problems[p.id]}</p>}
                  </div>
                  <div>{flag && <ABadge tone={flag.tone}>{flag.label}</ABadge>}</div>
                </div>
              );
            })}
          </div>

          {editable ? (
            <ATextArea value={comment} onChange={setComment} rows={2} placeholder="Laboratoriya izohi (ixtiyoriy, masalan: lipemik namuna)" aria-label="Laboratoriya izohi" />
          ) : (
            result?.labComment && <p className="text-sm text-ink-muted">Izoh: {result.labComment}</p>
          )}
          <p className="text-xs text-ink-muted">
            Belgi saqlangandan keyin qo‘yiladi va faqat klinikada sozlangan me’yor oralig‘iga nisbatan joylashuvni ko‘rsatadi — bu tashxis emas.
            {editable && missing > 0 && ` Yuborish uchun barcha ko‘rsatkichlarni to‘ldiring (${missing} ta qoldi).`}
          </p>

          {confirmDiscard && result && (
            <div className="rounded-xl border border-danger/40 p-3 text-sm" role="alertdialog" aria-label="Qoralamani o‘chirishni tasdiqlang">
              <p className="text-foreground">Qoralama va undagi barcha qiymatlar o‘chiriladi.</p>
              <div className="mt-2 flex gap-2">
                <AButton size="sm" variant="danger" loading={saving === "discard"} onClick={() => void run("discard")}>O‘chirish</AButton>
                <AButton size="sm" variant="ghost" onClick={() => setConfirmDiscard(false)}>Bekor qilish</AButton>
              </div>
            </div>
          )}
        </>
      )}
    </AModal>
  );
}
