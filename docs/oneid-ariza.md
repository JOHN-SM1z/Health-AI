# OneID tizimiga ulanish uchun ariza (namuna)

> Kompaniya blankasida chop eting, imzolang va id.egov.uz saytida ko‘rsatilgan OneID operatoriga yuboring.
> Qavs ichidagilarni o‘zingizning ma’lumotlaringiz bilan to‘ldiring.

**Kimga:** OneID — yagona identifikatsiya tizimi operatoriga

**Kimdan:** [Kompaniya nomi] MChJ, STIR: [STIR], manzil: [manzil], direktor: [F.I.Sh.], tel.: [telefon]

**Mavzu:** "Health AI" axborot tizimini OneID yagona identifikatsiya tizimiga ulash to‘g‘risida

Hurmatli rahbar!

[Kompaniya nomi] MChJ tibbiyot klinikalari uchun "Health AI" axborot tizimini ishlab chiqadi va qo‘llab-quvvatlaydi.
Tizim orqali bemorlar Telegram ilovasi yordamida klinikalarga onlayn qabulga yoziladi.

Bemorning shaxsini ishonchli aniqlash va tibbiy kartadagi shaxsiy ma’lumotlarning to‘g‘riligini ta’minlash uchun
"Health AI" tizimini OneID yagona identifikatsiya tizimiga nodavlat tashkilot sifatida ulashingizni so‘raymiz.

**Ulanish maqsadi:** bemor birinchi marta onlayn yozilayotganda uning shaxsini OneID orqali tasdiqlash (login va parol,
elektron raqamli imzo yoki telefon raqami orqali; biometrik tekshiruvsiz).

**So‘raladigan ma’lumotlar (faqat shular):**
- JSHSHIR (`pin`);
- pasport yoki ID karta seriyasi va raqami (`pport_no`);
- familiya, ism, otasining ismi (`sur_name`, `first_name`, `mid_name`);
- tug‘ilgan sana (`birth_date`) va jins (`gd`);
- doimiy yashash manzili (`per_adr`);
- profil tasdiqlanganlik belgisi (`valid`).

**Qaytish manzili (redirect URI):** `https://[sizning domeningiz]/api/oneid/callback`

**Ma’lumotlarni himoya qilish:**
- ma’lumotlar faqat bemor murojaat qilgan klinikaning bazasida saqlanadi;
- klinika xodimlari pasport, JSHSHIR, tug‘ilgan sana va manzilni ko‘rmaydi; ular faqat bemorning ismi va telefonini
  ko‘radi;
- ma’lumotlar jurnallarga (log), tahlillarga va uchinchi shaxslarga berilmaydi; har bir murojaat audit jurnalida qayd
  etiladi (qiymatlarsiz);
- barcha aloqa TLS (HTTPS) orqali amalga oshiriladi;
- bemor ma’lumotlarini qayta ishlashga roziligini ilovada beradi.

Ulanish shartlari, texnik hujjatlar, test muhiti hamda `client_id`, `client_secret` va `scope` qiymatlarini taqdim
etishingizni so‘raymiz.

**Mas’ul shaxs:** [F.I.Sh.], [lavozimi], tel.: [telefon], e-mail: [e-mail]

Hurmat bilan,
Direktor ______________ [F.I.Sh.]
[Sana]
