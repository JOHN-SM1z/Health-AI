# Claude Design uchun promptlar

Ikki prompt: **A** — lead olib keladigan marketing sayt (asosiy), **B** — mahsulot ekranlarini (admin, shifokor, Mini App) shu uslubda qayta chizish. Ikkalasida ham "Design system" bloki bir xil — avval A ni ishlating, keyin B ni o'sha loyiha ichida.

---

## PROMPT A — Marketing / lead-generation sayt

```
Design a complete marketing website for "Health AI" — clinic operations software for private clinics in Uzbekistan. The site's only job is to generate qualified leads: clinic owners and managers requesting a demo or messaging us on Telegram. Style: creative but minimal, editorial, calm, very professional. Think Linear / Stripe / Vercel level of polish, but warmer and more human because this is healthcare.

## Product (use this as the source of truth for copy)
Health AI runs the daily operations of a private clinic around walk-in patients:
- Reception: find a returning patient by number, name or phone, register the arrival, pick doctor + service, print a queue ticket (talon). No invented appointment times.
- Live queue: every doctor sees their own queue; statuses Waiting → Called → In consultation → Completed; auto-refresh.
- Service cashier (kassa): itemized charges, cash or bank terminal, refunds recorded with a reason. Money is recorded once.
- Doctor workspace: patient history where every note keeps its author and time, printable history, prescriptions written by the doctor, simple referral to another doctor (the receiving doctor can read history immediately, no approval ceremony).
- Laboratory: order → specimen → draft results, every step tracked.
- Telegram bot + Mini App for patients: prices, address, working hours, FAQ, optional online booking, human operator handoff, voice messages with consent.
- Management: monthly visits, completed/cancelled, doctor workload, collected money vs refunds.
- Clinic chooses its mode: walk-in queue, scheduled booking, or mixed.
- Security: role-based access (owner, admin, manager, reception, cashier, doctor), every clinic's data isolated, audit trail.
- AI boundary (must be stated clearly and positively): AI only answers clinic information and navigation. It never diagnoses or prescribes. Clinical decisions stay with doctors.

## Honesty rules for copy
- Do NOT invent statistics, customer logos, testimonials, awards or "trusted by 500 clinics". Where social proof belongs, use a clearly labelled placeholder block: "[Pilot klinika fikri — tasdiqlangandan keyin qo'shiladi]".
- Do not promise integrations that don't exist (no eHealth, no MedPlus, no automatic analyzer connection). Click/Payme may be shown as "tez orada".
- Pricing: no fixed numbers. Use "Narxni so'rash".

## Language
Primary: Uzbek (Latin script, use the correct oʻ gʻ apostrophes). Add a UZ / RU language switch in the header. Write all visible copy in natural Uzbek, short sentences, no bureaucratic tone.

## Design system
Palette — "Spruce & Ivory, Signal Lime":
- Ivory (page background) #F5F3EC
- Paper (cards, surfaces) #FFFFFF
- Ink (primary text) #0D1B1E
- Graphite (secondary text) #5E6A6B
- Hairline (borders, dividers) #E3E0D6
- Spruce (primary brand, buttons on light) #0E4D43
- Spruce Deep (dark sections, footer) #08302A
- Mist (soft tint, selected states) #E4EFEA
- Signal Lime (accent: live indicators, ticket highlight, primary CTA on dark backgrounds) #D4F36B
- Coral (attention, "needs operator") #F0704B
- Alert (errors only) #D2433A
Rules: 80% Ivory/Paper/Ink, 15% Spruce, max 5% Lime. Never put Lime text on light backgrounds — Lime is a fill with Ink text on top. All text must pass WCAG AA.

Typography:
- Headlines: "Inter Tight" 600–700, tight tracking (-2%), very large on desktop (64–88px hero).
- One accent word per major headline in "Instrument Serif" italic (Latin) — e.g. "Navbat <em>tartibli</em>, kassa aniq."
- Body: "Inter" 16–18px, line-height 1.6.
- Numbers, queue tickets, small eyebrow labels: "JetBrains Mono", uppercase eyebrows with 0.14em letter-spacing.

Signature motifs (use consistently, this is the brand):
1. The queue ticket (talon): a small paper ticket with a big monospaced number like "047", perforated edge. Use it in the hero, as section markers and in the CTA.
2. The live pulse dot: a small Spruce/Lime dot with an expanding ring — means "live".
3. Hairline grid: thin 1px lines and lots of whitespace; cards with 20px radius, almost no shadow (only on hover).
Icons: Lucide, 1.5px stroke, one unique icon per concept. No emoji. No stock photos of doctors with stethoscopes; if people appear, use calm, real-looking clinic scenes or abstract illustration.

Layout: 12-column grid, max width 1200px, generous vertical rhythm (120–160px between sections on desktop), mobile-first, works at 360px width with 16px gutters.

## Pages to design
1. Home (/) — full page, desktop + mobile:
   - Sticky header: logo (HeartPulse mark in a Spruce tile), nav: Imkoniyatlar · Klinikalar uchun · Narxlar · Xavfsizlik · Aloqa, language switch, small "Kirish" text link, primary button "Demo soʻrash".
   - Hero: eyebrow "Xususiy klinikalar uchun operatsion tizim" · H1 "Bemor keldi — <em>talon</em> 10 soniyada." · subtext about reception, queue, kassa and doctors in one system · buttons: [Demo soʻrash] (Spruce) and [Telegramda yozish] (outline) · right side: a composed product visual — a live queue card stack with ticket numbers 045, 046, 047 (047 highlighted Lime, "Chaqirildi"), floating over a soft hairline grid. Leave a slot for a hero animation video.
   - Trust strip: three short facts that are true — "Rollar boʻyicha kirish", "Har bir qayd muallifi bilan", "AI tashxis qoʻymaydi".
   - Problem section: "Bugun klinikada nima boʻlyapti?" — 3 cards: paper registers and duplicate cards; queue chaos at the doorway; cash vs terminal not matching at end of day.
   - Patient journey: horizontal scroll-driven timeline: Keldi → Talon → Shifokor → Yoʻllanma → Laboratoriya → Kassa. Each step shows which workspace handles it.
   - Four workspaces bento grid: Registratsiya, Kassa, Shifokor, Laboratoriya — each with a mini UI preview and 2 bullet benefits.
   - Telegram section (dark Spruce Deep background): phone mockup with the bot keyboard (🤖 Shifokor tanlashda yordam · 💰 Narxlar · 📍 Manzil · 👤 Operator) rendered as clean chips, copy about fewer phone calls to reception.
   - Mode switch block: interactive segmented control "Jonli navbat / Aralash / Oldindan yozilish" that swaps the illustration.
   - Security & AI boundary: calm, confident section with 4 points.
   - Onboarding steps: 1 Demo → 2 Klinika sozlamalari (shifokor, xizmat, narx) → 3 Xodimlarni oʻqitish → 4 Pilot.
   - Social proof placeholder block (clearly labelled, see honesty rules).
   - FAQ accordion (6 questions: internet uzilsa? maʼlumotlar kimda? Excel'dan oʻtkazish? qancha vaqtda ishga tushadi? shifokorlar uchun qiyinmi? narx?).
   - Final CTA band: big ticket illustration "Sizning navbatingiz: 001" + inline short form (Ism, Telefon, Klinika nomi) + [Demo soʻrash].
   - Footer (Spruce Deep): links, contacts, Telegram, privacy, small "© Health AI".
2. Demo request page (/demo): two-column — left: what happens after you submit (we call within 1 working day, 30-min demo, no obligation); right: form with Klinika nomi, Ismingiz, Lavozim (Egasi / Menejer / Shifokor / Boshqa), Telefon (+998 mask), Shahar, Shifokorlar soni (1–5 / 6–15 / 16–40 / 40+), Hozir nima ishlatasiz (Qogʻoz / Excel / Boshqa dastur), Qulay aloqa (Telegram / Qoʻngʻiroq), consent checkbox, [Demo soʻrash]. Design inline validation, loading, success ("Soʻrovingiz qabul qilindi" with ticket motif) and error states.
3. Features (/imkoniyatlar): one long page, a section per workspace with real-looking UI screenshots, sticky left table of contents.
4. Pricing (/narxlar): 3 tiers (Kichik klinika, Koʻp tarmoqli klinika, Tarmoq) — feature lists, no prices, each with [Narxni soʻrash]; comparison table below; FAQ.
5. Security (/xavfsizlik): roles matrix, data isolation, audit, AI boundary, privacy.
6. Contact (/aloqa): phone, Telegram, address, map placeholder, short form.

## Conversion details
- Primary CTA "Demo soʻrash" visible in the header at all times; secondary "Telegramda yozish".
- On mobile: sticky bottom bar with two buttons [Demo] [Telegram].
- Every section ends with a soft CTA link.
- Forms: max 8 fields on /demo, 3 fields in inline CTAs, big tap targets (48px), phone keyboard for phone input.

## Motion (CSS/JS, keep subtle)
- Ticket numbers flip like a split-flap display when scrolled into view.
- Pulse dot on every "live" element.
- Sections fade-up 12px on enter, 400ms, ease-out; stagger children 60ms.
- Buttons: 1px lift + shadow on hover; pressed state scales 0.98.
- Patient journey timeline progresses with scroll.
- Respect prefers-reduced-motion.
Leave clearly marked slots for 3 video loops: hero (16:9), patient journey (21:9), Telegram section (9:16 inside the phone).

## Deliverables
High-fidelity desktop (1440) and mobile (390) designs for every page above, plus a one-page style guide (colors, type scale, buttons: primary/secondary/outline/ghost/danger in default/hover/pressed/disabled/loading, inputs with all states, badges, cards, ticket component, pulse dot).
```

---

## PROMPT B — Mahsulot ekranlari (admin, shifokor, Mini App)

```
Using the same Health AI design system (Spruce & Ivory, Signal Lime palette; Inter Tight / Instrument Serif / Inter / JetBrains Mono; ticket and pulse-dot motifs), redesign the product's working screens. These are used 8+ hours a day by receptionists, cashiers and doctors: prioritise speed, scannability and calm. Less creativity than the marketing site — clarity first. All copy in Uzbek (Latin).

Global shell (staff):
- Left sidebar 256px: logo + clinic name, grouped navigation with a unique Lucide icon each (Ish joyi: Registratsiya va navbat, Kassa, Suhbatlar, Bemorlar · Rejalashtirish: Belgilangan qabullar, Kalendar · Boshqaruv: Shifokorlar, Xizmatlar, Yoʻnalishlar, Savol-javoblar, Xodimlar · Hisobotlar: Tashriflar hisoboti, Tahlillar · Sozlamalar). Bottom: user name, role in Uzbek (Egasi, Administrator, Menejer, Shifokor, Qabulxona) and a [Chiqish] button.
- Top bar: page title, live pulse dot + "Oxirgi yangilanish 14:32", global patient search (⌘K).
- Mobile: bottom tab bar with the 4 most-used sections + "Yana" sheet.

Screens:
1. Login — centered card, Email, Parol, [Kirish], "Parolni unutdingizmi?" link; password-recovery state.
2. Reception & live queue (main screen) — header actions [Yangilash] [Bemorni roʻyxatdan oʻtkazish]; filter segmented control (Faol navbat / Bugungi barcha); queue rows: big mono ticket number, patient name, patient №, service, doctor, status chip (Kutilmoqda, Chaqirildi, Qabulda, Yakunlangan, Bekor qilingan), payment chip (Toʻlov kutilmoqda / Toʻlangan / Qaytarilgan), actions [Chaqirish] [Navbatdan chiqarish]. Stale-data warning banner state. Empty state "Navbat boʻsh".
3. Register arrival — side drawer (not small modal): toggle [Avval kelgan] [Yangi bemor]; patient search with result cards; name/phone for new; doctor and service selects; [Roʻyxatdan oʻtkazish]. Success state: large printable ticket (76mm) with number, date, patient, doctor, service, note "Talon — toʻlov cheki emas", buttons [Talonni chop etish] [Tayyor].
4. Cashier (kassa) — patient search, payment method segmented control (Naqd / Bank terminali), itemized charge cards with [Pul qabul qilinganini tasdiqlash] and [Toʻliq qaytarishni qayd etish]; confirmation and refund-reason as proper modals with the amount shown large.
5. Conversations — two-pane inbox: list with unread counters and status chips (Bot, Diqqat talab — Coral, Operatorda, Yopilgan), chat pane with patient/operator/bot bubbles, [Qabul qilish]/[Qoʻyib yuborish], composer with [Yuborish], "not delivered via Telegram" error state on a bubble.
6. Patients — table + right detail panel (profile, consent badges, visit stats, operational note with [Izohni saqlash], appointment list). Tables become cards on mobile.
7. Doctors, Services, Specialties, FAQ — consistent CRUD pattern: table, [+ Qoʻshish], edit drawer with [Bekor] [Saqlash]; doctor drawer includes weekly hours editor and blocked-time list.
8. Settings — clinic mode selector as 3 large option cards (Jonli navbat / Aralash / Oldindan yozilish), clinic info fields, Telegram bot connection card (status, token field, [Faollashtirish] [Oʻchirish]).
9. Owner dashboard "Klinika bugun" — stat cards (Bugungi tashriflar, Yakunlangan, Bekor qilingan, Faol navbat, Qabul qilingan pul, Qaytarilgan), doctor workload list, quick actions (Shifokor qoʻshish, Xizmat qoʻshish, Xodim qoʻshish, Telegram bot). Label money as "qabul qilingan pul", never "foyda".
10. Reports & analytics — month picker, KPI cards, simple bar chart, breakdown tables.
11. Doctor: My queue (current patient highlighted, [Qabulni boshlash] [Yakunlash] [Bemor tarixi]); Patient history (new note form with type select, append-only timeline with author + time, [Tarixni chop etish], [Boshqa shifokorga yoʻnaltirish]); Referrals list/new/detail; Laboratory workbench (orders list, specimen status stepper, result drafts); My schedule.
12. Patient Telegram Mini App (390px, respects Telegram theme colors): clinic home, info/prices, 7-step booking wizard with a real progress bar, slot picker grid, review screen, success/failure states, my appointments list.

States for every screen: loading skeleton, empty, error, success. Keyboard focus rings visible. Minimum tap target 44px. Tabular numbers everywhere money or time appears.
```
