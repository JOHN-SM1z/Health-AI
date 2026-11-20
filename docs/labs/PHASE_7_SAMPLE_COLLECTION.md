# Laboratory Module — Phase 7 Sample Collection and the Work Queue

Status: **implemented and tested locally; not deployed.** The migration has not
been applied to any hosted database.

## Lifecycle (the approved enums, no duplicates)

The lab item status from Phase 1 is used unchanged:

```
ordered ─(paid, if the clinic requires it)→ ready_for_collection → collected → processing → resulted → verified
                                                   ↑                  │            │
                                                   └── sample rejected ┴────────────┘
```

`RESULT_ENTERED` in the prompt is the existing `resulted`. Specimens keep their
own status (`lab_sample_status`): `collected → received`, or `rejected` (with a
reason) from either.

## Database (`20261005000009_lab_sample_collection.sql`)

Three server-only functions (SECURITY INVOKER, `service_role` only, so every
existing trigger and constraint still applies):

| Function | Does, in one transaction |
|---|---|
| `collect_lab_sample(clinic, order, item_ids[], collected_by, notes?, creation_key?)` | locks the items (fixed order, no deadlocks); replays the same collector's same key; requires an active order, items of **that** order in **that** clinic, every item `ready_for_collection` and all of one sample type; generates the code (`YYMMDD-XXXXXX`, unique in the clinic); inserts the sample and its links; items → `collected` |
| `receive_lab_sample(clinic, sample, received_by)` | sample → `received`; its collected items → `processing`; repeat is a no-op |
| `reject_lab_sample(clinic, sample, rejected_by, reason)` | reason required; refused once any of the sample's items has a result (even a draft); sample → `rejected`; items → `ready_for_collection` for a new sample |

Plus `lab_samples.creation_key` with a unique index on
`(clinic_id, collected_by, creation_key)`.

The sample's patient and clinic come from the order row, never from the
caller. Together with the composite foreign keys and
`lab_sample_items_validate` from Phase 1, a sample cannot be assigned to
another clinic or another patient, even by a direct service-role write.

Refusals: a cancelled or completed order, a cancelled item, an item still
`ordered` (awaiting payment under the "before collection" policy), an item
that already has a live sample, an item of another order or clinic, mixed
sample types in one tube, and a collector, receiver or rejecter from another
clinic.

### Concurrency

The item rows are locked before any check. Of two collectors submitting the
same test at once, one creates the sample and the other gets
`already_collected`. Two submits with the **same** key (a double tap)
resolve to one sample: the waiter re-checks the key after the lock and
replays.

## Access

New capability `queue.read` (operational group): owner, manager, admin,
receptionist, lab. Doctors are excluded because the queue lists every active
order in the clinic, and doctors never get clinic-wide patient lists.

| Action | Roles |
|---|---|
| See the queue, find a patient, order a walk-in | `queue.read` |
| Collect a sample | `sample.collect`: receptionist, lab |
| Receive / reject | `sample.process`: lab |

The queue carries only what collection needs:
- patient name and date of birth (to label and match the tube);
- test names and codes;
- the sample type and preparation;
- item and sample status;
- sample codes and operational notes or rejection reasons.

It never carries result values, flags, lab comments, doctor notes, diagnoses,
referrals or phone numbers. Patient search shows the last four phone digits
only.

Audit: the existing id-only triggers record `lab_sample_collected`,
`lab_sample_received` and `lab_sample_rejected`, plus item status changes,
with the actor. Notes and reasons are never copied into audit rows.

## API (`/api/lab/*`)

| Route | Capability |
|---|---|
| `GET /api/lab/queue` | `queue.read`: active orders, newest first, at most 200 |
| `GET /api/lab/catalog` | `queue.read`: orderable tests and panels |
| `GET /api/lab/patients?q=` | `queue.read`: up to 10 patients of the clinic |
| `POST /api/lab/orders` `{ idempotencyKey, patientId, testIds, panelIds }` | `queue.read`: walk-in through `create_lab_order` (catalog prices, bill created) |
| `POST /api/lab/orders/[id]/samples` `{ idempotencyKey, itemIds, notes? }` | `sample.collect` |
| `POST /api/lab/samples/[id]` `{ action: "receive" }` or `{ action: "reject", reason }` | `sample.process` |

Clinic and actor always come from the session.

## UI

`src/components/lab/work-queue.tsx` is shared by:
- `/lab` (lab staff: collect, receive, reject, walk-in);
- `/admin/lab-queue`, "Namunalar" in the admin navigation (reception: collect and walk-in; management: view and walk-in).

The views are: Namuna olish, Qabul kutilmoqda, Jarayonda, Barchasi.

The ready tests in an order are grouped by sample type, with one "… namunasini olish (n)" button per tube. The collection dialog:
- asks staff to confirm the patient's name and date of birth;
- shows the preparation;
- shows the generated code, to write on the tube.

The walk-in flow reuses the doctor's order dialog in desk mode. It has no recent-result warning, because the desk sees no results.

## Tests

| Suite | Covers |
|---|---|
| `src/lib/supabase/lab-collection.test.ts` (13) | lifecycle and audit, mixed types, cancelled order / item, unpaid under "before collection", other order / patient / clinic (including a direct link insert), second sample refused, key replay and reuse, **3-way race → one sample (×5)**, **same-key race → one sample**, reject → recollect, reject refused once a result exists, cross-clinic receive / reject, no grants to signed-in roles |
| `src/app/api/lab/lab-queue.test.ts` (8) | role matrix (doctor / anonymous refused; manager and owner cannot collect; reception cannot process), walk-in with catalog price (a forged price is ignored) and replay, queue payload has no values or clinical keys, collect → receive → reject → recollect, API race → one 201 and two 409s, cancelled order, cross-clinic isolation |
| `src/lib/labs/permissions.test.ts` (+1) | `queue.read` excludes doctors |
| `e2e/lab-collection.mjs` (12) | in a browser: reception walk-in order and one tube for two blood tests, no receive for reception, lab receives / collects / rejects, id-only audit, doctor refused |

Local run after a clean `supabase db reset` (real Supabase stack):
- `npm test`: 828/828 across 83 files.
- `npm run test:e2e`: referral 84/84, booking 9/9, staff & safety 14/14, lab configuration 11/11, lab ordering 14/14, lab collection 12/12, HTTP red team 55/55.
- Lint, typecheck and build pass, and `full-db-setup.sql` is regenerated (`--check` passes).

## Not in this phase

- Barcode label printing: codes are shown on screen. No printer integration exists in the repository to reuse.
- Cancelling orders or items from the queue: no cancel route exists yet.
- Result entry: this is Phase 8. Rejecting a sample is refused once a result exists.
- Queue pagination beyond the newest 200 active orders: the screen says when the limit is reached.

## Open questions for the owner

- Should receptionists keep the right to collect samples? (Currently yes, per the Phase 3 table.)
- Do tubes need printed barcode labels, and if so on which printer? This decides how sample codes are produced beyond the screen.
