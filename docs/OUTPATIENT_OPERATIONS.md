# Outpatient operations — how the pilot works

This document covers the walk-in flow built for the outpatient pilot (migrations `20261007000001`–`03`,
`20261008000001` for the laboratory, and `20261008000002`–`03` for following the queue in Telegram). The rules come from the owner's decisions of 2026-10-07 and 2026-10-08;
nothing here invents a clinic policy. Where the clinic still has to
decide, the section says so.

## The flow

```
Reception (/admin/reception)        Kassa (/kassa)                     Doctor (/doctor)
───────────────────────────        ──────────────                     ────────────────
passport or JSHSHIR + date of      itemized bill (server prices)       "Jonli navbat": own patients
 birth (dd.mm.yyyy) → card opens    charged · paid · refunded · due      in queue order
 (no card → new-patient form;       take FULL payment, cash and/or     → Chaqirish (call) — the
  no document → by name,              card terminal (split allowed)       patient's Telegram is told
  "Hujjat yo‘q — davom etish")      → queue number + Telegram QR       → Qabulni boshlash (start):
→ doctor + services                   (patient scans it: the queue        opens the patient card;
→ "Ro‘yxatga olish"                    in the bot; hall screen)           notes are written as usual
  (no money at reception)                                               → Yakunlash (complete)
```

- **A queue number is arrival order for the clinic day, not an appointment time.** Every screen and the
  Telegram ticket say so.
- **No paper ticket** (owner decision). The patient gets the number by:
  - the kassa saying it aloud;
  - **the Telegram QR on the kassa screen** after payment (also "Telegram QR" in reception's queue).
    - The patient scans it with the phone camera. The clinic's bot sends the ticket, then **"you are
      called"** when the number is called.
    - "🔄 Navbatim" shows the live position.
    - The QR follows **this visit's queue only**. It does not link the Telegram account to the card, and
      records or results cannot be reached through it, even if someone else scans it.
    - It works once, for one Telegram user, for 24 hours. A new QR replaces an unused one.
  - a Telegram message, if the patient's own Telegram account is already linked to the card (they booked
    through the bot);
  - the waiting-room screen `/queue/<clinic id>`, which shows numbers and doctor names only — never a patient
    name;
  - the Mini App page "Mening qabullarim", which shows the live position.
- **When the number is issued:** on full payment (`clinics.queue_after_payment = true`, the default). A free
  visit is queued at registration.
- **Unfinished visits stay in the queue across midnight.** Their number keeps its day; they are listed before
  the new day's numbers.

## Finding the patient (owner, 2026-10-08)

- **Type the passport/ID number (`AB1234567`) or JSHSHIR, and the date of birth as `dd.mm.yyyy`.** Dots,
  slashes or dashes all work.
  - **One card matches both:** it opens at once.
  - **No card:** the new-patient form opens with the document and date filled in. Type the name, then
    register.
  - **The document matches but the date of birth does not:** reception is told, and the card is not shown.
    Ask the patient again; this catches a wrong patient or a typo.
- **No document with them** (for example a patient in pain): search by name, phone or card number, check the
  date of birth by asking, and take the card with **"Hujjat yo‘q — davom etish"**. Care is never held up by
  identity.
- **There is no physical document check and no face check in Health AI.**
  - A typed ID is a lookup key, not verification.
  - Identity is verified by MyID once it is integrated. That needs a contract, and MyID is not a pilot
    blocker.
  - With MyID, a first-time patient's name and JSHSHIR will fill in at the no-card step.

## Who may do what

| Action | Owner | Manager | Admin | Receptionist | Cashier | Doctor | Lab staff |
|---|---|---|---|---|---|---|---|
| Register an arrival (doctor or laboratory), create a patient | ✓ | ✓ | ✓ | ✓ | — | — | — |
| Call or cancel at the desk | ✓ | ✓ | ✓ | ✓ | — | own patients: call only | lab visits: call only |
| Take payment | ✓ | ✓ | ✓ | — | ✓ | — | — |
| Refund (full or partial, reason required) | ✓ | ✓ | — | — | only with a grant | — | — |
| Give or withdraw a cashier's refund grant | ✓ | ✓ | — | — | — | — | — |
| Show a visit's Telegram QR | ✓ | ✓ | ✓ | ✓ | ✓ | — | — |
| Start or complete a consultation | — | — | — | — | — | the visit's own doctor | — |
| Start collection or complete a lab visit | — | — | — | — | — | — | ✓ |

The API checks every rule, and the database checks it again. A browser cannot choose the clinic, the actor, a
price, an amount owed or a payment status.

## Money

- **Charges** (`visit_charges`): one line per service, priced by the server (the doctor's price, else the
  catalogue price) and frozen on the line. A wrong line is **voided with a reason**, never edited or deleted.
- **Ledger** (`visit_transactions`): money actually received (`collection`) or paid back (`refund`), by method
  (`cash` / `terminal`).
  - The ledger is append-only: nobody can change or delete a row, not even the server.
  - Pressing "accept" twice, or printing a second terminal slip, records nothing new: one row per method per
    request.
- **Due** = charged − collected + refunded.
- **Full payment only**: the amounts must equal what is due. There is no debt or partial payment until the clinic
  sets that rule.
- **Kassa totals** are money received and paid back on a clinic day, by method and by staff member. A cashier
  sees their own; owner, manager and admin see the clinic's. These figures are **not revenue or profit**.
- **Not built, so never claimed:**
  - fiscal receipts;
  - card-terminal integration (the terminal is operated by hand; the kassa records what it did);
  - Click or Payme;
  - bank refunds. A refund here *records* that money was paid back; the cashier hands over cash or reverses
    on the terminal.

## Laboratory (Phase 3)

Owner decisions of 2026-10-08: a **walk-in lab queue** first, and tests are **paid before the sample is taken**.

```
Reception                          Kassa                              Laboratory (/lab)
─────────                          ─────                              ─────────────────
"Laboratoriya — tahlil topshirish"  the tests are lines of ONE bill    "Navbat": lab visits by number
→ tick tests / panels               (prices frozen when ordered)      → Chaqirish (call)
  (catalogue prices shown)          full payment → queue number       → Namuna olishni boshlash
→ "Ro‘yxatga olish"                 → tests become collectable        → sample taken in the work
                                                                         queue below, as before
                                                                      → Yakunlash (complete)
```

- **One bill.** A lab walk-in creates the lab order as before and puts each test on the visit's bill. The order
  gets no separate lab-kassa bill, so nothing is charged twice. Orders made outside a walk-in visit (for
  example from a booked appointment) keep their own bill in `/admin/lab-kassa`.
- **Paid before collection.** With the clinic's lab setting *payment before collection*
  (`paymentPolicy = before_collection`), the tests stay "awaiting payment" until the bill is paid in full; payment
  releases them. **The pilot clinic must have this setting on** (runbook).
- **Tests a doctor orders during a walk-in consultation** go on that same visit's bill. The kassa shows the
  added amount, even if the doctor has already completed the visit. These patients reach the lab through the
  existing work queue; they do not get a separate lab queue number yet.
- **Queue numbers** come from the same clinic-day counter as doctors' visits. The waiting-room screen shows
  the laboratory as its own column, "Laboratoriya".
- **Cancelling a test** happens in the laboratory, never at the kassa: the kassa has no "remove" button for a
  test line. Cancelling voids its line on the bill automatically.
  - If the test was not yet paid, the bill simply goes down.
  - If it was paid, the kassa shows the amount as **"Qaytarilishi kerak"** (to give back) and a refund is
    recorded there. This is the same rule as a cancelled paid lab order today. The plan had first proposed
    refusing the cancel until refunded; that was not built, because the lab must be able to stop a test it
    cannot perform.
- **Cancelling a lab walk-in at reception** (nothing paid) also cancels its tests in the laboratory. Once a
  sample has been taken, reception cannot cancel the visit; the lab rejects the sample or enters a result.

## Corrections

| Mistake | What to do | What the system keeps |
|---|---|---|
| Wrong service added | Kassa → "Olib tashlash" on the line, with a reason. If it was already paid, refund first: the system refuses a void that would leave the patient overpaid. | The voided line, who voided it, when and why |
| Wrong patient selected | Cancel the visit at reception (reason required; refund first if paid), then register the right patient | The cancelled visit, its voided charges, any refund |
| Registered twice | The second registration for the same doctor is refused while the first is unfinished. A retry after a network error returns the first registration. | — |
| Same person, second card | Refused when the passport, JSHSHIR, or name + date of birth match; reception is offered the existing card. Old duplicates are merged by the owner/administrator (patient merge). | Merge history; reversible |
| Paid, then the patient left | Refund (owner/manager, or cashier with a grant), then cancel the visit | Both ledger rows; who authorized and who executed |
| Wrong lab test ordered | Laboratory cancels the test (reason required); refund at the kassa if it was paid | The cancelled test, the voided line, any refund |

Clinical records are never rewritten. A doctor's correction is a new record (existing rule).

## Referrals

A referral shares the referring doctor's history with the receiving doctor **as soon as it is made**. There is
no accept step to read it (owner decision). Revocation, decline, completion and expiry still close that access.

Starting a consultation *from the referral* in the doctor's workspace still needs the referral accepted. A
patient who arrives as a walk-in for that doctor needs no acceptance: the visit itself is the relationship.

## Not in this pilot yet

- Discounts, partial payment, payment exceptions, and a payment gate for elective services. These wait for clinic
  rules.
- Named cashier shifts with opening and closing cash counts. Today totals are per clinic day.
- SMS tickets (no SMS gateway contract) and MyID/OneID identity (no contract).
- Lab collection booking by time slot (needs lab hours and per-slot capacity from the clinic).
- A lab queue number for tests a doctor orders during a consultation (they use the lab's work queue).
- Printed specimen labels and a generated lab report (owner prefers digital; printer model unknown).
- The waiting-room screen and the reception screen do not yet switch on `operating_mode`. Existing clinics are
  `mixed`: bookings keep working beside walk-ins.
- Inpatient care (Phase 5) and payroll (out of scope).
