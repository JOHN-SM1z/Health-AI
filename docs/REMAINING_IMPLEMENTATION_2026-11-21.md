# Health AI remaining implementation work

21 November 2026, Asia/Tashkent. This checklist updates the affected findings in the [103-requirement specification audit](SPECIFICATION_GAP_AUDIT_2026-11-20.md). The baseline commit is `ea34dd2` on `codex/clinic-operations-pilot`. The [baseline GitHub run](https://github.com/JOHN-SM1z/Health-AI/actions/runs/44790541765) passed its static/build, database/browser, and server-image jobs.

## Fixes in this working tree

| Area | Change |
| --- | --- |
| Online booking identity | Clinics with mandatory online identity require clinic-bound signed Telegram data and a completed online card before any patient or appointment write. Staff registration and the specified first-visit desk confirmation flow remain distinct. |
| Reception search | Reception sends search fields in a bounded JSON POST and receives a private, uncached response. Date-of-birth lookups record actor, matched patient IDs when available, and lookup outcomes without document or date values. |
| Patient safety and Telegram | Regression phrases now use urgent escalation. Human takeover checks fail closed. Telegram rejects patient automation outside private chats and rejects malformed webhook bodies before claiming them. |
| Private voice lifecycle | Consent and tracking are checked before media processing. Retention handles partial cleanup and records completion after quoted transcripts are redacted. Structured diagnostics omit provider bodies and raw errors from the repaired paths. |
| Eskiz callbacks | Authentication safely rejects malformed keys. Database update errors return a retryable response with a static diagnostic. |
| Payment and reminder logs | Click webhook and notification worker diagnostics omit raw exceptions and payment references on failure. |
| Database readiness | The health probe supports both legacy JWT service-role keys and opaque secret keys and checks only the response status. [Supabase key migration guide](https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys) |
| Test isolation | Each Vitest run passes its own database readiness result to its workers. An overlapping run can no longer make a required integration suite silently skip. |
| Backups | The Uzbekistan backup script streams encrypted archives, publishes a completed marker after off-site copy, and replicates only encrypted sets. CI includes a synthetic encryption and decryption check. |

## What still needs to be done

**Update, 27 November 2026.** Part of sequence 7 is built on `claude/w13-prescribing-and-pentest`: ICD-10 catalogue and picker, structured allergies, the drug catalogue with search and clinic formulary, and the prescribing workflow with signing, replacement, cancellation, the national-number hand-over and a verifiable printed copy. See the [implementation record](STRUCTURED_PRESCRIBING_2026-11-27.md) for what that covers and what it leaves. The same branch carries a [security assessment](SECURITY_ASSESSMENT_2026-11-27.md); its open findings add to sequences 1, 5 and 6 below, most importantly the urgent-wording detector before any patient-facing AI or voice. Licensed catalogue data, the consultation recorder and patient delivery of signed documents are still to do.

| Sequence | Work | Start or release condition |
| --- | --- | --- |
| 1 | **Hosted readiness.** Review the pilot merge into canonical `main`, bind the release image to the source and migration ledger, apply the two existing notification claim RPCs, enable leaked-password protection, and rerun compatibility and advisor checks. Reconcile stale appointments and payments, orphaned staff records and legacy tables with clinic staff. | On 21 November, the read-only hosted preflight still returned both missing RPCs, and the Auth advisor still reported leaked-password protection disabled. Apply the prepared migration on the target before releasing the corresponding workers. |
| 2 | **Identity encryption and full access audit.** Encrypt passport/ID, JSHSHIR, birth date and address, including temporary copies. Add versioned keys, keyed lookup tokens, a rehearsed backfill with rollback, protected read/write paths, owner-only corrections, and complete identity-read audits. | Design separately for patient merge, age calculations, all search and OneID paths, exports and key rotation. Browser URLs no longer carry reception lookup values. Server-to-database queries still use plaintext identity filters. |
| 3 | **Queue, holds and worker recovery.** Coordinate hold expiry, slot release and settlement within transactions. Give reception an overdue pending-booking inbox and late-payment review. Add durable background recovery and verify Telegram inbound claim ownership through side effects, lease expiry and finalization. | Confirm hold durations and late-payment/refund policy. Run expiry, payment and rebooking race tests before enabling online payment. Prove safe recovery for interrupted webhook work and uncertain delivery before extending Telegram automation. |
| 4 | **Live payments and messaging.** Implement the contracted Rahmat adapter, payment status/refunds, daily settlement reconciliation, approval around fiscal receipts, and consolidated pay-now/pay-at-clinic UI. Complete approved bilingual Telegram and SMS templates, deterministic fallback and usage alerts. Verify Eskiz delivery and retry behavior and exercise OneID in its sandbox. | Requires the corresponding contracts, credentials and clinic decisions. Account for SMS callbacks arriving before a receipt exists. Configure proxy and platform logs to mask the Eskiz callback query credential. |
| 5 | **Shared booking agent and reception requests.** Build the tool-based shared conversation flow, authorized tool contracts, clinic-approved routing, grounded replies, explicit slot and price read-back, confirmed writes, model limits and per-clinic budgets. Add staff requests, callbacks, call summaries, outcome tracking and doctor attribution. | Start with Telegram text and require the multilingual safety and booking evaluation before enabling patients. Verify durable urgent staff escalation and test human takeover while provider requests are in flight. |
| 6 | **Phone and voice-first booking.** Build full conversational Telegram voice booking and add PBX/SIP, streaming speech, per-clinic routing, verified caller proof, disclosure, transfer, voice interruption and fallback. Inventory older private voice objects with no retention pointer. | Complete the required speech evaluation, privacy approval, provider configuration and telecom contract. |
| 7 | **Doctor and patient tools.** Add ICD-10 and structured allergies, licensed drug catalog and prescribing workflow, national integration where approved, consented treating-doctor-only documentation and signing, and patient-authorized signed-document delivery/history. | Depends on data licenses, provider and regulatory approvals where relevant, separate consent rules, and clinical validation. All prescribing and signing stay clinician-controlled. |
| 8 | **Production recovery and pilot acceptance.** Provision the recovery public key and the separate recovery service, verify a consistent database and storage snapshot and a full off-site restore, and exercise rollback and monitoring. Finish the data map, processor agreements, and evidence for the five specification evaluations covering multilingual dialogues, speech, tool grounding, consultation drafts, and drug search. | The live restore drill, real messaging/payment acceptance, accessibility, availability, load and supervised pilot still need signed-off evidence. |

## Verification

- PostgreSQL 17.6 passed a clean install of 94 migrations and an upgrade from 84 baseline migrations through 10 forward migrations. Both paths and the SQL-editor bundle produced equivalent schemas.
- All 22 notification claim checks passed, including lease expiry, cancellation, operator takeover, and RPC grants.
- The isolated production build passed, and its standalone health check returned HTTP 200 against the loopback database.
- The backup fixture passed encryption, decryption, and failure checks with synthetic files.

- The complete browser run passed 522 checks across 25 workflows. Lint and TypeScript passed. The full database-backed suite ran 1,415 tests with zero skips. Its sole failing referral fixture was corrected, and all 23 tests in that suite passed on rerun.

No hosted settings, patient records, migrations, or deployments were changed by this follow-up.
