# Product decisions — patient identity, online booking, online payment, SMS

**Status:** decided by the product owner on 2026-10-08 and implemented on the pilot line (PRs #15, #16 and the SMS /
audit-pack PRs). Applied to a local database only; staging and production wait for the owner's written approval.
**Scope note:** product and architecture decisions. Whether applicable law permits or requires something different —
personal-data storage location, health-data handling, fiscal receipts for online payments, SMS consent — is a separate
legal review. Nothing here is a claim of legal compliance.

## Decision summary

| Area | Decision |
|---|---|
| What employees see of a patient | Name, phone and card number only. Passport/ID, JSHSHIR, date of birth, sex and address stay in the database for the server. Lab and doctors see an **age**. |
| Online identity (Mini App) | Passport/ID or JSHSHIR + date of birth is a **lookup key, not proof**. Proof: the patient's own Telegram phone equals the card's phone, or an SMS code to the card's phone. No MyID, no face check, no per-check fee. |
| Same answer for every lookup | "No card", "wrong date of birth" and "phone does not match" answer identically. |
| Someone else's document typed online | Never stored on the new record; a claim goes to staff. |
| Concern → doctor | Deterministic, local keyword router suggests one of the clinic's own directions; the **patient confirms**. Never a disease. Urgent wording ends the booking with the approved message and alerts staff. |
| Voice | Only to an allowed, non-foreign speech host; explicit consent; never stored. Patients type until such a host is configured. |
| Times shown | One day at a time. |
| Online payment | Rahmat (adapter pending its merchant API). Server-priced invoice; signed webhook; settled once. |
| Queue number | Issued **on payment**, for the slot's day. The doctor's queue orders booked patients by **slot time**; walk-ins fit between by payment time. |
| Late arrival | More than **10 minutes** after the slot: the patient takes their turn from arrival. |
| Refund defaults | Patient cancels before the slot: **full refund**. Clinic cancels: full refund. **No-show: none.** A second payment or a lost slot: full refund. Owner/manager record the provider's refund reference. |
| Unpaid online bookings | Hold their slot as before (no automatic expiry yet — see Gaps). |
| SMS | Eskiz. Only for a patient **without Telegram** who **agreed at the desk**, and only when the clinic switched SMS on. Texts carry the clinic name and the number only. |
| Smartphone share | Measured in the pilot: kassa totals show how each number reached the patient (Telegram / SMS / neither). |
| Family booking | Out of scope for the pilot (one Telegram account = one patient). |

---

## 1. Identity hidden from employees
- Database: column-level SELECT on `patients` for signed-in roles; no table-wide grant (20261008000005).
- Server: no staff route returns identity values; marker-scan and red-team tests prove it.
- **Gap:** a staff member who needs to correct a document number does it through reception's registration form only
  (no "edit passport" screen). Owner to decide if one is needed and who may use it.

## 2. Online identity
- Telegram-verified phone: the bot keeps a contact only when `contact.user_id` is the sender.
- SMS code: 6 digits, HMAC stored, 5 attempts, 5 minutes, single use, 3 per hour per Telegram user, 5 per day per card.
- A Telegram record that already has visits is never relinked automatically; reception merges with `merge_patients()`.
- Per-clinic switch `online_identity_required` (Settings → Onlayn xizmatlar) makes the server refuse Mini App bookings
  without completed identity. Off by default.
- This replaces the 2026-10-07 note "no Telegram link until MyID".

## 3. Online payment
- No payment can become "paid" without a provider signature verified over the raw webhook body.
- An amount mismatch goes to manual review, never "paid".
- Online money is recorded as ledger method `online`; the kassa's cash and terminal figures are untouched.
- **Gap:** Rahmat — merchant API documentation, webhook signature scheme, refund API, test credentials, contract.
  Until then `ONLINE_PAYMENT_PROVIDER=none` and patients pay at the kassa (the number is issued there, as today).
- **Gap:** unpaid online bookings do not expire. Proposal: a 15-minute hold when online payment is on.

## 4. SMS
- "Sent" means Eskiz accepted the message; "delivered" only from Eskiz's delivery report.
- No phone number or text is stored with SMS records or logged.
- **Gap:** Eskiz contract, sender name registration, template approval, and one live test message to confirm the API
  and callback field names before turning SMS on.

## 5. Proposed AGENTS.md wording (needs the owner's approval — not applied)
Current rule: "Only `manual` payment is production-usable until Click/Payme adapters, signature verification,
idempotent webhooks, and merchant credentials are implemented."

Proposed: "Only `manual` payment is production-usable until an online provider's adapter is implemented from its
merchant documentation with signature verification over the raw body, idempotent event handling
(`payment_provider_events`), server-side amount checks and merchant credentials. Provider stubs must fail closed and
production must refuse to start with them."

Proposed addition: "A walk-in may be numbered between booked patients; booked patients are called in the order of their
slot times."
