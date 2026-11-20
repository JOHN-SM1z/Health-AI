# Laboratory Module — Phase 6 Lab Orders in the Existing Payment Engine

Status: **implemented and tested locally; not deployed.**

## Design: the smallest safe extension

No second payment engine. `public.payments` gains a second possible subject
(`20261005000008_lab_payments.sql`):

- a payment belongs to **exactly one** appointment **or** one lab order
  (`payments_one_subject_check`); `appointment_id` is now nullable;
- `lab_order_id` is a same-clinic, same-patient composite foreign key, unique
  per order, with no cascade (a billed order keeps its bill);
- every existing path finds appointment payments by `appointment_id`
  (booking engine, Click webhook, Mini App, dashboard, analytics), so they
  never see lab payments and are unchanged — confirmed by their test suites.

Order status (`lab_orders.status`) and payment status (`payments.status`)
remain separate.

## Lifecycle

| Event | Effect |
|---|---|
| Order created (`create_lab_order`) | one `manual` payment, `unpaid`, amount = sum of the items' stored prices (catalog or allocated panel share) |
| Item cancelled while the bill is unpaid / failed | amount lowered to the remaining items |
| Desk payment (cash / card terminal) | `unpaid → paid` through `transitionPaymentStatus` (legal transitions, compare-and-set, audit `payment_status_changed`, `paid_by`); method kept in metadata |
| Paid, clinic policy "before collection" | items waiting in `ordered` become `ready_for_collection` (default policy: they already are — O6) |
| Order cancelled after payment | bill stays `paid`; the Kassa shows "Qaytarish kerak" |
| Refund | `paid → refunded` (whole payment — the existing Kassa has no partial refunds; per-item prices are stored for when it does) |

## Forgery protection

- `payments_lab_amount_guard`: while unpaid/failed, a lab payment's amount must
  equal its order's non-cancelled item total; once pending/paid/refunded it
  cannot change; a payment can never switch subject. This holds even for the
  service role.
- Signed-in roles still cannot write payments at all
  (`payments_block_direct_write`, revoked grants).
- The API accepts only a status and a method; any amount in the request is
  ignored.

## Kassa

`/admin/lab-kassa` ("Laboratoriya kassasi"), for the existing payment roles
(owner, admin — `finance.view`): unpaid lab orders (or all), patient, test
names with status, stored amount, payment status; **To‘lovni qabul qilish**
(naqd / karta) and **Qaytarish**. No result values appear.

Routes: `GET /api/admin/lab/payments?filter=open|all`,
`POST /api/admin/lab/orders/[id]/payment` `{ status, method? }`.

## Not available in the existing system (reported, not invented)

- **Digital receipts:** the repository has no receipt generation to reuse.
  A lab receipt needs a product decision (format, numbering, fiscal
  requirements) before it is built.
- **Partial refunds:** status-only refunds exist today.
- **Receptionist as cashier:** desk payments follow the existing payment roles
  (owner, admin). Letting receptionists record payments is a one-line
  capability change if the clinic wants it.
- **Online payment (Click/Payme) for lab orders:** adapters are
  appointment-only; lab bills are recorded at the desk.
- **Revenue analytics:** unchanged; lab revenue from paid lab payments belongs
  to Phase 17 (dashboards).

## Tests

- `src/lib/supabase/lab-ordering.test.ts` (+5): bill created once at stored
  prices; forged / changed amount refused even for the service role and frozen
  once paid; subject cannot change; signed-in roles cannot write; cancelled
  items lower an unpaid bill, a paid bill stays for refund; payment releases
  items under "before collection"; bill stays in its clinic and patient.
- `src/app/api/admin/lab/lab-kassa.test.ts` (5): role refusals (manager,
  receptionist, lab, anonymous), listing with stored amount, cash payment once
  (idempotent, audited, `paid_by`), refund and illegal transitions, cross-clinic
  refusal, release under "before collection".
- `e2e/lab-ordering.mjs` (+2): the owner takes a cash payment at the lab Kassa
  for the order's stored amount.
- Regression: booking engine, payments (incl. Click webhook) and integration
  suites unchanged and passing.

Local run after a clean `supabase db reset` (real Supabase stack): `npm test`
806/806; `npm run test:e2e` referral 84/84, booking 9/9, staff & safety 14/14,
lab configuration 11/11, lab ordering 14/14, HTTP red team 55/55; lint,
typecheck, build pass.
