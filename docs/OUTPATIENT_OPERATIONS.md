# Outpatient operations — how the pilot works

This document covers the walk-in flow built for the outpatient pilot (migrations `20261007000001`–`03`). The rules
come from the owner's decisions of 2026-10-07; nothing here invents a clinic policy. Where the clinic still has to
decide, the section says so.

## The flow

```
Reception (/admin/reception)        Kassa (/kassa)                     Doctor (/doctor)
───────────────────────────        ──────────────                     ────────────────
find patient (№ / JSHSHIR /         itemized bill (server prices)       "Jonli navbat": own patients
 passport / phone / name)           charged · paid · refunded · due      in queue order
→ confirm identity (tick)           take FULL payment, cash and/or     → Chaqirish (call)
  or create a new patient             card terminal (split allowed)     → Qabulni boshlash (start):
→ doctor + services                 → queue number issued                 opens the patient card;
→ "Ro‘yxatga olish"                  (Telegram ticket, hall screen)      notes are written as usual
  (no money at reception)                                               → Yakunlash (complete)
```

- **A queue number is arrival order for the clinic day, not an appointment time.** Every screen and the
  Telegram ticket say so.
- **No paper ticket** (owner decision). The patient gets the number by:
  - the kassa saying it aloud;
  - a Telegram message, if the patient's Telegram account is linked (verified identity only);
  - the waiting-room screen `/queue/<clinic id>`, which shows numbers and doctor names only — never a patient
    name;
  - the Mini App page "Mening qabullarim", which shows the live position.
- **When the number is issued:** on full payment (`clinics.queue_after_payment = true`, the default). A free
  visit is queued at registration.
- **Unfinished visits stay in the queue across midnight.** Their number keeps its day; they are listed before
  the new day's numbers.

## Who may do what

| Action | Owner | Manager | Admin | Receptionist | Cashier | Doctor |
|---|---|---|---|---|---|---|
| Register an arrival, create a patient | ✓ | ✓ | ✓ | ✓ | — | — |
| Call or cancel at the desk | ✓ | ✓ | ✓ | ✓ | — | own patients: call only |
| Take payment | ✓ | ✓ | ✓ | — | ✓ | — |
| Refund (full or partial, reason required) | ✓ | ✓ | — | — | only with a grant | — |
| Give or withdraw a cashier's refund grant | ✓ | ✓ | — | — | — | — |
| Start or complete a consultation | — | — | — | — | — | the visit's own doctor |

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

## Corrections

| Mistake | What to do | What the system keeps |
|---|---|---|
| Wrong service added | Kassa → "Olib tashlash" on the line, with a reason. If it was already paid, refund first: the system refuses a void that would leave the patient overpaid. | The voided line, who voided it, when and why |
| Wrong patient selected | Cancel the visit at reception (reason required; refund first if paid), then register the right patient | The cancelled visit, its voided charges, any refund |
| Registered twice | The second registration for the same doctor is refused while the first is unfinished. A retry after a network error returns the first registration. | — |
| Same person, second card | Refused when the passport, JSHSHIR, or name + date of birth match; reception is offered the existing card. Old duplicates are merged by the owner/administrator (patient merge). | Merge history; reversible |
| Paid, then the patient left | Refund (owner/manager, or cashier with a grant), then cancel the visit | Both ledger rows; who authorized and who executed |

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
- Lab orders billed through the visit's bill. Lab orders still have their own lab kassa (Phase 3).
- The waiting-room screen and the reception screen do not yet switch on `operating_mode`. Existing clinics are
  `mixed`: bookings keep working beside walk-ins.
- Inpatient care (Phase 5) and payroll (out of scope).
