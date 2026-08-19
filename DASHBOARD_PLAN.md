# 🏥 Health AI — Dashboard Master Plan & TODO

Bu hujjat Health AI platformasining Boshqaruv Paneli (Admin Dashboard) va Shifokorlar Portali (Doctor Portal) uchun to'liq yo'l xaritasi (Roadmap) hisoblanadi. Har bir vazifa bajarilgach, ushbu faylda belgilab boriladi.

---

## 🏗️ Arxitektura va Bo'limlar xaritasi

- **Bemorlar qismi**: `/` va `/book` (Telegram Mini App va Web Booking)
- **Admin Dashboard**: `/admin` (Boshqaruv, Qabullar, Kalendar, Chatlar, Xizmatlar, Tahlillar)
- **Shifokor Portali**: `/doctor` (Shifokorning shaxsiy ish stoli va jadvallari)
- **Kirish tizimi**: `/admin/login` (Supabase Auth)

---

## 📋 Vazifalar Ro'yxati (TODO)

### 🔹 1-bosqich: Bugungi Dashboard (Overview) boyitish (`/admin`)
- [ ] **Tezkor qabul kiritish (Quick Booking Modal)**: Administrator yoki qabulxona xodimi telefon orqali yoki kelgan (Walk-in) bemorni darhol qabulga yozishi uchun qulay modal.
- [ ] **Jonli Kassa va Tushumlar bloki**: Bugungi naqd, plastik karta va to'lanmagan qabullar summasi hisob-kitobi.
- [ ] **Tezkor qidiruv va filtr**: Bemor ismi, telefoni, shifokori va statusi bo'yicha jonli qidiruv.
- [ ] **Tezkor status boshqaruvi**: Bitta bosish bilan *"Keldi"*, *"Qabulda"*, *"Yakunlandi"*, *"Bekor qilindi"* statuslarini yangilash.

---

### 🔹 2-bosqich: Interaktiv Taqvim va Jadvallar (`/admin/calendar`)
- [ ] **Ko'p ko'rinishli kalendar**: Kunlik (soatma-soat), Haftalik va Oylik ko'rinishlar.
- [ ] **Shifokorlar bo'yicha filtr va vizual ajratish**: Qaysi shifokorda qaysi soat bo'sh yoki band ekanligini ranglar bilan ko'rsatish.
- [ ] **Tanaffus va bloklar (Time Blocks)**: Shifokorlarning dam olish yoki majlis vaqtlarini bevosita taqvimdan belgilash.

---

### 🔹 3-bosqich: Bemorlar va Jonli Chatlar Boshqaruvi (`/admin/conversations`)
- [ ] **Telegram Jonli Chat markazi**: Telegram bot va bemor o'rtasidagi yozishmalarni real-vaqtda kuzatish.
- [ ] **Operator qo'lga olishi (Human Handoff)**: Operator bot suhbatini to'xtatib, bemorga to'g'ridan-to'g'ri Telegramga javob yoza olishi.
- [ ] **Bemor kartasi (Patient CRM Profile)**: Bemorning qabul tarixi, telefon raqami va umumiy tashriflari.

---

### 🔹 4-bosqich: Kengaytirilgan Analitika va Grafiklar (`/admin/analytics`)
- [ ] **Daromad va Tushum dinamikasi grafigi**: Kunlik, haftalik va oylik tushumlar vizualizatsiyasi.
- [ ] **Eng ko'p talab qilingan xizmatlar va shifokorlar reytingi**.
- [ ] **Qabul manbalari tahlili**: Telegram Bot vs Veb-sayt konversiyasi.
- [ ] **Bekor qilingan va kelmaganlar (No-show) sabablari statistikasi**.

---

### 🔹 5-bosqich: Shifokor Portali (`/doctor`)
- [ ] **Shifokorning shaxsiy bugungi navbati**: Faqat o'ziga yozilgan bemorlarni ko'rish va holatini belgilash.
- [ ] **Shaxsiy ish jadvali boshqaruvi**: Shifokor o'zining ish soatlarini kiritishi va dam olish kunlarini belgilashi.

---

*Hujjat avtomatik ravishda yangilanadi.*
