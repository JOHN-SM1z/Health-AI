import type { Metadata } from "next";
import Link from "next/link";
import {
  HeartPulse,
  ArrowRight,
  CalendarCheck,
  IdCard,
  DoorOpen,
  Wallet,
  Stethoscope,
  FlaskConical,
  Users,
  BarChart3,
  Lock,
  EyeOff,
  FileClock,
  Bot,
  Check,
  Building2,
  KeyRound,
  Send,
} from "lucide-react";
import { listPublicPlans } from "@/lib/billing/subscription";
import { formatUzs, type Plan } from "@/lib/billing/status";
import { PhoneMock, QueueBoardMock, FloatingChip, CLINIC_DAY } from "@/components/landing/mockups";
import { TelegramEntryRedirect } from "@/components/landing/telegram-entry";

export const revalidate = 300;

export const metadata: Metadata = {
  title: { absolute: "Health AI — klinikalar uchun yagona boshqaruv tizimi" },
  description:
    "Telegram orqali onlayn qabul va pasport/ID bilan bemorni aniqlash, qabulxona va navbat, kassa, shifokor ish joyi, laboratoriya — bitta tizimda. 14 kun bepul.",
  robots: { index: true, follow: true },
};

const MODULES = [
  { icon: CalendarCheck, title: "Telegram orqali onlayn qabul", text: "Bemor klinikangiz botida xizmat, shifokor va kunni tanlaydi. Bo‘sh vaqtlar serverda qayta tekshiriladi — bir vaqtga ikki bemor yozilmaydi." },
  { icon: IdCard, title: "Pasport/ID bilan aniqlash", text: "Bemor pasport, ID karta yoki JSHSHIR va tug‘ilgan sanani kiritadi; telefoni Telegram yoki SMS kod bilan tasdiqlanadi. Mavjud karta topiladi, takror karta ochilmaydi." },
  { icon: DoorOpen, title: "Qabulxona va jonli navbat", text: "Onlayn yozilganlar va kelib qo‘shilganlar bitta navbatda, slot vaqti bo‘yicha. Zal uchun navbat ekrani, bemorga “sizni chaqirishdi” xabari." },
  { icon: Wallet, title: "Kassa va moliya", text: "Narx katalogdan, to‘lov kassada, smena yakuni va qaytarishlar qoidalar bilan. Moliya hisobotlari faqat egasi va administratorga." },
  { icon: Stethoscope, title: "Shifokor ish joyi", text: "O‘z bemorlari, klinik yozuvlar, tahlil buyurtmasi va boshqa shifokorga yo‘llanma. Yozuvlar o‘chirilmaydi — tuzatish yangi yozuv sifatida qoladi." },
  { icon: FlaskConical, title: "Laboratoriya", text: "Buyurtmadan namuna olish, natija kiritish, tekshirish va PDF’gacha. Bemor faqat tasdiqlangan natijasini Telegram’da oladi." },
  { icon: Users, title: "Xodimlar va bo‘limlar", text: "Har bir xodimga login va rol; qabulxona, kassa, shifokor, laborant — har biri o‘z panelini ko‘radi. Bo‘limlar bo‘yicha tartib." },
  { icon: BarChart3, title: "Tahlillar", text: "Qabullar, kanallar (Telegram, qabulxona, sayt), shifokorlar yuklamasi va laboratoriya ko‘rsatkichlari." },
];

const ROLES = [
  { role: "Klinika egasi", panel: "Xodimlar, bo‘limlar, obuna, moliya va hamma sozlamalar" },
  { role: "Administrator / menejer", panel: "Qabullar, kalendar, katalog, suhbatlar, tahlillar" },
  { role: "Qabulxona", panel: "Bemorni topish, “Keldi”, navbat, qabulga yozish" },
  { role: "Kassir", panel: "To‘lovlar, chek, smena yakuni" },
  { role: "Shifokor", panel: "Bugungi bemorlar, klinik yozuvlar, yo‘llanmalar" },
  { role: "Laborant", panel: "Namunalar, natija kiritish va tekshirish" },
];

const STEPS = [
  { icon: Building2, title: "Klinikani ro‘yxatdan o‘tkazing", text: "Nomi, shahar, telefon va o‘zingiz uchun login. Besh daqiqa — 14 kunlik bepul sinov darhol boshlanadi." },
  { icon: KeyRound, title: "Bo‘limlar va xodimlarni qo‘shing", text: "Har bir xodimga login beriladi; u birinchi kirishda o‘z parolini o‘rnatadi va faqat o‘z panelini ko‘radi." },
  { icon: Send, title: "Telegram botni ulang", text: "BotFather’dan olingan bot tokenini kiritasiz — bemorlar shu botdan yozila boshlaydi. Xizmatlar va ish vaqtini sozlaysiz." },
];

const PRIVACY = [
  { icon: EyeOff, title: "Xodim faqat ism va telefonni ko‘radi", text: "Pasport, JSHSHIR, tug‘ilgan sana va manzil xodimlar ekraniga chiqmaydi — ular faqat bemorni aniqlash uchun saqlanadi." },
  { icon: Lock, title: "Klinik yozuvlar — faqat shifokorga", text: "Klinik matnni faqat shu bemorning shifokori (yoki faol yo‘llanma bo‘yicha) o‘qiydi. Qabulxona, kassa va AI ko‘rmaydi." },
  { icon: FileClock, title: "Har bir harakat qayd etiladi", text: "Kim, qachon, nimani o‘zgartirgani audit jurnalida — bemor ma’lumotisiz, faqat identifikatorlar bilan." },
  { icon: Bot, title: "AI tashxis qo‘ymaydi", text: "Bot klinika haqida ma’lumot beradi va yozilishga yo‘naltiradi. Shoshilinch so‘zlarda — tez yordam xabari va administratorga signal." },
];

const FAQ = [
  { q: "Sinov davrida nima bor?", a: "Tanlangan tarifning hamma imkoniyati 14 kun bepul. Karta talab qilinmaydi. Sinov tugaganda ish to‘xtamaydi — panelda to‘lov eslatmasi chiqadi." },
  { q: "Qanday to‘laymiz?", a: "“Obuna” bo‘limida hisob-faktura chiqadi (PDF). Bank o‘tkazmasi bilan to‘laysiz; pul tushgach, obuna faollashadi. Karta orqali to‘lov keyinroq qo‘shiladi." },
  { q: "Pasport ma’lumoti haqiqiyligi qanday tekshiriladi?", a: "Hozir: hujjat formati, JSHSHIR ichidagi tug‘ilgan sana va jins mosligi, telefonning Telegram yoki SMS kod orqali tasdig‘i. Davlat bazasidan tekshirish OneID (id.egov.uz) ulanganda qo‘shiladi — shunda ism, sana va hujjat to‘g‘ridan-to‘g‘ri davlat tizimidan keladi." },
  { q: "Xodimlarda email bo‘lishi shartmi?", a: "Yo‘q. Har bir xodimga login beriladi (masalan, dilnoza.qabul). Hamma bitta sahifadan kiradi va o‘z rolidagi panelga tushadi." },
  { q: "Telegram bo‘lmagan bemorlar-chi?", a: "Ular qabulxonada ro‘yxatga olinadi. Klinika Eskiz bilan shartnoma tuzsa, navbat raqami SMS orqali boradi." },
  { q: "Ma’lumotlarimiz qayerda saqlanadi?", a: "Hozirgi xosting O‘zbekistondan tashqarida. Shaxsiy ma’lumotlarni mahalliylashtirish talablari bo‘yicha yuristingiz bilan maslahatlashing; kerak bo‘lsa, tizim O‘zbekistondagi serverga ko‘chiriladi." },
];

async function plansOrEmpty(): Promise<Plan[]> {
  try {
    return await listPublicPlans();
  } catch {
    return [];
  }
}

export default async function LandingPage() {
  const plans = await plansOrEmpty();
  const draftPrices = plans.some((p) => p.priceIsDraft);
  const featured = plans.length >= 2 ? plans[1].code : plans[0]?.code;

  return (
    <div className="overflow-x-clip">
      <TelegramEntryRedirect />

      {/* ---------- Navigation ---------- */}
      <header className="sticky top-0 z-30 border-b border-hairline/70 bg-[#f7f6f2]/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3 md:px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="brand-tile flex h-8 w-8 items-center justify-center rounded-lg text-white">
              <HeartPulse className="h-4 w-4" />
            </span>
            <span className="font-display text-[15px] font-bold tracking-tight text-foreground">Health AI</span>
          </Link>
          <nav className="hidden items-center gap-5 text-sm text-ink-muted lg:flex">
            <a href="#imkoniyatlar" className="hover:text-foreground">Imkoniyatlar</a>
            <a href="#qanday" className="hover:text-foreground">Qanday ishlaydi</a>
            <a href="#xavfsizlik" className="hover:text-foreground">Xavfsizlik</a>
            <a href="#narxlar" className="hover:text-foreground">Narxlar</a>
            <a href="#savollar" className="hover:text-foreground">Savollar</a>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <Link href="/login" className="rounded-lg px-3 py-2 text-sm font-semibold text-foreground hover:bg-white">
              Kirish
            </Link>
            <Link href="/signup" className="hidden rounded-lg bg-pine px-3.5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-pine-deep sm:inline-flex">
              14 kun bepul
            </Link>
          </div>
        </div>
      </header>

      {/* ---------- Hero ---------- */}
      <section className="relative">
        <svg aria-hidden className="pointer-events-none absolute inset-x-0 top-[46%] -z-0 h-40 w-full opacity-[0.22]" viewBox="0 0 1200 160" preserveAspectRatio="none">
          <path d="M0 80 H420 L450 80 L470 30 L495 135 L520 55 L540 80 H760 L780 80 L795 62 L812 98 L828 80 H1200" fill="none" stroke="#0b6e5c" strokeWidth="2.5" strokeLinejoin="round" />
        </svg>
        <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-4 pb-16 pt-12 md:px-6 md:pt-20 lg:grid-cols-[1.05fr_1fr]">
          <div>
            <p className="font-numeric inline-flex items-center gap-2 rounded-full border border-pine/20 bg-pine-tint px-3 py-1 text-[11px] font-medium uppercase tracking-[0.14em] text-pine-deep">
              <span className="pulse-dot" /> Klinikalar uchun yagona tizim
            </p>
            <h1 className="font-display mt-5 text-[2.35rem] font-bold leading-[1.08] tracking-tight text-foreground md:text-[3.4rem]">
              Bemor Telegram’da yoziladi. <span className="text-pine">Klinika bitta tizimda ishlaydi.</span>
            </h1>
            <p className="mt-5 max-w-xl text-[17px] leading-relaxed text-ink-muted">
              Onlayn qabul va pasport/ID bilan bemorni aniqlashdan tortib qabulxona, navbat, kassa, shifokor ish joyi va laboratoriyagacha. Har bir
              xodim bitta login bilan o‘z paneliga kiradi.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link href="/signup" className="inline-flex items-center gap-2 rounded-xl bg-pine px-5 py-3 text-[15px] font-semibold text-white shadow-[0_10px_24px_-10px_rgba(11,110,92,0.8)] hover:bg-pine-deep">
                Klinikani ulash — 14 kun bepul <ArrowRight className="h-4 w-4" />
              </Link>
              <a href="#qanday" className="rounded-xl border border-hairline bg-white px-5 py-3 text-[15px] font-semibold text-foreground hover:border-pine/40">
                Qanday ishlaydi
              </a>
            </div>
            <ul className="mt-8 grid max-w-xl gap-2.5 text-sm text-foreground sm:grid-cols-3">
              {["Karta talab qilinmaydi", "Xodim ism va telefonni ko‘radi xolos", "AI tashxis qo‘ymaydi"].map((t) => (
                <li key={t} className="flex items-start gap-2">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-pine" /> {t}
                </li>
              ))}
            </ul>
          </div>

          {/* The patient's phone and the clinic's desk side by side: what each side of the system sees. */}
          <div className="relative mx-auto flex w-full max-w-[580px] items-center justify-center gap-4 lg:justify-end">
            <div className="absolute -right-10 top-6 hidden h-72 w-72 rounded-full bg-mint/40 blur-3xl md:block" aria-hidden />
            <div className="relative z-10">
              <PhoneMock />
            </div>
            <div className="relative z-10 hidden w-[300px] shrink-0 flex-col gap-3 sm:flex">
              <FloatingChip icon="shield" title="Shaxs tasdiqlandi" sub="Telefon Telegram orqali" className="self-start" />
              <QueueBoardMock />
              <div className="flex flex-col gap-3">
                <FloatingChip icon="pay" title="Kassa: 180 000 so‘m" sub="A-015 · to‘landi" className="self-end" />
                <FloatingChip icon="lab" title="Natija tayyor" sub="Bemorga Telegram’da yuborildi" className="self-start" />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ---------- A clinic day ---------- */}
      <section className="border-y border-hairline bg-white/70 py-16 sm:mt-10">
        <div className="mx-auto max-w-6xl px-4 md:px-6">
          <p className="font-numeric text-[11px] uppercase tracking-[0.16em] text-pine">Bir kun klinikada</p>
          <h2 className="font-display mt-2 max-w-2xl text-3xl font-bold tracking-tight text-foreground">Bemor yozilgandan natija olguncha — qog‘oz va qayta yozishsiz</h2>
          <ol className="mt-10 grid gap-4 md:grid-cols-5">
            {CLINIC_DAY.map((s, i) => (
              <li key={s.time} className="relative rounded-2xl border border-hairline bg-surface p-4">
                <div className="flex items-center justify-between">
                  <span className="font-numeric text-sm font-semibold text-pine-deep">{s.time}</span>
                  <span className="font-numeric text-[10px] text-ink-muted">0{i + 1}</span>
                </div>
                <s.icon className="mt-3 h-5 w-5 text-pine" />
                <p className="font-display mt-2 text-[15px] font-semibold leading-snug text-foreground">{s.title}</p>
                <p className="mt-1.5 text-[13px] leading-relaxed text-ink-muted">{s.text}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ---------- Modules ---------- */}
      <section id="imkoniyatlar" className="scroll-mt-20 py-20">
        <div className="mx-auto max-w-6xl px-4 md:px-6">
          <p className="font-numeric text-[11px] uppercase tracking-[0.16em] text-pine">Imkoniyatlar</p>
          <h2 className="font-display mt-2 max-w-2xl text-3xl font-bold tracking-tight text-foreground">Klinikaning har bir stoli uchun alohida asbob, bitta bazada</h2>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {MODULES.map((m) => (
              <div key={m.title} className="card-hover rounded-2xl border border-hairline bg-surface p-5">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-pine-tint text-pine-deep">
                  <m.icon className="h-5 w-5" />
                </span>
                <p className="font-display mt-4 font-semibold text-foreground">{m.title}</p>
                <p className="mt-2 text-[13.5px] leading-relaxed text-ink-muted">{m.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- One login, own panel ---------- */}
      <section className="bg-[#10282e] py-20 text-white">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 md:px-6 lg:grid-cols-[1fr_1.2fr]">
          <div>
            <p className="font-numeric text-[11px] uppercase tracking-[0.16em] text-mint">Bitta kirish</p>
            <h2 className="font-display mt-2 text-3xl font-bold tracking-tight">Har bir xodim — o‘z paneli</h2>
            <p className="mt-4 leading-relaxed text-white/70">
              Klinika egasi xodimni qo‘shib, unga login beradi. Xodim bitta sahifadan kiradi, birinchi kirishda o‘z parolini qo‘yadi va faqat o‘z
              ishiga kerakli bo‘limlarni ko‘radi. Ruxsatlar bazada ham, serverda ham tekshiriladi — tugmani yashirish bilan cheklanmaydi.
            </p>
            <div className="mt-6 inline-flex flex-col gap-2 rounded-2xl border border-white/10 bg-white/5 p-4 font-numeric text-sm">
              <span className="text-white/50">health-ai / kirish</span>
              <span>
                Login: <span className="text-mint">dilnoza.qabul</span>
              </span>
              <span>
                Parol: <span className="text-white/60">••••••••••••</span>
              </span>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {ROLES.map((r) => (
              <div key={r.role} className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                <p className="font-display font-semibold">{r.role}</p>
                <p className="mt-1.5 text-sm leading-relaxed text-white/65">{r.panel}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- How it works ---------- */}
      <section id="qanday" className="scroll-mt-20 py-20">
        <div className="mx-auto max-w-6xl px-4 md:px-6">
          <p className="font-numeric text-[11px] uppercase tracking-[0.16em] text-pine">Qanday ishlaydi</p>
          <h2 className="font-display mt-2 text-3xl font-bold tracking-tight text-foreground">Uch qadamda ishga tushadi</h2>
          <div className="mt-10 grid gap-4 md:grid-cols-3">
            {STEPS.map((s, i) => (
              <div key={s.title} className="rounded-2xl border border-hairline bg-surface p-6">
                <div className="flex items-center gap-3">
                  <span className="font-display flex h-9 w-9 items-center justify-center rounded-full bg-pine text-sm font-bold text-white">{i + 1}</span>
                  <s.icon className="h-5 w-5 text-pine" />
                </div>
                <p className="font-display mt-4 text-lg font-semibold text-foreground">{s.title}</p>
                <p className="mt-2 text-sm leading-relaxed text-ink-muted">{s.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- Privacy ---------- */}
      <section id="xavfsizlik" className="scroll-mt-20 border-y border-hairline bg-white/70 py-20">
        <div className="mx-auto max-w-6xl px-4 md:px-6">
          <p className="font-numeric text-[11px] uppercase tracking-[0.16em] text-pine">Xavfsizlik va maxfiylik</p>
          <h2 className="font-display mt-2 max-w-2xl text-3xl font-bold tracking-tight text-foreground">Bemor ma’lumoti faqat kerak bo‘lgan odamga ko‘rinadi</h2>
          <div className="mt-10 grid gap-4 sm:grid-cols-2">
            {PRIVACY.map((p) => (
              <div key={p.title} className="flex gap-4 rounded-2xl border border-hairline bg-surface p-5">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-clay-tint text-clay-deep">
                  <p.icon className="h-5 w-5" />
                </span>
                <div>
                  <p className="font-display font-semibold text-foreground">{p.title}</p>
                  <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">{p.text}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- Pricing ---------- */}
      <section id="narxlar" className="scroll-mt-20 py-20">
        <div className="mx-auto max-w-6xl px-4 md:px-6">
          <p className="font-numeric text-[11px] uppercase tracking-[0.16em] text-pine">Narxlar</p>
          <h2 className="font-display mt-2 text-3xl font-bold tracking-tight text-foreground">Har bir tarif 14 kun bepul</h2>
          <p className="mt-3 max-w-2xl text-ink-muted">
            Oylik to‘lov, bank o‘tkazmasi bilan. Tarifni istalgan vaqtda o‘zgartirasiz.
            {draftPrices && " Narxlar taxminiy — yakuniy narx shartnomada."}
          </p>
          {plans.length === 0 ? (
            <p className="mt-8 rounded-2xl border border-hairline bg-surface p-6 text-ink-muted">Narxlar tez orada e’lon qilinadi. Hozir ro‘yxatdan o‘ting — sinov davri bepul.</p>
          ) : (
            <div className="mt-10 grid gap-4 md:grid-cols-3">
              {plans.map((p) => {
                const hot = p.code === featured;
                return (
                  <div key={p.code} className={`relative flex flex-col rounded-2xl border p-6 ${hot ? "border-pine bg-[#10282e] text-white shadow-[var(--shadow-pop)]" : "border-hairline bg-surface"}`}>
                    {hot && <span className="absolute -top-3 left-6 rounded-full bg-clay px-2.5 py-0.5 text-[11px] font-semibold text-white">Ko‘pchilik tanlovi</span>}
                    <p className="font-display text-xl font-bold">{p.name}</p>
                    <p className={`mt-1 text-sm ${hot ? "text-white/65" : "text-ink-muted"}`}>{p.tagline}</p>
                    <p className="font-display mt-5 text-3xl font-bold">
                      {formatUzs(p.monthlyPriceUzs)}
                      <span className={`text-sm font-normal ${hot ? "text-white/60" : "text-ink-muted"}`}> / oy</span>
                    </p>
                    <p className={`mt-1 text-xs ${hot ? "text-white/60" : "text-ink-muted"}`}>
                      {p.maxStaff ? `${p.maxStaff} tagacha xodim` : "Cheksiz xodim"} · {p.maxDoctors ? `${p.maxDoctors} tagacha shifokor` : "cheksiz shifokor"}
                    </p>
                    <ul className="mt-5 flex flex-1 flex-col gap-2 text-sm">
                      {p.features.map((f) => (
                        <li key={f} className="flex gap-2">
                          <Check className={`mt-0.5 h-4 w-4 shrink-0 ${hot ? "text-mint" : "text-pine"}`} /> {f}
                        </li>
                      ))}
                    </ul>
                    <Link
                      href={`/signup?plan=${p.code}`}
                      className={`mt-6 rounded-xl px-4 py-2.5 text-center text-sm font-semibold ${hot ? "bg-mint text-[#10282e] hover:bg-white" : "bg-pine text-white hover:bg-pine-deep"}`}
                    >
                      Bepul boshlash
                    </Link>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* ---------- FAQ ---------- */}
      <section id="savollar" className="scroll-mt-20 border-t border-hairline bg-white/70 py-20">
        <div className="mx-auto max-w-3xl px-4 md:px-6">
          <p className="font-numeric text-[11px] uppercase tracking-[0.16em] text-pine">Savollar</p>
          <h2 className="font-display mt-2 text-3xl font-bold tracking-tight text-foreground">Ko‘p beriladigan savollar</h2>
          <div className="mt-8 divide-y divide-hairline rounded-2xl border border-hairline bg-surface">
            {FAQ.map((f) => (
              <details key={f.q} className="group px-5 py-4">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-semibold text-foreground">
                  {f.q}
                  <span className="text-pine transition group-open:rotate-45">+</span>
                </summary>
                <p className="mt-3 text-sm leading-relaxed text-ink-muted">{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- Final call ---------- */}
      <section className="py-20">
        <div className="mx-auto max-w-6xl px-4 md:px-6">
          <div className="relative overflow-hidden rounded-3xl bg-pine px-6 py-12 text-white md:px-12">
            <svg aria-hidden className="absolute inset-x-0 bottom-0 h-24 w-full opacity-25" viewBox="0 0 1200 100" preserveAspectRatio="none">
              <path d="M0 60 H500 L525 60 L545 15 L570 90 L592 40 L610 60 H1200" fill="none" stroke="#9bd8c9" strokeWidth="3" />
            </svg>
            <h2 className="font-display relative max-w-2xl text-3xl font-bold tracking-tight md:text-4xl">Klinikangizni bugun ulang</h2>
            <p className="relative mt-3 max-w-xl text-white/80">Besh daqiqada ro‘yxatdan o‘tasiz, xodimlarni qo‘shasiz va Telegram botni ulaysiz. 14 kun bepul, karta talab qilinmaydi.</p>
            <div className="relative mt-8 flex flex-wrap gap-3">
              <Link href="/signup" className="inline-flex items-center gap-2 rounded-xl bg-white px-5 py-3 font-semibold text-pine-deep hover:bg-mint">
                Ro‘yxatdan o‘tish <ArrowRight className="h-4 w-4" />
              </Link>
              <Link href="/login" className="rounded-xl border border-white/30 px-5 py-3 font-semibold text-white hover:bg-white/10">
                Xodimlar uchun kirish
              </Link>
            </div>
          </div>
        </div>
      </section>

      <footer className="border-t border-hairline py-10">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 text-sm text-ink-muted md:px-6">
          <span className="flex items-center gap-2">
            <span className="brand-tile flex h-6 w-6 items-center justify-center rounded-md text-white">
              <HeartPulse className="h-3 w-3" />
            </span>
            <span className="font-display font-semibold text-foreground">Health AI</span>
          </span>
          <span>Ilova tibbiy tashxis qo‘ymaydi va davolash tavsiya qilmaydi.</span>
          <span className="ml-auto flex gap-4">
            <Link href="/privacy" className="hover:text-foreground">Maxfiylik siyosati</Link>
            <Link href="/login" className="hover:text-foreground">Kirish</Link>
          </span>
        </div>
      </footer>
    </div>
  );
}
