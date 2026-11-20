import { HeartPulse, CheckCircle2, AlertCircle } from "lucide-react";

export const metadata = { title: "OneID" };

const TEXT: Record<string, { ok: boolean; title: string; body: string }> = {
  verified: { ok: true, title: "Shaxsingiz tasdiqlandi", body: "Ma’lumotlaringiz davlat tizimidan olindi. Telegram’ga qayting — yozilishni davom ettirasiz." },
  linked: { ok: true, title: "Kartangiz topildi va tasdiqlandi", body: "Klinikadagi kartangiz Telegram’ingizga bog‘landi. Telegram’ga qayting — yozilishni davom ettirasiz." },
  reception: { ok: false, title: "Qabulxonada tasdiqlash kerak", body: "Shaxsingiz tasdiqlandi, lekin kartangizni onlayn bog‘lab bo‘lmadi. Qabulxonada hujjatingizni ko‘rsating." },
  invalid: { ok: false, title: "OneID ma’lumotlari to‘liq emas", body: "OneID profilingiz tasdiqlanmagan yoki to‘liq emas. Telegram’ga qaytib, boshqa usulda davom eting." },
  expired: { ok: false, title: "Havola eskirgan", body: "Telegram’ga qayting va “OneID orqali tasdiqlash” tugmasini qayta bosing." },
  failed: { ok: false, title: "OneID bilan bog‘lanib bo‘lmadi", body: "Birozdan keyin qayta urinib ko‘ring yoki telefon orqali tasdiqlang." },
};

/** Where OneID sends the patient back (in the phone's browser): how it ended, and to return to Telegram. */
export default async function OneIdResultPage({ searchParams }: { searchParams: Promise<{ r?: string }> }) {
  const { r } = await searchParams;
  const t = TEXT[r ?? ""] ?? TEXT.failed;
  return (
    <div className="mx-auto flex min-h-dvh max-w-sm flex-col items-center justify-center gap-4 px-4 text-center">
      <span className="brand-tile flex h-12 w-12 items-center justify-center rounded-2xl text-white">
        <HeartPulse className="h-6 w-6" />
      </span>
      {t.ok ? <CheckCircle2 className="h-10 w-10 text-pine" /> : <AlertCircle className="h-10 w-10 text-clay" />}
      <h1 className="font-display text-xl font-bold">{t.title}</h1>
      <p className="text-sm leading-relaxed text-ink-muted">{t.body}</p>
    </div>
  );
}
