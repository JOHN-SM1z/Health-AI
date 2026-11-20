# Laboratory Module — Phase 5 Doctor Lab Ordering

Status: **implemented and tested locally; not deployed.**

## Workflow

Patient workspace (`/doctor/patients/[id]`) → **Laboratoriya** section →
**Tahlil buyurtma qilish** → search and choose tests and/or panels (preparation,
sample type, turnaround and price shown) → **Ko‘rib chiqish** (selected items,
total, preparation instructions, recent-test warnings) → **Buyurtma berish**.

- During a consultation the order is tied to it (`source = consultation`,
  the doctor's own appointment); otherwise it is a direct order
  (`source = walk_in`) with the doctor as ordering doctor.
- Each test shows its status (Buyurtma qilindi → Namuna kutilmoqda → Namuna
  olindi → Jarayonda → Natija tekshiruvda → Tasdiqlandi / Bekor qilindi).
- A verified test has **Natijani ko‘rish**: values with unit, the configured
  range and the position against it ("Me’yordan past" …), with the note that
  this is not a diagnosis. Unverified results are never shown.

## Recent-similar-test warning

On review, for each test being ordered, the latest earlier non-cancelled order
of the same test within 30 days is shown — e.g. "Shunga o‘xshash tahlil
topildi: CBC — 18 kun oldin" — with **Natijani ko‘rish** (when verified) and
**Buyurtmani davom ettirish**. It never blocks the order and never says the
test is unnecessary (`src/lib/labs/recent.ts`).

## Server and database

- `create_lab_order()` (`20261005000007_lab_order_creation.sql`, server only):
  one transaction; idempotent on the creation key (a repeat returns the same
  order, a different payload under the same key is refused, concurrent
  duplicates create one order); catalog snapshots and prices; **proportional
  panel allocation (O2)** in whole so'm when the panel price is whole (else
  0.01), remainder to the highest-priced test, always summing exactly; a test
  cannot be ordered twice in one order (alone and inside a panel); items
  become `ready_for_collection` unless the clinic requires payment first (O6).
- Routes (doctor only, `requireLinkedDoctor` + `doctor_patient_access`):
  `GET /api/doctor/lab/catalog`, `GET|POST /api/doctor/patients/[id]/lab-orders`,
  `GET /api/doctor/patients/[id]/lab-results/[itemId]` (rate-limited; strict
  audit `lab_result_viewed` before data is returned).
- Clinic, patient, orderer, ordering doctor and prices come from the session,
  the URL and the catalog — never the request body (extra body fields such as
  a price or clinic id are ignored).
- `clinical-isolation.test.ts` also forbids `@/lib/labs/ordering` and
  `@/lib/labs/guards` in AI and patient-facing code.

## Tests

| Suite | Covers |
|---|---|
| `src/lib/supabase/lab-ordering.test.ts` (9) | allocation examples (240,000 → 80/40/120k; 100,000 / 3; fractional; free tests), price snapshots, O6 readiness, idempotent replay and key reuse, concurrent duplicate, empty / duplicate / inactive / foreign refusals with nothing half-created, consultation pinning, no signed-in access |
| `src/app/api/doctor/lab-ordering.test.ts` (9) | valid order (server-derived fields, extra body fields ignored), replay, direct order, inactive test, empty order, missing DOB, unauthorized and cross-clinic patients, wrong doctor's / wrong patient's / unstarted consultation, role refusals, recent-test data, audited verified-result view vs unverified and unrelated doctor |
| `src/lib/labs/recent.test.ts` (4) | warning rule |
| `e2e/lab-ordering.mjs` (12) | browser order, stored values, warning shown and not blocking, verified result view, audit |

Local run after a clean `supabase db reset` (real Supabase stack): `npm test`
796/796; `npm run test:e2e` referral 84/84, booking 9/9, staff & safety 14/14,
lab configuration 11/11, lab ordering 12/12, HTTP red team 55/55; lint,
typecheck and build pass.

Not in this phase: reception/lab walk-in ordering screens (Phase 7 lab
workspace), payment linkage (Phase 6), sample and result entry (Phases 7–9).
