# Health AI — sahifalar va elementlar inventari

Manba: `src/app/**`, `src/components/**`, `src/app/globals.css` (2026-10-10 holati).
Stack: Next.js 16 + Tailwind 4 + lucide-react ikonlar. Shriftlar: Inter (matn), Sora (sarlavha), JetBrains Mono (raqamlar).

---

## 0. Hozirgi dizayn tizimi

**Ranglar (globals.css):** sand `#f7f6f2` fon · ink `#10282e` matn · pine `#0b6e5c` asosiy · pine-deep `#075448` · pine-tint `#e1f0eb` · mint `#9bd8c9` · clay `#d97b54` (ogohlantirish) · danger `#c2402e` · info `#2e6fbf` · hairline `#e9e6df`.

**Imzo elementlari:** HeartPulse logotip "brand-tile" (yashil gradient + mint halo) · jonli `pulse-dot` · mono shriftdagi talon raqami (`047`) · mono uppercase "eyebrow" yozuvlar.

**Komponentlar:**
| Bemor (Mini App) `components/mini-app/ui.tsx` | Xodim paneli `components/admin/ui.tsx` |
|---|---|
| Button: primary, secondary, outline, ghost, danger, success · o'lcham sm/md/lg/full · loading spinner | AButton: primary, secondary, outline, ghost, danger |
| Card, Input, Badge (neutral, green, red, amber, blue, gray, pine) | AInput, ASelect, ATextArea, ABadge, ATable, AModal |
| Spinner, EmptyState, Eyebrow, SectionTitle | PageHeader (sarlavha + subtitle + action), StatCard (pine/clay/info/neutral), AEmpty, AError, LoadingRow |
| ErrorBanner (⚠️), NoticeBanner (ℹ️) | NavLink (sidebar, aktiv holat pine-tint) |

---

## 1. Ommaviy / bemor sahifalari (Telegram Mini App)

Umumiy shell: tepada ← orqaga (klinika bosh sahifasi) + "Health AI" logotip. Kenglik max 448px (mobil).

### `/` — Klinika bosh sahifasi
- HeartPulse ikon, Eyebrow: klinika nomi, H1 "Klinika ma'lumotlari", qisqa tavsif (rejimga qarab)
- Karta-link: **"Manzil, narxlar va savollar"** → `/help`
- (Faqat oldindan yozilish rejimida) **"Qabulga yozilish →"**, **"Mening qabullarim →"**
- Pastki disclaimer: "AI tibbiy tashxis qo'ymaydi…"

### `/help` — Klinika ma'lumotlari
- Karta 1: rejim matni, Manzil, Telefon, haftalik ish vaqti, link **"Qabulga yozilish"**
- Karta 2: "Xizmatlar va narxlar" ro'yxati (nom — narx, tayyorgarlik matni)
- Karta 3: FAQ (savol/javob)
- Karta 4: "Shoshilinch holat" ogohlantirish
- Link **"Maxfiylik siyosati"**

### `/book` — Qabulga yozilish (7 qadamli wizard)
Tepada qadam ko'rsatkichi: `1/7 · Rozilik` … `Tasdiqlash` · `Natija`
1. **Rozilik:** 2 ta info karta + checkbox "Shaxsiy ma'lumotlarimni… roziman" + **[Davom etish]** (checkbox'siz disabled)
2. **Tanlov:** **[🩺 Kerakli xizmatni bilaman]** **[🤔 Tanlashda yordam kerak]**
3. **Xizmat:** (yordam rejimida) yo'nalish chiplari **[Barcha xizmatlar]** + har bir yo'nalish · xizmat kartalari (nom, narx badge, davomiylik, tavsif)
4. **Shifokor:** shifokor kartalari (ism, lavozim)
5. **Vaqt:** kunlar bo'yicha guruhlangan 3 ustunli vaqt tugmalari · **[Davom etish: 10:30]**
6. **Ma'lumotlar:** Ism va familiya · Telefon (+998…) · Qabul sababi textarea (0/300) · **[Davom etish]**
7. **Tasdiqlash:** xulosa jadvali (Shifokor, Xizmat, Sana, Vaqt, Bemor, Telefon, Narx, To'lov, Sabab) · NoticeBanner · **[Tasdiqlash va yozilish]** · **[Orqaga]**
- **Natija:** ✅/⚠️ doira, xabar, #ID · **[To'lov qilish (Click)]** · **[Boshqa vaqtni tanlash]** · **[Tasdiqlash sahifasi]** / **[Bosh sahifa]**
- Jonli navbat rejimida: "Jonli navbat" matni + link "Klinika ma'lumotlari →"

### `/booking/confirmation` — Tasdiq
- ✅ karta "Qabul tasdiqlandi!" · shifokor, sana-vaqt, xizmat, to'lov holati badge
- **[To'lov qilish (Click)]** (agar link bo'lsa) · **[Mening qabullarim]**

### `/my-appointments` — Mening qabullarim
- Har qabul kartasi: holat badge (Kutilmoqda/Tasdiqlangan/Keldi/Qabulda/Yakunlangan/Bekor/Kelmagan), sana-vaqt, shifokor, xizmat, to'lov badge, **[Bekor qilish]**
- Bo'sh holat: EmptyState + **[Qabulga yozilish]**

### `/privacy` — Maxfiylik siyosati
- 5 bo'limli matnli karta

### Telegram bot (sayt emas, lekin brend nuqtasi)
Klaviatura: **🤖 Shifokor tanlashda yordam · 💰 Narxlar · 📍 Manzil · 👤 Operator bilan bog'lanish** · operator rejimida **🚪 Suhbatni yakunlash** · inline: **📅 Qabulga yozilish**, ovoz uchun **Ha, ruxsat / Yo'q**, **✅ To'g'ri / ✏️ Tuzatish kerak**

---

## 2. Xodimlar sahifalari

### `/login` — Panelga kirish
- Brand-tile logo, eyebrow "Health AI — Xodimlar", H1 "Panelga kirish"
- Email, Parol inputlari · **[Kirish]** · parol tiklash rejimida "Yangi parol" + **[Parolni yangilash]**
- Footer matni (READMEga havola — mijozga ko'rsatishga yaroqsiz)

### Admin shell (`/admin/*`)
- Desktop: chap sidebar 256px — logo + klinika nomi, guruh sarlavhasi, nav linklar; pastda profil ID + rollar
- Mobil: tepada logo + pulse-dot, ostida gorizontal scroll nav chiplari
- Nav (rol va rejimga qarab): Registratsiya va navbat · Belgilangan qabullar · Kalendar · Xizmatlar kassasi · Xodimlar · Suhbatlar · Bemorlar · Shifokorlar · Xizmatlar · Yo'nalishlar · Savol-javoblar · Tashriflar hisoboti · Belgilangan qabullar tahlili · Sozlamalar

| Sahifa | Elementlar va tugmalar |
|---|---|
| `/admin` Registratsiya va jonli navbat | **[Yangilash] [Bemorni ro'yxatdan o'tkazish]** · filtr select (Faol navbat / Bugungi barcha) · navbat kartalari: katta talon raqami, bemor, №, xizmat, shifokor, holat badge, to'lov holati · **[Chaqirish] [Navbatdan chiqarish]** · pagination **[Oldingi] [Keyingi]** · 20 sek avtoyangilanish |
| ↳ Modal "Bemorni ro'yxatdan o'tkazish" | toggle **[Avval kelgan] [Yangi bemor]** · qidiruv input + natija kartalari · (yangi) Ism, Telefon · Shifokor select · Xizmat select · **[Ro'yxatdan o'tkazish]** → talon ekrani: katta raqam + **[Talonni chop etish] [Tayyor]** |
| `/admin/appointments` Qabullar | qidiruv · holat filtri (8) · manba filtri (Telegram ilova/chat, Veb-sayt, Admin, Qabulxonada) · jadval: Sana, Bemor, Xizmat, Shifokor, Manba, Holat, To'lov, Boshqarish · **[Tasdiqlash] [Kelmagandi] [Bekor qilish]** · modallar: bekor qilish (sabab + **[Yopish] [Ha, bekor qilish]**), kelmaslik (sabab + **[Kelmagandi sifatida belgilash]**) |
| `/admin/calendar` Kalendar | ko'rinish select (Kun/Hafta/Oy) · **[← Oldingi] [Bugun] [Keyingi →]** · shifokor filtri · hafta: 7 kun kartasi · oy: grid, "N qabul" badge, "Band vaqt bor" · kun: agenda ro'yxati |
| `/admin/cashier` Xizmatlar kassasi | qidiruv input + **[Qidirish]** · bemor natijalari · to'lov usuli select (Naqd / Bank terminali) · to'lov kartalari · **[Pul qabul qilinganini tasdiqlash] [To'liq qaytarishni qayd etish]** (hozir `window.prompt/confirm` — brauzer dialogi) |
| `/admin/conversations` Suhbatlar | qidiruv · filtr (Barcha/Diqqat talab/Botda/Operatorda/Yopilgan) · chap: jadval (Bemor + o'qilmagan soni, Holat badge, Oxirgi xabar, **[Ochish]**) · o'ng: chat oynasi, **[Qabul qilish]/[Qo'yib yuborish]**, xabar pufakchalari, textarea + **[Yuborish]** |
| `/admin/patients` Bemorlar | qidiruv · toggle chiplar **[Telegram orqali] [Roziliksiz]** · jadval (Bemor, Aloqa, Rozilik, Tayinlovlar, Oxirgi faoliyat, **[Batafsil]**) · pagination · o'ng panel: profil, rozilik badge, statistika, "Operatsion izoh" + **[Izohni saqlash]**, tayinlovlar ro'yxati |
| `/admin/doctors` Shifokorlar | **[+ Shifokor qo'shish]** · jadval (Ism, Yo'nalish, Holat, **[Boshqarish]**) · modal: F.I.Sh., Lavozim, Yo'nalish, xodim hisobini bog'lash, Faol checkbox, ish kunlari **[+ Kun qo'shish]**, band vaqtlar **[+ Band vaqt qo'shish]**, **[Bekor] [Saqlash]** |
| `/admin/services` Xizmatlar | **[+ Xizmat qo'shish]** · jadval (Nomi, Yo'nalish, Davomiylik, Narx, Shifokorlar, Holat, **[Boshqarish]**) · modal: nom, yo'nalish, tavsif, davomiylik, narx, tayyorgarlik, shifokorlar, Faol, **[Saqlash]** |
| `/admin/specialties` Yo'nalishlar | jadval (Nomi, Tavsif, Holat, Tahrirlash/Faollik) · forma: Nomi, Tavsif, **[Bekor] [Saqlash]** |
| `/admin/faqs` Savol-javoblar | jadval (Savol, Kategoriya, Holat, Tahrirlash/**O'chirish**) · forma: Savol, Javob, Kategoriya, **[Saqlash]** |
| `/admin/operations` Tashriflar hisoboti | **[Yangilash]** · oy tanlash · 4 StatCard (Oyda kelganlar, Yakunlangan, Bekor, Faol navbat) · pul harakati kartasi · shifokorlar yuklamasi ro'yxati |
| `/admin/analytics` Tahlillar | davr select (7/30/90 kun/Boshqa) + sana inputlari · guruhlash (Kun/Hafta/Oy) · 9 ta StatCard (konversiya, bekor qilish, kelmaslik darajasi…) · tushum bar grafigi · shifokor/xizmat/manba bo'yicha jadvallar · bekor/kelmaslik sabablari |
| `/admin/staff` Xodimlar (faqat owner) | **[Xodim qo'shish]** · jadval (Ism, Rol select, **[O'chirish]**) · modal: Ism, Email, Rol, Parol, **[Qo'shish]** |
| `/admin/settings` Sozlamalar | Qabul tartibi select (Jonli navbat / Aralash / Oldindan yozilish) · Ish vaqti, Manzil, Telefon, Bot salomlashuvi · **[Saqlash]** · Telegram bot kartasi: holat badge, token input, **[Faollashtirish] [O'chirish]** · AI bilim bazasi info kartasi |
| `/admin` xato sahifasi | logo, "Sahifani yuklab bo'lmadi", **[Qayta urinish]**, link "Bosh sahifaga qaytish" |

### Shifokor shell (`/doctor/*`)
Sidebar: Bugungi navbat · Laboratoriya · Jadvalim · Yo'llanmalar · (admin bo'lsa) "→ Admin panelga o'tish"

| Sahifa | Elementlar |
|---|---|
| `/doctor` Mening navbatim | aralash rejimda tab: Jonli navbat / Belgilangan qabullar · navbat kartalari · **[Bemor tarixi] [Chaqirish] [Qabulni boshlash] [Yakunlash]** · belgilangan rejimda: "keyingi bemor" bloki + jadval (Vaqt, Bemor, Xizmat, Narx, Holat, Amallar) |
| `/doctor/patients/[id]` Bemor tarixi | **[Boshqa shifokorga yo'naltirish]** · link "Laboratoriya buyurtmasi" · yangi qayd formasi: turi (Ko'rik qaydi, Joriy baholash, Shifokor tashxisi, Retsept, Keyingi kuzatuv), Sarlavha, Mazmun, **[Qaydni saqlash]** · tarix kartalari · **[Tarixni chop etish]** |
| `/doctor/referrals` Yo'llanmalar | kartalar ro'yxati (bemor, A → B shifokor, holat, sana) |
| `/doctor/referrals/new` | Qaysi shifokorga select · Maqsad · Izoh · **[Yo'naltirish]** |
| `/doctor/referrals/[id]` | sabab, izoh, muddat · **[Tarixni ochish va qayd yozish] [Yo'llanmani yakunlash] [Bekor qilish]** |
| `/doctor/laboratory` Laboratoriya ish stoli | **[Yangilash]** · buyurtmalar ro'yxati + pagination · yangi buyurtma: Namuna turi, Tekshiruvlar textarea, **[Buyurtmani saqlash]** · namuna kartalari (holat, accession ID, keyingi holat tugmasi, **[Namunani rad etish] [Qayta olish uchun yangi namuna]**) · natija qoralamasi: Natija, Birlik, Me'yor, **[Qoralamani saqlash]** |
| `/doctor/schedule` Jadvalim | haftalik ish vaqti · tanaffus qo'shish (boshlanish/tugash, **[Qo'shish]**) · jadval + **[O'chirish]** |

### `/platform` — Health AI ichki admin
- Klinikalar ro'yxati: nom, slug, timezone, Active badge, bot holati · **[Activate] / [Deactivate]**

---

## 3. Dizayn bo'yicha topilgan muammolar

1. **Marketing (lead) sayti umuman yo'q.** `/` — bemor uchun klinika ma'lumot sahifasi, `robots: noindex`. Klinika egalarini jalb qiladigan sahifa yo'q — yangi sayt kerak (pastdagi 4-bo'lim).
2. **Admin panelda "Chiqish" tugmasi yo'q.** `UserMenu` komponenti yozilgan, lekin hech qayerda ishlatilmagan; sidebar pastida xom `profileId` va inglizcha rol nomlari chiqadi.
3. **Owner/Manager/Reception dashboardlari va "Tezkor yozish" jadvali ishlatilmaydi** (`components/admin/overviews/*` — o'lik kod). Yaxshi StatCard'lar bor, lekin ekranga chiqmaydi.
4. `/platform` sahifasi aniqlanmagan tokenlarni ishlatadi (`bg-muted`, `text-muted-foreground`, `text-destructive`) va inglizcha — uslubsiz ko'rinadi.
5. Kassada `window.prompt/confirm` — pul operatsiyasi uchun brauzer dialogi. AModal bilan almashtirish kerak.
6. Bitta ikon bir nechta bo'limda: ClipboardList (3 ta), Users (2), MessagesSquare (2), BarChart3 (2), Laboratoriya uchun ListOrdered.
7. Mini App'da emoji (✅ ⚠️ 🩺 🤔 ℹ️) lucide ikonlar bilan aralash.
8. Wizard qadamlari "1/7…6/7", keyin "Tasdiqlash", "Natija" — raqamsiz; progress bar yo'q.
9. Mini App `/privacy` "klinik hujjatlar yuritmaydi" deydi, lekin shifokor paneli tarix/retsept yozadi — matn ziddiyati (yuridik tekshiruv kerak).
10. Login footeri README'ga yuboradi — mijozga ko'rsatiladigan matn emas.
11. Navbat va jadvallar mobil kenglikda gorizontal ko'p tugma bilan zich; jadvallar (ATable) mobilda karta ko'rinishiga o'tmaydi.

---

## 4. Taklif: yangi lead-generatsiya sayti (healthai.uz)

Maqsad: xususiy klinika egasi/menejeri **demo so'rasin** yoki **Telegram orqali yozsin**.

| Sahifa | Asosiy bloklar | CTA |
|---|---|---|
| `/` Bosh sahifa | Hero (talon raqami animatsiyasi) · muammo (qog'oz, Excel, navbat tartibsizligi) · 4 ish joyi (Registratsiya, Kassa, Shifokor, Laboratoriya) · bemor yo'li (kelish → talon → shifokor → yo'llanma → kassa) · Telegram bot · xavfsizlik/maxfiylik · bosqichma-bosqich ulanish · FAQ · yakuniy CTA | Demo so'rash · Telegram'da yozish |
| `/imkoniyatlar` | har modul uchun alohida bo'lim, real ekran rasmlari | Demo so'rash |
| `/klinikalar-uchun` | rollar bo'yicha: egasi, registrator, kassir, shifokor | Demo so'rash |
| `/narxlar` | 3 tarif (narxlar klinika bilan kelishiladi — "Narxni so'rash"), taqqoslash jadvali | Narxni bilish |
| `/xavfsizlik` | RLS, rollar, ma'lumot klinikada, AI tashxis qo'ymaydi | Hujjatni so'rash |
| `/demo` | lead formasi | Yuborish |
| `/aloqa` | telefon, Telegram, manzil, xarita | Qo'ng'iroq / Telegram |
| `/login` | xodim kirishi (header'da kichik link) | Kirish |

Lead forma maydonlari: Klinika nomi · Ismingiz · Lavozim (Egasi/Menejer/Shifokor/Boshqa) · Telefon (+998) · Shahar · Shifokorlar soni (1–5 / 6–15 / 16–40 / 40+) · Hozir nima ishlatasiz (Qog'oz / Excel / Boshqa dastur) · Qulay aloqa (Telegram / Qo'ng'iroq) · rozilik checkbox · **[Demo so'rash]**.
