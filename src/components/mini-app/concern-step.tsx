"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, Square, Stethoscope } from "lucide-react";
import { Button, Card, ErrorBanner, SectionTitle, Spinner } from "@/components/mini-app/ui";
import { apiPost, getClientClinicId } from "@/lib/client/api";

type Suggestion = { specialtyId: string; name: string; serviceIds: string[]; doctorIds: string[] };
type ConcernAnswer =
  | { urgent: true; message: string; clinicPhone: string | null }
  | { urgent: false; disclaimer: string; suggestions: Suggestion[]; general: Suggestion | null; matched: boolean };

const MAX_SECONDS = 60;

/**
 * "What brings you in?" — typed, or spoken when the clinic has a local speech service. The server suggests one of the
 * clinic's directions (never a diagnosis); the patient picks it, the general consultation, or chooses on their own.
 * Urgent wording ends the booking here with the approved urgent-care message (staff are alerted on the server).
 */
export function ConcernStep({
  identity,
  onChoose,
  onSkip,
  onUrgentExit,
}: {
  identity: string | null;
  onChoose: (specialtyId: string, concern: string) => void;
  onSkip: (concern: string) => void;
  onUrgentExit: () => void;
}) {
  const [text, setText] = useState("");
  const [answer, setAnswer] = useState<ConcernAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const [voiceConsent, setVoiceConsent] = useState(false);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    void apiPost<{ voiceAvailable: boolean }>("/api/mini-app/identity/status", {}, identity).then((r) => {
      if (r.ok) setVoiceAvailable(r.data.voiceAvailable && typeof window !== "undefined" && "MediaRecorder" in window);
    });
    return () => {
      if (timer.current) clearInterval(timer.current);
      recorder.current?.stream.getTracks().forEach((t) => t.stop());
    };
  }, [identity]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const res = await apiPost<ConcernAnswer>("/api/mini-app/concern", { text }, identity);
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setAnswer(res.data);
  };

  const stopRecording = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    recorder.current?.stop();
    setRecording(false);
  };

  const startRecording = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunks.current = [];
      rec.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks.current, { type: rec.mimeType || "audio/webm" });
        const form = new FormData();
        if (identity) form.set("initData", identity);
        form.set("consent", "true");
        form.set("audio", blob, "concern");
        setBusy(true);
        const clinicId = getClientClinicId();
        const res = await fetch(`/api/mini-app/concern/voice${clinicId ? `?clinic=${encodeURIComponent(clinicId)}` : ""}`, { method: "POST", body: form });
        const json = (await res.json().catch(() => null)) as { ok?: boolean; data?: { text: string }; error?: string } | null;
        setBusy(false);
        if (json?.ok && json.data) setText(json.data.text);
        else setError(json?.error ?? "Ovozni matnga aylantirib bo‘lmadi — iltimos, yozib yuboring");
      };
      recorder.current = rec;
      rec.start();
      setRecording(true);
      setSeconds(0);
      timer.current = setInterval(() => {
        setSeconds((s) => {
          if (s + 1 >= MAX_SECONDS) stopRecording();
          return s + 1;
        });
      }, 1000);
    } catch {
      setError("Mikrofonga ruxsat berilmadi — iltimos, yozib yuboring");
    }
  };

  if (answer?.urgent) {
    return (
      <Card className="flex flex-col gap-3 border-red-300">
        <SectionTitle>Shoshilinch yordam</SectionTitle>
        <p className="whitespace-pre-line text-sm">{answer.message}</p>
        {answer.clinicPhone && <p className="text-sm font-semibold">Klinika: {answer.clinicPhone}</p>}
        <p className="text-xs text-[var(--tg-hint,#8a9699)]">Klinika xodimlariga xabar berildi. Onlayn navbat bu holatda taklif qilinmaydi.</p>
        <Button size="full" variant="outline" onClick={onUrgentExit}>
          Bosh sahifaga
        </Button>
      </Card>
    );
  }

  if (answer && !answer.urgent) {
    return (
      <div className="flex flex-col gap-3">
        <SectionTitle>Qaysi shifokorga yozilasiz?</SectionTitle>
        <p className="text-xs text-[var(--tg-hint,#8a9699)]">{answer.disclaimer}</p>
        {answer.suggestions.length > 0 ? (
          <p className="text-sm">Yozganingizga ko‘ra quyidagi yo‘nalish mos kelishi mumkin. Tanlov sizda:</p>
        ) : (
          <p className="text-sm">Aniq yo‘nalishni tanlab bo‘lmadi — umumiy ko‘rik shifokori yordam beradi yoki o‘zingiz tanlang.</p>
        )}
        {answer.suggestions.map((s) => (
          <Button key={s.specialtyId} size="full" onClick={() => onChoose(s.specialtyId, text.trim())}>
            <Stethoscope className="h-4 w-4" aria-hidden /> {s.name}
          </Button>
        ))}
        {answer.general && !answer.suggestions.some((s) => s.specialtyId === answer.general!.specialtyId) && (
          <Button size="full" variant={answer.suggestions.length ? "outline" : "primary"} onClick={() => onChoose(answer.general!.specialtyId, text.trim())}>
            Umumiy ko‘rik — {answer.general.name}
          </Button>
        )}
        <Button size="full" variant="ghost" onClick={() => onSkip(text.trim())}>
          Yo‘nalishni o‘zim tanlayman
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {error && <ErrorBanner message={error} />}
      <SectionTitle>Nima bezovta qilyapti?</SectionTitle>
      <Card className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          O‘z so‘zlaringiz bilan qisqacha yozing
          <textarea
            aria-label="Shikoyatingiz"
            className="min-h-[96px] rounded-xl border px-3 py-2 text-sm"
            maxLength={300}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Masalan: 3 kundan beri boshim og‘riyapti"
          />
        </label>
        {voiceAvailable && (
          <div className="flex flex-col gap-2">
            <label className="flex items-start gap-2 text-xs">
              <input type="checkbox" checked={voiceConsent} onChange={(e) => setVoiceConsent(e.target.checked)} />
              Ovozimni matnga aylantirish uchun klinikaning mahalliy xizmatiga yuborilishiga roziman (yozuv saqlanmaydi).
            </label>
            {recording ? (
              <Button variant="danger" size="full" onClick={stopRecording}>
                <Square className="h-4 w-4" aria-hidden /> To‘xtatish ({MAX_SECONDS - seconds} s)
              </Button>
            ) : (
              <Button variant="outline" size="full" disabled={!voiceConsent || busy} onClick={startRecording}>
                <Mic className="h-4 w-4" aria-hidden /> Ovoz bilan aytish
              </Button>
            )}
          </div>
        )}
        {busy && <Spinner label="Ishlanmoqda…" />}
        <p className="text-xs text-[var(--tg-hint,#8a9699)]">Bu tashxis emas — faqat qaysi shifokorga yozilishni tanlashga yordam beradi.</p>
        <Button size="full" disabled={text.trim().length < 2 || busy || recording} onClick={submit}>
          Davom etish
        </Button>
        <Button size="full" variant="ghost" onClick={() => onSkip("")}>
          O‘tkazib yuborish
        </Button>
      </Card>
    </div>
  );
}
