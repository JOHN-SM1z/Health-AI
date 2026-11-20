import type { Metadata } from "next";
import { Card, SectionTitle } from "@/components/mini-app/ui";
import Link from "next/link";

export const metadata: Metadata = { title: "Yordam" };

export default function HelpPage() {
  return (
    <div className="flex flex-col gap-4">
      <SectionTitle>Yordam</SectionTitle>
      <Card className="flex flex-col gap-3 text-sm leading-relaxed text-[var(--tg-text,var(--foreground))]">
        <div>
          <p className="font-medium">Qabulga qanday yozilaman?</p>
          <p className="mt-1 text-[var(--tg-hint,#475569)]">
            “Qabulga yozilish” tugmasini bosing → xizmatni tanlang → bo‘sh vaqtni belgilang →
            ma‘lumotlaringizni kiriting → tasdiqlang. Tasdiq va eslatmalar Telegram orqali keladi.
          </p>
        </div>
        <div>
          <p className="font-medium">Qaysi shifokorga murojaat qilishni bilmayman</p>
          <p className="mt-1 text-[var(--tg-hint,#475569)]">
            Botdagi “Shifokor tanlashda yordam” bo‘limidan foydalaning — u yo‘nalishni aniqlashga
            yordam beradi. Bu tibbiy tashxis emas.
          </p>
        </div>
        <div>
          <p className="font-medium">Shoshilinch holat</p>
          <p className="mt-1 text-[var(--tg-hint,#475569)]">
            Bu xizmat shoshilinch yordam uchun emas. Shoshilinch holatda mahalliy tez yordam
            xizmatiga murojaat qiling yoki zudlik bilan shifokorga boring.
          </p>
        </div>
        <div>
          <p className="font-medium">Qabulni bekor qilish</p>
          <p className="mt-1 text-[var(--tg-hint,#475569)]">
            “Mening qabullarim” sahifasidan qabulni bekor qilishingiz mumkin.
          </p>
        </div>
        <Link href="/privacy" className="underline">
          Maxfiylik siyosati
        </Link>
      </Card>
    </div>
  );
}