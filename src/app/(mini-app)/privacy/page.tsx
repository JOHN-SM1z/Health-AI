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
            ma‘lumotlari qabul jarayonini tashkil qilish uchun yig‘iladi. Shifokorlar davolash davomida tibbiy yozuvlar ham kiritishi mumkin.
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
            Tibbiy yozuvlarni faqat sizni davolayotgan shifokorlar ko‘radi. Qabulxona, boshqa
            xodimlar, bot va sun‘iy intellekt ularni ko‘rmaydi.
          </p>
          <p className="mt-1">
            Shifokor sizni klinikadagi boshqa shifokorga yo‘llasa, yo‘llanma sababi va hamkasbi uchun
            izohni bemorni davolashga vakolatli shifokorlar ko‘radi; qabulxona esa faqat sizni kim kimga yo‘llaganini,
            yo‘llanma holati, muhimligi va sanalarini hamda shu yo‘llanma bo‘yicha qabul vaqtini ko‘radi.
          </p>
          <p className="mt-1">
            Faol yo‘llanma yoki siz bilan belgilangan qabul mavjud bo‘lsa, shifokor shu klinikadagi
            oldingi qabullar va tibbiy yozuvlaringizni darhol ko‘radi. Yo‘llanmani qabul qilish
            alohida ruxsat olish sharti emas. Keyingi tashrifda boshqa shifokor ham mavjud
            bemor kartangiz orqali tarixni ko‘radi; oldingi shifokordan qayta ruxsat talab etilmaydi.
            Bu kirish to‘lovlaringiz va yozishmalaringizni ochib bermaydi.
          </p>
          <p className="mt-1">
            Faqat yo‘llanma bilan berilgan kirish yo‘llanma rad etilganda, bekor qilinganda,
            yakunlanganda yoki muddati tugaganda (ko‘pi bilan 180 kun) to‘xtaydi. Mustaqil qabul
            yoki davolash aloqasi mavjud bo‘lsa, tibbiy tarixga kirish saqlanadi.
            Tibbiy yozuvlarni ko‘rish kirish jurnalida qayd etiladi.
          </p>
        </div>
        <div>
          <p className="font-medium text-[var(--tg-text,var(--foreground))]">6. Saqlash</p>
          <p className="mt-1">
            Tibbiy yozuvlaringiz, qabullaringiz, to‘lovlaringiz, yozishmalaringiz yoki yo‘llanmalaringiz bor ekan,
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