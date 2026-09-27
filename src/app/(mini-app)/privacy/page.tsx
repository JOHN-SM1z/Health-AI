import type { Metadata } from "next";
import { Card, SectionTitle } from "@/components/mini-app/ui";

export const metadata: Metadata = { title: "Maxfiylik siyosati" };

export default function PrivacyPage() {
  return (
    <div className="flex flex-col gap-4">
      <SectionTitle>Maxfiylik siyosati</SectionTitle>
      <Card className="flex flex-col gap-4 text-sm leading-relaxed text-[var(--tg-hint,#475569)]">
        <div>
          <p className="font-medium text-[var(--tg-text,var(--foreground))]">1. Qanday ma‘lumotlar yig‘iladi</p>
          <p className="mt-1">
            Telegram foydalanuvchi identifikatori, ismingiz, telefon raqamingiz va qabul
            ma‘lumotlari. Faqat qabul jarayonini tashkil qilish uchun.
          </p>
        </div>
        <div>
          <p className="font-medium text-[var(--tg-text,var(--foreground))]">2. Ovozli xabarlar</p>
          <p className="mt-1">
            Ovozli xabarlar faqat sizning ruxsatingiz bilan matnga aylantiriladi. Xabarlar
            himoyalangan saqlashda yuritiladi va belgilangan muddatdan keyin o‘chiriladi.
          </p>
        </div>
        <div>
          <p className="font-medium text-[var(--tg-text,var(--foreground))]">3. Kimga beriladi</p>
          <p className="mt-1">
            Ma‘lumotlar faqat klinika xodimlariga (qabul tashkil qilish uchun) ko‘rsatiladi.
            Shifokoringiz sizni klinikadagi boshqa shifokorga yo‘llasa, qabul qiluvchi shifokor
            ham ularni ko‘radi. Uchinchi shaxslarga berilmaydi.
          </p>
        </div>
        <div>
          <p className="font-medium text-[var(--tg-text,var(--foreground))]">4. Tibbiy ma‘lumotlar</p>
          <p className="mt-1">
            Bu tizim tibbiy tashxis qo‘ymaydi, bot esa tibbiy maslahat bermaydi. Sog‘lig‘ingiz
            haqidagi qarorlar faqat shifokor bilan.
          </p>
          <p className="mt-1">
            Shifokor sizni klinikadagi boshqa shifokorga yo‘llasa, yo‘llanma sababi va hamkasbi uchun
            izoh yozadi. Ularni faqat shu ikki shifokor ko‘radi; qabulxona faqat kimga yo‘llanganingizni
            va yo‘llanma holatini ko‘radi. Qabul qiluvchi shifokor yo‘llanmani qabul qilgach, yo‘llagan
            shifokor bilan bo‘lgan qabullaringiz ro‘yxatini (sana, xizmat, holat) ko‘radi.
          </p>
        </div>
        <div>
          <p className="font-medium text-[var(--tg-text,var(--foreground))]">5. Huquqingiz</p>
          <p className="mt-1">
            Ma‘lumotlaringizni o‘chirishni so‘rash huquqingiz bor — operatorlarga murojaat qiling.
          </p>
        </div>
      </Card>
    </div>
  );
}