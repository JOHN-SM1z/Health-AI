import type { Metadata } from "next";
import { Card, SectionTitle } from "@/components/mini-app/ui";

export const metadata: Metadata = { title: "Maxfiylik siyosati" };

export default function PrivacyPage() {
  return (
    <div className="flex flex-col gap-4">
      <SectionTitle>Maxfiylik siyosati</SectionTitle>
      <Card className="flex flex-col gap-4 text-sm leading-relaxed text-[var(--tg-hint,#475569)]">
        <div>
          <p className="font-medium text-[var(--tg-text,#0f172a)]">1. Qanday ma‘lumotlar yig‘iladi</p>
          <p className="mt-1">
            Telegram foydalanuvchi identifikatori, ismingiz, telefon raqamingiz va qabul
            ma‘lumotlari. Faqat qabul jarayonini tashkil qilish uchun.
          </p>
        </div>
        <div>
          <p className="font-medium text-[var(--tg-text,#0f172a)]">2. Ovozli xabarlar</p>
          <p className="mt-1">
            Ovozli xabarlar faqat sizning ruxsatingiz bilan matnga aylantiriladi. Xabarlar
            himoyalangan saqlashda yuritiladi va belgilangan muddatdan keyin o‘chiriladi.
          </p>
        </div>
        <div>
          <p className="font-medium text-[var(--tg-text,#0f172a)]">3. Kimga beriladi</p>
          <p className="mt-1">
            Ma‘lumotlar faqat klinika xodimlariga (qabul tashkil qilish uchun) ko‘rsatiladi.
            Uchinchi shaxslarga berilmaydi.
          </p>
        </div>
        <div>
          <p className="font-medium text-[var(--tg-text,#0f172a)]">4. Tibbiy ma‘lumotlar</p>
          <p className="mt-1">
            Bu tizim tibbiy tashxis qo‘ymaydi va klinik hujjatlar yuritmaydi. Sog‘lig‘ingiz
            haqidagi qarorlar faqat shifokor bilan.
          </p>
        </div>
        <div>
          <p className="font-medium text-[var(--tg-text,#0f172a)]">5. Huquqingiz</p>
          <p className="mt-1">
            Ma‘lumotlaringizni o‘chirishni so‘rash huquqingiz bor — operatorlarga murojaat qiling.
          </p>
        </div>
      </Card>
    </div>
  );
}