import { HeartPulse, ShieldCheck, Check, FlaskConical, Wallet, Clock3, Stethoscope } from "lucide-react";

/**
 * Product pictures for the landing page, drawn in the product's own components and colours (no screenshots, so they
 * never go stale or show a real patient). Every name and number on them is illustrative.
 */

export function PhoneMock() {
  return (
    <div className="relative w-[248px] shrink-0 rounded-[2.2rem] border border-[#0f2f35]/10 bg-[#10282e] p-2.5 shadow-[0_30px_80px_-20px_rgba(7,84,72,0.45)]">
      <div className="overflow-hidden rounded-[1.75rem] bg-[#f7f6f2]">
        <div className="flex items-center justify-between bg-white px-4 pb-2 pt-3">
          <span className="text-[11px] font-semibold text-[#10282e]">Health AI</span>
          <span className="rounded-full bg-[#e1f0eb] px-2 py-0.5 text-[9px] font-semibold text-[#075448]">Mini App</span>
        </div>
        <div className="flex flex-col gap-2.5 px-4 pb-5 pt-4">
          <p className="font-numeric text-[9px] uppercase tracking-[0.16em] text-[#5d6b6e]">Shaxsni tasdiqlash</p>
          <p className="font-display text-[15px] font-bold leading-tight text-[#10282e]">Shaxsingizni kiriting</p>
          <div className="rounded-xl border border-[#e9e6df] bg-white px-3 py-2">
            <p className="text-[9px] text-[#5d6b6e]">Pasport / ID karta yoki JSHSHIR</p>
            <p className="font-numeric text-[12px] font-semibold tracking-wider text-[#10282e]">AD 4 1 2 • • • •</p>
          </div>
          <div className="rounded-xl border border-[#e9e6df] bg-white px-3 py-2">
            <p className="text-[9px] text-[#5d6b6e]">Tug‘ilgan sana</p>
            <p className="font-numeric text-[12px] font-semibold text-[#10282e]">14.03.1987</p>
          </div>
          <div className="flex items-start gap-2 rounded-xl bg-[#e1f0eb] px-3 py-2">
            <span className="mt-0.5 flex h-3.5 w-3.5 items-center justify-center rounded bg-[#0b6e5c]">
              <Check className="h-2.5 w-2.5 text-white" strokeWidth={3} />
            </span>
            <p className="text-[9.5px] leading-snug text-[#075448]">Telefon raqami Telegram orqali tasdiqlandi</p>
          </div>
          <div className="mt-1 rounded-xl bg-[#0b6e5c] py-2.5 text-center text-[12px] font-semibold text-white">Davom etish</div>
          <p className="text-center text-[8.5px] leading-snug text-[#5d6b6e]">Xodimlar faqat ism va telefonni ko‘radi</p>
        </div>
      </div>
    </div>
  );
}

const QUEUE = [
  { n: "A-014", who: "Karimova D.", doc: "Terapevt", time: "09:30", state: "Qabulda", tone: "bg-[#e1f0eb] text-[#075448]" },
  { n: "A-015", who: "Rasulov B.", doc: "Terapevt", time: "09:45", state: "Keldi", tone: "bg-[#e6eefa] text-[#2e6fbf]" },
  { n: "K-007", who: "Yusupova M.", doc: "Kardiolog", time: "10:00", state: "Onlayn yozilgan", tone: "bg-[#efe9f8] text-[#6d4aa8]" },
  { n: "L-021", who: "Aliyev S.", doc: "Laboratoriya", time: "10:10", state: "Namuna olindi", tone: "bg-[#fbeae2] text-[#a35532]" },
];

export function QueueBoardMock() {
  return (
    <div className="w-full max-w-[440px] rounded-2xl border border-[#e9e6df] bg-white p-3.5 shadow-[0_24px_60px_-24px_rgba(16,40,46,0.35)]">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="brand-tile flex h-7 w-7 items-center justify-center rounded-lg text-white">
            <HeartPulse className="h-3.5 w-3.5" />
          </span>
          <div>
            <p className="font-display text-[12px] font-bold text-[#10282e]">Qabulxona — bugungi navbat</p>
            <p className="text-[10px] text-[#5d6b6e]">Slot vaqti bo‘yicha, jonli</p>
          </div>
        </div>
        <span className="pulse-dot" />
      </div>
      <div className="flex flex-col divide-y divide-[#e9e6df]">
        {QUEUE.map((q) => (
          <div key={q.n} className="flex items-center gap-3 py-2">
            <span className="font-numeric w-12 text-[12px] font-bold text-[#10282e]">{q.n}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[11.5px] font-medium text-[#10282e]">{q.who}</p>
              <p className="text-[10px] text-[#5d6b6e]">
                {q.doc} · {q.time}
              </p>
            </div>
            <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[9.5px] font-semibold ${q.tone}`}>{q.state}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function FloatingChip({ icon, title, sub, className = "" }: { icon: "lab" | "pay" | "shield"; title: string; sub: string; className?: string }) {
  const Icon = icon === "lab" ? FlaskConical : icon === "pay" ? Wallet : ShieldCheck;
  const tint = icon === "lab" ? "bg-[#fbeae2] text-[#a35532]" : icon === "pay" ? "bg-[#e6eefa] text-[#2e6fbf]" : "bg-[#e1f0eb] text-[#075448]";
  return (
    <div className={`flex items-center gap-2.5 rounded-2xl border border-[#e9e6df] bg-white/95 px-3 py-2.5 shadow-[0_14px_36px_-14px_rgba(16,40,46,0.35)] backdrop-blur ${className}`}>
      <span className={`flex h-8 w-8 items-center justify-center rounded-xl ${tint}`}>
        <Icon className="h-4 w-4" />
      </span>
      <div>
        <p className="text-[11.5px] font-semibold text-[#10282e]">{title}</p>
        <p className="text-[10px] text-[#5d6b6e]">{sub}</p>
      </div>
    </div>
  );
}

/** One clinic day, the way the system carries it — the landing page's walk-through. */
export const CLINIC_DAY = [
  { time: "08:12", icon: ShieldCheck, title: "Bemor Telegram’da yoziladi", text: "Pasport/ID yoki JSHSHIR va tug‘ilgan sana, telefon Telegram orqali tasdiqlanadi. Shikoyatini yozadi — tizim mos shifokorni taklif qiladi, bemor o‘zi tanlaydi." },
  { time: "09:41", icon: Clock3, title: "Qabulxonada “Keldi”", text: "Onlayn yozilgan bemor ro‘yxatda tayyor turadi. Navbat raqami slot vaqti bo‘yicha, jonli navbat ekrani zalda." },
  { time: "09:44", icon: Wallet, title: "Kassa", text: "Narx xizmatlar katalogidan olinadi, to‘lov va smena hisobi kassada. Brauzerdan hech kim “to‘landi” deb belgilay olmaydi." },
  { time: "10:02", icon: Stethoscope, title: "Shifokor qabuli", text: "Shifokor o‘z bemorlarini ko‘radi: klinik yozuvlar, tahlil buyurtmasi, boshqa shifokorga yo‘llanma — hammasi muallifi va vaqti bilan." },
  { time: "11:30", icon: FlaskConical, title: "Tahlil natijasi", text: "Laborant natijani kiritadi, tekshiradi. Tasdiqlangan natija bemorga Telegram’da, PDF bilan yetib boradi." },
] as const;
