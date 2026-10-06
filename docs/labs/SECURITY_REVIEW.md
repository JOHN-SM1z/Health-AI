# Laboratory Module — Security and Adversarial Review (Phase 19)

Date: 2026-10-06. Scope: every part of the Laboratory module (Phases 0–18) and what it shares with the rest of Health AI (payments, notifications, audit, settings, patients, storage). Local stack only. Nothing was deployed, and no hosted database was touched.

**Result:**
- **4 findings**, all reproduced, fixed and covered by regression tests:
  - 1 server/RLS parity gap on money;
  - 3 defence-in-depth gaps.
- **No finding allowed one clinic, patient or role to read or change another's laboratory data through the application.**

## Method

The system was attacked rather than read, at three layers.

| Layer | How it was attacked | Where |
|---|---|---|
| **Database** | **Requests as PostgREST runs them:** `set local role authenticated` with the user's JWT claims, for every staff role of two clinics, an outsider account and `anon`. Direct `select / insert / update / delete / truncate` on every lab table and the shared tables. Calls to every lab function.<br>**The server's own role (`service_role`), as a compromised or buggy server path would:**<br>• forged verification and payment states;<br>• rewritten history;<br>• cross-clinic ids in every function;<br>• concurrent writes;<br>• repeated requests. | `src/lib/supabase/lab-security-review.test.ts` (new, 15 attack groups) |
| **HTTP** | The real route handlers against the real database:<br>• no session;<br>• clinic A sessions with clinic B's ids (orders, items, results, samples, documents, imports, send-outs, payments, patients);<br>• bodies carrying a clinic id, orderer, price, amount or currency;<br>• cross-site (foreign `Origin`) writes;<br>• each role against routes outside its purpose;<br>• forged and concurrent payments. | `src/app/api/security/lab-redteam.test.ts` (new, 6 attack groups) |
| **Inventory** | Every grant, policy and function privilege for `anon` and `authenticated`. Storage buckets and policies. Every lab route, with its guard and write path. Default privileges for future tables. | queries recorded below; kept as assertions in the database suite |

It builds on the per-phase adversarial suites, which remain in force; see the coverage map below.

## Findings

| # | Severity | Finding | Reproduced | Fixed in | Regression test |
|---|---|---|---|---|---|
| **F1** | Medium (defence in depth) | `TRUNCATE`, `REFERENCES` and `TRIGGER` (and `MAINTAIN` on PostgreSQL 17) granted to `authenticated` on 11 public tables by Supabase's default privileges, and by default on every future table | yes | `20261005000021_lab_security_hardening.sql` | database suite, "F1" |
| **F2** | Medium (server/RLS parity) | Payment amounts, provider references, payment links and metadata — lab payments included — readable directly by manager, receptionist and doctor | yes | same migration | database suite, "F2 / 6 / 9"; HTTP suite, manager analytics |
| **F3** | Low (defence in depth) | JSON write routes did not check `Origin`: cross-site request protection rested on the `SameSite=Lax` cookie alone | yes | `src/lib/api/validate.ts` | HTTP suite, "F3" |
| **F4** | Medium (defence in depth) | The database accepted any clinic member as the person who **entered, submitted or verified** a result — a receptionist or owner as verifier, a doctor without access, or one ignoring the clinic's verifier setting | yes | same migration | database suite, "forged verification" |

### F1 — TRUNCATE (and MAINTAIN) for signed-in users

**Reproduced.** The grant inventory listed `TRUNCATE, INSERT, UPDATE, DELETE` for `authenticated` on:
`app_settings`, `clinics`, `doctor_services`, `doctor_time_blocks`, `doctor_working_hours`, `doctors`, `faq_entries`, `profiles`, `services`, `specialties` and `staff_roles`.

The default privileges of `postgres` in `public` granted `arwdDxtm` to `authenticated` on every new table. As a signed-in manager, `truncate public.app_settings` succeeded.

**Impact.**
- `TRUNCATE` ignores row level security. A session able to run SQL as `authenticated` could empty a table for **every clinic** at once. Emptying `app_settings`, for example, resets every clinic's lab settings to their defaults:
  - `releaseToPatient` back to true, releasing results a clinic had withheld;
  - the verifier policy back to its default.

  `MAINTAIN` similarly allows `LOCK TABLE`, which could be used to stall a table.
- **Not reachable over HTTP:** PostgREST never issues these commands, and no function executes them. Hence defence in depth, not an open hole.

**Fix.**
- Revoked `TRUNCATE`, `REFERENCES`, `TRIGGER` and (on PostgreSQL 17+) `MAINTAIN` from `anon` and `authenticated` on every public table.
- Revoked the same from the default privileges, so new tables never receive them.
- The PostgreSQL 17 part is conditional, so the migration also runs on older servers.

**Regression:**
- no public table grants these privileges to `anon` or `authenticated`;
- a freshly created table does not get them;
- `truncate app_settings` as a manager, and `truncate staff_roles` as lab staff, are both refused with `42501`.

### F2 — payment amounts readable directly (server/RLS parity)

**Reproduced.** The server shows money only to the payment roles (owner, admin — `canViewPaymentDynamics`; Phase 17 analytics return `finance: null` to a manager). But the `payments` SELECT policies, read directly through PostgREST, let managers, receptionists and a patient's doctor read whole rows:
- `amount`;
- `provider_reference` and `payment_url`;
- `metadata`.

This covered lab payments too.

The browser only ever reads `payments(status)` (the admin home and appointments pages).

**Fix.** `authenticated` now has column-level SELECT on `id, clinic_id, patient_id, appointment_id, lab_order_id, status` only. Row policies are unchanged. Every amount is read through the server, which applies the payment-role rule.

**Regression:**
- `select amount …` and `select metadata, provider_reference, payment_url …` are refused (`42501`) for manager, receptionist, doctor, and also owner (owners use the server too);
- the status is still readable;
- lab staff see no payment rows;
- nobody sees another clinic's.

### F3 — cross-site writes relied on one layer

**Reproduced.** With the origin check removed, a request carrying `Origin: https://evil.example` and a valid session created a lab order (`201`).

In a real browser, the `SameSite=Lax` session cookie is not sent on a cross-site POST, so this was one layer short rather than open. Only the upload routes (imports, documents) checked `Origin`, and `parseBody` accepted any content type.

**Fix.** `parseBody()` — the path every JSON write route takes — now refuses a foreign `Origin` (`403 cross_site_request`) before the body is read.
- Requests without `Origin` (server-to-server, webhooks) are unaffected.
- The browser flows send their own origin, and the full e2e run confirms they work.

**Regression:** a foreign `Origin` is refused on order creation, result save, verification, sample receipt, notification marking, payment and settings. Nothing changes: the payment stays unpaid.

### F4 — verifier, submitter and enterer eligibility only in the server

**Reproduced.** As the server role, `update lab_results set status = 'verified', verified_by = <receptionist>` returned `UPDATE 1`, and `verify_lab_result(…, <receptionist>)` was accepted. The database checked only:
- "a staff member of the clinic";
- "not the enterer or submitter".

The real rule lived only in TypeScript (`result.enter` / `result.verify` + `resolveLabResultAccess`):
- lab staff, or a doctor with access to the patient;
- the clinic's `verifiers` setting.

The HTTP path always enforced it. A server bug or a leaked service key would not have been stopped.

**Fix.** A new trigger, `lab_results_check_handlers` (helper `lab_result_handler_ok()`), enforces in the database that whoever **enters, submits or verifies** a result is:
- lab staff of the clinic; or
- a doctor of the clinic whom `doctor_patient_access()` admits to the patient.

The **verifier** must also match the clinic's `verifiers` setting (`lab_and_doctor` / `lab_only` / `doctor_only`). This applies to every path:
- the verify, correction and import functions;
- external results;
- direct updates.

**Regression:**
- receptionist, owner, admin, manager, a doctor without access, and another clinic's lab staff are refused as verifier, by direct update and by `verify_lab_result`;
- `lab_only` refuses the patient's doctor, and `doctor_only` refuses lab staff;
- receptionist, owner and a doctor without access are refused as enterer.

**Side effect:** several older test fixtures, written before the lab role existed (Phase 2), entered or verified results as the receptionist or manager. They now use lab staff. The assertions are unchanged.

## The 15 required properties

| # | Property | Evidence |
|---|---|---|
| 1 | Clinic A cannot read clinic B's lab data | Database: no direct access to any server-only lab table, and catalog rows of B invisible even by id. HTTP: every route with B's ids returns 404; A's queue never lists B's work. Per-phase cross-clinic tests (history, documents, imports, send-outs, dashboards, summaries). |
| 2 | Clinic A cannot write clinic B's lab data | Database: no write grant on any lab table for any role. Every function refuses mixed-clinic ids (patient, test, order, sample, staff, correction). Composite keys make cross-clinic rows impossible. HTTP: result save, correction, sample reject, collection, send-out and payment with B's ids → 404, and B is untouched. |
| 3 | Doctor A cannot modify doctor B's result | Results are entered, verified and corrected only by lab staff or doctors with access (server, and now the database — F4). A verified result is frozen (property 10). The verification suite covers a doctor without access → 404. |
| 4 | Doctor A cannot access unrelated patients | `doctor_patient_access()` in RLS and the server; `lab_doctor_accessible_patients()` for dashboards. History, results, documents, dashboard and summary each return 404 for an unrelated or other-clinic patient; a revoked referral removes the patient at once (Phases 10, 17, 18). |
| 5 | Reception cannot access restricted clinical content | Result entry, documents and doctor history → 403. The queue carries no values. RLS gives reception no result tables. Clinical text is never read by lab code (isolation guards). |
| 6 | Lab staff cannot access unrelated financial / admin data | Kassa, payments, lab settings, providers and analytics → 403. RLS shows lab staff no payment rows; amounts are not readable directly for anyone (F2). |
| 7 | Patients cannot access another patient's results | Patients have no database identity: an outsider account and `anon` see no patient or lab row. Mini App results are reached only through the verified-`initData` gateway; another patient's or an unverified result → 404 (Phase 12 suite). |
| 8 | Unauthenticated users cannot access results / documents | Every lab route → 401 without a session. `anon` has no grant on any lab table. The documents bucket is private and only `service_role` reaches it; files are delivered as 60-second signed links after authorization (Phase 11). |
| 9 | Payment status cannot be forged | **Signed-in roles:** no write on `payments`.<br>**Server:** an unpaid lab bill must equal its order; a paid one cannot change amount or subject; one bill per order.<br>**HTTP:** only owner/admin may record; the amount and currency in a request are ignored; five concurrent "paid" requests → one transition and one audit row. |
| 10 | Finalized results cannot be silently changed | Even as the server role, these are refused on a verified result:<br>• changing values;<br>• deleting values or the result;<br>• changing status;<br>• changing verifier;<br>• moving it to another clinic.<br>A change is a correction: a new version, audited (Phase 9). |
| 11 | Version history cannot be rewritten | Reviving a superseded version, cutting the `supersedes` chain and renumbering versions are all refused. The history reads version 1 superseded, version 2 verified. |
| 12 | Audit history cannot be modified through application paths | Signed-in owners and admins cannot insert, update or delete audit rows. The server role cannot update or delete them either (append-only trigger). Management reads only its own clinic's audit trail; lab staff read none. Audit rows carry no values. |
| 13 | Imported records cannot escape clinic boundaries | An import row cannot reference another clinic's patient, test or batch (composite keys). `run_lab_import` under another clinic's id is refused. The imports suite (Phase 13) covers matching within the clinic only. |
| 14 | External provider callbacks cannot inject results into another clinic | **Send-outs:** another clinic's provider is refused under either clinic id.<br>**Results:** recording a send-out's result under another clinic is refused; a row tying A's item to B's provider cannot exist.<br>**Webhooks:** looked up by provider and clinic (`handleProviderWebhook`); unknown orders are ignored; signatures are required (Phase 15 suite). |
| 15 | AI cannot receive another clinic's / patient's data | The summary reads only through the lab history gate (`doctor_patient_access`). An unauthorized or other-clinic patient → 404 with the provider never called. The model receives only computed statements: no identity, comments, free text or documents (Phase 18 suite with a recording provider; source guard). |

**Concurrency and repeated requests:**
- three desks collecting the same test → one sample;
- two second persons verifying at once → one verification and one audit row;
- the same order key three times → one order;
- five concurrent payments → one transition.

## Server / RLS parity

| Data | Server rule | Database rule | Parity |
|---|---|---|---|
| Lab results, values, documents, imports, provider data, send-outs | read by role and purpose, audited | no grant for signed-in roles (server only) | ✓ — the database is stricter |
| Lab orders, items, samples | status only, by role; doctors per patient | no grant; dormant RLS policies mirror the server rule | ✓ |
| Lab catalog | read by clinic staff | SELECT for clinic staff of that clinic (RLS) | ✓ |
| Payments | money for owner/admin only | row policies + **status columns only** (F2) | ✓ — was ✗ |
| Who may enter / verify a result | lab, or doctor with access; clinic verifier setting | **same, enforced by trigger** (F4) | ✓ — was partial |
| Notification jobs | in-app inbox per recipient through the server | management may read rows (ids only, no wording or values) | ✓ — ids only |
| Audit | written by the server, ids only | append-only, tenant-checked; management reads own clinic | ✓ |
| Lab settings | management, validated field by field | management may write `app_settings` directly (existing policy); every read re-validates with safe defaults | ✓ — a malformed value can never loosen the workflow |
| Functions | — | only RLS helpers and one pure normaliser are callable by signed-in users | ✓ — asserted as an allow-list |

## Checked, no finding

- **Every lab route has its guard:**
  - capability (`requireLabCapability`), role, linked doctor, Mini App patient, cron secret, or adapter-authenticated webhook;
  - ids validated as UUIDs (404 otherwise);
  - clinic always from the session.
- **Request bodies never carry authority:**
  - a clinic id, orderer, price, amount or currency in a body is ignored (zod strips unknown keys);
  - another clinic's patient or test is refused.
- **Documents:** private bucket, `service_role`-only storage policy, signed links after authorization, and byte-level type checks (Phase 11).
- **Webhooks:** looked up by provider and clinic; signatures checked in constant time; payloads never stored or logged (Phase 15).
- **Cron:** `/api/lab/providers/process` requires `CRON_SECRET`.
- **Rate limits** on the reading and import endpoints (shared, database-backed).

## Residual risks and recommendations

1. **The service role is still all-powerful by design.** F4 and the other triggers mean that a leaked key or a server bug can no longer forge:
   - verifications;
   - frozen results;
   - payment amounts;
   - audit rows;
   - cross-clinic rows.

   It can still read everything. Keep the key server-only, rotate it on suspicion, and do not use it from scripts outside the deployment.
2. **The manager's direct write access to `app_settings`** (existing policy) lets a manager change any clinic setting without the server's validation. Reads re-validate, so this cannot loosen the lab workflow, but writing settings only through the server would be cleaner.
3. **Production rollout:** apply `20261005000021_lab_security_hardening.sql` with the other lab migrations. It changes privileges only for `anon` and `authenticated` and adds one trigger; no data changes. After applying it, check that no other client code reads `payments.amount` directly. In this repository none does.
4. **Not covered by automated tests:** a real external provider and a real AI provider, since neither is configured. Both are built to fail closed (Phases 15 and 18).

## Test results

Local run after a clean database rebuild:

**Rebuild.** `supabase db reset` could not pull a newer storage image (Docker Hub rate limit). The database was rebuilt by:
1. restarting the auth and storage services;
2. applying all 68 migrations and the seed with `psql`;
3. seeding the demo clinic.

**Results:**
- `npm test`: **1039/1039** across 108 files, including the two new suites (database 15, HTTP 6).
- `npm run test:e2e`: referral 84/84, booking 9/9, staff & safety 14/14, lab configuration 11/11, lab ordering 14/14, lab collection 12/12, lab result entry 11/11, lab verification 13/13, lab history 12/12, lab documents 12/12, lab patient results 10/10, lab import 18/18, patient merge 14/14, lab external 13/13, lab notifications 7/7, lab dashboards 10/10, lab AI summary 8/8, HTTP red team 55/55.
- Lint, typecheck and build pass; `full-db-setup.sql` regenerated.

**Outside this module.** One unrelated, pre-existing test failure was seen. It occurs only when the suite runs in the last ~15 minutes before midnight, Tashkent time: `workspace.test.ts`, near-midnight walk-in branch. The booking engine's working-hours guard was checked directly and is correct. The test's time arithmetic is the issue, and a separate task has been suggested. The test passes at any other time, including the final run.
