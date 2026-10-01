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
            Ma‘lumotlar faqat klinika xodimlariga (qabul tashkil qilish uchun) va sizni davolayotgan
            shifokorlarga ko‘rsatiladi (5-bandga qarang). Uchinchi shaxslarga berilmaydi.
          </p>
        </div>
        <div>
          <p className="font-medium text-[var(--tg-text,var(--foreground))]">4. Tibbiy yozuvlar</p>
          <p className="mt-1">
            Bu tizim tibbiy tashxis qo‘ymaydi, bot esa tibbiy maslahat bermaydi. Sog‘lig‘ingiz
            haqidagi qarorlarni faqat shifokor qabul qiladi.
          </p>
          <p className="mt-1">
            Qabul davomida shifokoringiz tizimga tibbiy yozuvlar kiritishi mumkin: klinik qayd va
            baho, tashxis, retsept, tahlilga yo‘llanma va tahlil natijalari, anamnez, keyingi
            qadamlar. Har bir yozuvda uni qaysi shifokor, qaysi qabulda va qachon yozgani saqlanadi.
          </p>
          <p className="mt-1">
            Yozuvni faqat uni yozgan shifokor tuzata oladi. Tuzatish yozuvning yangi versiyasi
            sifatida saqlanadi; oldingi versiya o‘chirilmaydi va yozuv tarixida qoladi. Boshqa
            shifokor birovning yozuvini o‘zgartira olmaydi — o‘z xulosasini o‘z qabulida alohida
            yozuv sifatida kiritadi.
          </p>
        </div>
        <div>
          <p className="font-medium text-[var(--tg-text,var(--foreground))]">5. Tibbiy yozuvlarni kim ko‘radi</p>
          <p className="mt-1">
            Tibbiy yozuvlaringiz klinikadagi yagona tibbiy tarixingizni tashkil qiladi. Uni sizni
            davolayotgan shifokorlar ko‘radi: siz qabulida bo‘lgan yoki qabuliga yozilgan shifokor,
            sizni yo‘llanma bilan qabul qilayotgan shifokor va — yo‘llanma bo‘limga berilgan bo‘lsa —
            shu bo‘lim shifokorlari. Ular tarixingizni boshqa shifokordan ruxsat so‘ramasdan ko‘radi,
            shuning uchun har qabulda kasallik tarixingizni qaytadan aytib berishingiz shart emas.
          </p>
          <p className="mt-1">
            Qabulxona, boshqa xodimlar, bot va sun‘iy intellekt tibbiy yozuvlarni ko‘rmaydi; siz bilan
            bog‘liq qabul yoki yo‘llanmasi bo‘lmagan shifokor ham ko‘rmaydi.
          </p>
          <p className="mt-1">
            Shifokor sizni boshqa shifokorga yoki bo‘limga yo‘llasa, yo‘llanma sababi va izohi ham
            tibbiy tarixingizga kiradi. Qabulxona esa faqat sizni kim kimga yo‘llaganini, yo‘llanma
            holati, muhimligi va sanalarini hamda shu yo‘llanma bo‘yicha qabul vaqtini ko‘radi.
          </p>
          <p className="mt-1">
            Faqat yo‘llanmaga asoslangan kirish yo‘llanma rad etilganda, bekor qilinganda yoki
            muddati tugaganda (ko‘pi bilan 180 kun) to‘xtaydi. Siz qabulida bo‘lgan yoki qabuliga
            yozilgan shifokor esa davolashni davom ettirish uchun tarixingizni keyinchalik ham ko‘ra oladi.
          </p>
          <p className="mt-1">
            Shifokorlar to‘lovlaringiz tarixini ko‘rmaydi — faqat ular bilan bo‘layotgan qabulning
            to‘lov holatini ko‘radi. Yozishmalaringiz shifokorlarga ko‘rsatilmaydi. Tibbiy yozuvlarni
            ko‘rish kirish jurnalida qayd etiladi.
          </p>
        </div>
        <div>
          <p className="font-medium text-[var(--tg-text,var(--foreground))]">6. Saqlash</p>
          <p className="mt-1">
            Tibbiy yozuvlaringiz, qabullaringiz, to‘lovlaringiz yoki yo‘llanmalaringiz bor ekan,
            profilingiz ular bilan birga o‘chirib yuborilmaydi. Bu ma‘lumotlar va profilingizdagi
            ma‘lumotlar qancha muddat saqlanishi klinika tasdiqlagan tartib bilan belgilanadi; bunday
            tartib belgilanmaguncha ular saqlanib turadi. Kirish jurnali ham alohida saqlanadi.
          </p>
        </div>
        <div>
          <p className="font-medium text-[var(--tg-text,var(--foreground))]">7. Huquqingiz</p>
          <p className="mt-1">
            Ma‘lumotlaringizni o‘chirishni so‘rash huquqingiz bor — klinika operatorlariga murojaat
            qiling. So‘rovni klinika ko‘rib chiqadi: tibbiy yozuvlar, qabullar va to‘lovlar yuqoridagi
            saqlash tartibiga ko‘ra alohida hal qilinadi.
          </p>
        </div>
      </Card>
    </div>
  );
}