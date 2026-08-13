import Link from "next/link";
import { HeartPulse, CalendarCheck, MessageCircleQuestion, UserRound } from "lucide-react";
import { Card } from "@/components/mini-app/ui";

/**
 * Patient landing page. In production this is a Mini App entry point and a
 * public web page; the primary path is the Telegram bot.
 */
export default function HomePage() {
  return (
    <div className="flex flex-col gap-6 pt-6">
      <div className="text-center">
        <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-2xl bg-[var(--tg-button,#16a34a)] text-white">
          <HeartPulse className="h-8 w-8" />
        </div>
        <h1 className="text-2xl font-bold text-[var(--tg-text,#0f172a)]">Health AI</h1>
        <p className="mt-1 text-sm text-[var(--tg-hint,#64748b)]">
          Klinika qabuliga yozilish va ma‘lumot olish
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <Link href="/book" className="w-full">
          <Card className="flex items-center gap-3 p-4 transition-colors hover:bg-[var(--tg-secondary-bg,#f1f5f9)]">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-green-100 text-green-700">
              <CalendarCheck className="h-5 w-5" />
            </span>
            <div>
              <p className="font-medium text-[var(--tg-text,#0f172a)]">Qabulga yozilish</p>
              <p className="text-xs text-[var(--tg-hint,#64748b)]">Xizmat va vaqtni tanlang</p>
            </div>
          </Card>
        </Link>
        <Link href="/my-appointments" className="w-full">
          <Card className="flex items-center gap-3 p-4 transition-colors hover:bg-[var(--tg-secondary-bg,#f1f5f9)]">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-100 text-blue-700">
              <UserRound className="h-5 w-5" />
            </span>
            <div>
              <p className="font-medium text-[var(--tg-text,#0f172a)]">Mening qabullarim</p>
              <p className="text-xs text-[var(--tg-hint,#64748b)]">Qabullarni ko‘rish va boshqarish</p>
            </div>
          </Card>
        </Link>
        <Link href="/help" className="w-full">
          <Card className="flex items-center gap-3 p-4 transition-colors hover:bg-[var(--tg-secondary-bg,#f1f5f9)]">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-100 text-amber-700">
              <MessageCircleQuestion className="h-5 w-5" />
            </span>
            <div>
              <p className="font-medium text-[var(--tg-text,#0f172a)]">Yordam</p>
              <p className="text-xs text-[var(--tg-hint,#64748b)]">Ko‘p so‘raladigan savollar</p>
            </div>
          </Card>
        </Link>
      </div>

      <p className="text-center text-xs text-[var(--tg-hint,#64748b)]">
        Bu ilova tibbiy tashxis qo‘ymaydi va davolash tavsiya qilmaydi.
      </p>
    </div>
  );
}