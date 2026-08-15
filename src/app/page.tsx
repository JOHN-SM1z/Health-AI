import Link from "next/link";
import { HeartPulse, CalendarCheck, MessageCircleQuestion, UserRound } from "lucide-react";
import { Card, Eyebrow } from "@/components/mini-app/ui";

/**
 * Patient landing page. In production this is a Mini App entry point and a
 * public web page; the primary path is the Telegram bot.
 */
export default function HomePage() {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6 px-4 pb-10 pt-4">
      <div className="pt-2">
        <div className="text-center">
          <div className="brand-tile mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl text-white">
            <HeartPulse className="h-8 w-8" />
          </div>
          <Eyebrow>Health AI Namuna Klinikasi</Eyebrow>
          <h1 className="font-display mt-1.5 text-2xl font-bold tracking-tight text-[var(--tg-text,var(--foreground))]">
            Health AI
          </h1>
          <p className="mt-1 text-sm text-[var(--tg-hint,#8a9699)]">
            Klinika qabuliga yozilish va ma‘lumot olish
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <Link href="/book" className="w-full">
          <Card className="card-hover flex items-center gap-3 p-4">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--pine-tint)] text-[var(--pine-deep)]">
              <CalendarCheck className="h-5 w-5" />
            </span>
            <div>
              <p className="font-display font-semibold text-[var(--tg-text,var(--foreground))]">
                Qabulga yozilish
              </p>
              <p className="text-xs text-[var(--tg-hint,#8a9699)]">Xizmat va vaqtni tanlang</p>
            </div>
          </Card>
        </Link>
        <Link href="/my-appointments" className="w-full">
          <Card className="card-hover flex items-center gap-3 p-4">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--info-tint)] text-[var(--info)]">
              <UserRound className="h-5 w-5" />
            </span>
            <div>
              <p className="font-display font-semibold text-[var(--tg-text,var(--foreground))]">
                Mening qabullarim
              </p>
              <p className="text-xs text-[var(--tg-hint,#8a9699)]">Qabullarni ko‘rish va boshqarish</p>
            </div>
          </Card>
        </Link>
        <Link href="/help" className="w-full">
          <Card className="card-hover flex items-center gap-3 p-4">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--clay-tint)] text-[var(--clay)]">
              <MessageCircleQuestion className="h-5 w-5" />
            </span>
            <div>
              <p className="font-display font-semibold text-[var(--tg-text,var(--foreground))]">
                Yordam
              </p>
              <p className="text-xs text-[var(--tg-hint,#8a9699)]">Ko‘p so‘raladigan savollar</p>
            </div>
          </Card>
        </Link>
      </div>

      <p className="text-center text-xs text-[var(--tg-hint,#8a9699)]">
        Bu ilova tibbiy tashxis qo‘ymaydi va davolash tavsiya qilmaydi.
      </p>
    </div>
  );
}