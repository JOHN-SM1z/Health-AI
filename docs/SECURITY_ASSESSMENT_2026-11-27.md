# Security assessment — 26–27 November 2026

White-box review and local penetration test of `codex/clinic-operations-pilot` @ `3eb2d66`, plus the structured-prescribing work added on top of it. This is the penetration-test summary the specification asks for in §16.4.

The review found one flaw that let anyone mark an appointment as paid, and it is fixed here. Five other findings are fixed or mitigated in this branch. The most serious open finding is in patient safety: the urgent-wording detector missed 142 of 202 realistic emergency phrasings, so patient-facing AI and voice should stay off until it is rebuilt on a clinic-approved list. No finding gives an anonymous visitor or another clinic access to patient data.

## Scope and method

| | |
| --- | --- |
| Target | The repository at the commit above: 148 API routes, 94 migrations, the Telegram bot and Mini App, the AI and voice code, deployment files |
| Where | A local disposable Supabase stack and a local production build. No production host, no hosted Supabase project, no real Telegram, payment or SMS endpoint was contacted, and no real patient data was read |
| Tools | gitleaks (full history), Semgrep (19 rulesets plus Trail of Bits and elttam rules), osv-scanner, `npm audit`, Trivy, the repository's own red-team suite |
| Method | Four independent reviews by code reading — API authorization and tenant isolation; database RLS, grants and functions; AI, Telegram and voice; static analysis and supply chain — using Anthropic's `claude-security` plugin, Trail of Bits skills and the OWASP Top 10 checklist. Detector and filter results come from probe scripts run against the repository's own pure functions |

Three limits apply to every statement below.

- The reviews are static unless a row says "probed" or "tested". The hosted project's real settings, grants and auth configuration were not inspected; [the catalog queries](#checks-to-run-on-the-hosted-database) settle them.
- No language model was called. "Passes the filter" means the output filter would let the string through if a model produced it.
- I re-read the code for every finding marked **fixed** or **mitigated** and for DB-1. The other open findings are as reported by the review that found them, each traced through the code by that review.

## Fixed in this branch

| ID | Severity | Finding | Fix | Evidence |
| --- | --- | --- | --- | --- |
| SAST-1 | High | **Forged Click callback marks a payment paid.** `/api/payments/click/complete` was live in every configuration and verified the signature against `CLICK_SECRET_KEY ?? ""`. With manual payments (the only production mode) the key is empty, so anyone who booked an appointment could compute the signature and set its payment to `paid`. A signed callback reporting a failed payment was also completed. | The Click endpoints answer 404 unless Click is the configured provider with its secret and service id. The service id is always checked. A callback with a non-zero `error` never reserves or completes a payment. [`click-webhook.ts`](../src/lib/payments/click-webhook.ts) | 3 new tests; probed against the production build (see [verification](#verification-of-this-branch)) |
| API-3 | High where logins are shared, otherwise Medium | **Clinic-level password reset takes over an account used elsewhere.** `resetStaffPassword` checked only that the account had a role in the caller's clinic, then reset the account's one password and showed it. | Refused when the account has a role in any other clinic or is a platform administrator; fails closed if that cannot be checked. [`manage.ts`](../src/lib/staff/manage.ts) | Code review; no automated test yet |
| AI-2 (part) | High, patient safety | **Urgent wording in the booking reason was stored, not acted on.** A patient could book next week with "ko'kragim og'riyapti, nafas ololmayapman" as the reason. | The booking stops with the approved urgent-care message and staff are alerted, the same as the concern step. [`bookings/route.ts`](../src/app/api/bookings/route.ts) | 2 new tests |
| DB-1 (part) | High, insider | **Re-linking a doctor record left no trace.** See the open half below. | Every change of `doctors.profile_id` now writes an audit row from a database trigger. [migration](../supabase/migrations/20261126000002_doctor_account_link_audit.sql) | Applied in the full suite |
| DEP-1 | Mitigated | **Image-optimizer advisories in Next 16.3.0** (two rated critical). `next/image` is not used. | The optimizer endpoint is switched off and answers 404. [`next.config.ts`](../next.config.ts) | Probed |
| — | — | A `CHECK` constraint in the new allergy table accepted a missing reason (a `NULL` comparison). Found by this branch's own tests before it shipped. | Constraint names the `NOT NULL` explicitly | Test |

## Open findings

Ordered by what should happen first. "Decision" means the fix changes product behaviour and needs the owner or the clinic's medical lead.

### Before patient-facing AI or voice is switched on

| ID | Severity | Finding | Recommended fix |
| --- | --- | --- | --- |
| AI-1 | High, patient safety | **The urgent detector misses most real phrasings.** 60 of 202 urgent test phrases were detected. Whole categories are nearly absent: allergic reaction 0 of 11, suicidal intent 1 of 14, poisoning 2 of 15. Causes: exact-form keywords ("потерял сознание" hits, "мама потеряла сознание" misses), a pattern that misses "bolam nafas olmayapti", no ё/е folding, thin Uzbek Cyrillic coverage, four apostrophe variants not folded. This extends the known R-02 / AG-11 gap with numbers. [`policy.ts`](../src/lib/safety/policy.ts) | **Decision (medical lead).** A clinic-approved list per language, matched on stems after Unicode normalisation; the probe corpus becomes a required test. The corpus used here is the reviewer's, not clinic-approved. |
| AI-2 (rest) | High, patient safety | **Three entry points still skip the detector.** The Mini App voice transcript is returned unchecked; the bot's voice transcript is checked only after the patient taps "To‘g‘ri"; photo, video and document captions are dropped unread. | Run the detector as soon as a transcript exists and on captions; answer unsupported media with "please type or call". |
| AI-3 | Medium, patient safety | **"Staff were alerted" is said without proof** (R-03). The urgent notice's send result is ignored and stored as sent; the Mini App shows "Klinika xodimlariga xabar berildi" even when escalation failed or was skipped. The alert itself is a flag on a page someone must have open. | Fail and retry when the urgent send fails; return and render `alerted`; add an active staff channel. |
| AI-4 | Medium | **False positives lock patients out, and the urgent flag never clears.** 15 of 20 ordinary sentences are flagged ("У меня заболел зуб…", "Не срочно…", a doctor named O‘tkir). The bot then answers every button with "wait for the operator", and nothing ever clears `urgent_at`, so stale flags bury real ones. The booking-reason fix above widens the reach of these false positives to website bookings. | **Decision (medical lead)** on wording; add a staff "resolved" action. |
| AI-5 | Medium | **The model output filter is a short denylist.** 52 of 57 unsafe strings pass, including dosing advice in three languages, "no need to see a doctor", and invented confirmations ("Qabulingiz tasdiqlandi… To‘lov qabul qilindi"). One Russian pattern cannot match Cyrillic at all. Nothing checks prices, hours or bookings against clinic data. | Treat the filter as a backstop: have the model return structured intent and render text on the server, as the specification's agent design (AG-01, AG-04) already requires. |
| AI-6 | Medium | **Every Telegram message is sent as HTML with unescaped text.** A link written into a service, doctor or FAQ field renders as a link in the clinic's official bot for every patient. A stray `<` in a service name makes Telegram reject the message, and for reminders that means the job is never resent. | Plain text by default; escape where markup is needed; record a failed send. |
| AI-7 | Medium | **The lab-summary validator checks numbers and a word list, not meaning.** It accepts an inverted statement, swapped latest and previous values, a dropped value, and advice with no listed stem ("Zudlik bilan qon quying"). Doctor-only and opt-in, but it contradicts the rule that a summary is shown only if every statement checks out. | Have the model choose among server templates, or require each number once with its unit and the flag phrase verbatim. |
| AI-8 | Medium, privacy | **Transcripts and symptom text go to an unrestricted model host.** The speech host is allow-listed; `AI_BASE_URL` accepts any URL, including `http://`, and follows redirects. Voice consent text does not name the providers or the stored copy. | Apply the speech host policy to the model host; reword consent. |

### Before the pilot

| ID | Severity | Finding | Recommended fix |
| --- | --- | --- | --- |
| DB-1 (rest) | High, insider | **Management can become any doctor.** `PATCH /api/admin/doctors` lets an owner, administrator or manager point a doctor record at another doctor-role account. That account then reads the doctor's patients and writes records under the doctor's name, which defeats "clinical text is never shown to operational staff". Now audited, still allowed. | **Decision (owner).** Refuse a re-link once the record has clinical history, or restrict it to the owner with a second confirmation. Ready SQL is in the database review notes. |
| API-4 | Medium | **A merge can move a Telegram link onto a patient's card.** Merge blockers only look for contradictions, so a blank Telegram-only card merges into any card; the owner or administrator who did it then reads that patient's released lab results in the Mini App. Audited and reversible, but no second person is involved. | Require positive identity evidence for a merge; never carry a Telegram link onto a card with clinical or lab data. |
| DB-2 | Medium | **Owners can write `staff_roles` directly through the REST API.** The table kept its original write grant and policy, so the server's rules (seat limits, owner-role ban, login uniqueness) can be bypassed, and an account from elsewhere can be bound to the owner's clinic, which re-scopes that person's session. | Revoke insert, update and delete from `authenticated` and drop the "manage for owner" policy; all management already goes through the server. Two existing tests assert the current behaviour and need updating. |
| DB-3 | Medium | **Deactivating a clinic does not stop direct REST access.** The server refuses staff of a switched-off clinic and accounts on a temporary password; RLS does not, so patient names, phones, chats and voice notes stay readable with the same token. | Add `clinics.is_active` to `is_clinic_staff`, `current_doctor_id`, `is_linked_doctor` and the voice storage policy. |
| SAST-3 | Medium | **Request bodies are read without a size limit before authentication** on 95 of 99 JSON routes and the webhooks; the reverse proxy sets none. A few large requests can exhaust the single app container. | A body limit in the Caddyfile (25 MB) and a default limit in `parseBody` (64 KB). |
| SAST-4 | Medium, needs a check on the server | **The self-hosted Supabase gateway may expose Studio on 443.** The Caddyfile forwards every path to Kong; the README's port scan would not notice. | Proxy only `/auth/v1`, `/rest/v1` and `/storage/v1`. Check: an unauthenticated `GET /` on the API host returning `401 Basic`. |
| DB-4 | Low | Managers can read payment amounts through `audit_events`, which stores whole payment rows. | A payments audit trigger that records ids, status and actor only. |
| DB-5 | Low | Prices, working hours and lab settings can be changed directly through the REST API by management, with no audit row anywhere. | Revoke the unused write grants; add audit triggers to `services`, `doctor_services`, `app_settings`. |
| DB-6 | Low, root cause | New functions and tables are exposed by default unless each migration remembers to revoke. | `ALTER DEFAULT PRIVILEGES` for the migration role; test on staging first, since it also affects extensions installed later. |
| DB-7 | Low | Telegram bot tokens are stored in plain text, protected from signed-in roles only by RLS without a policy. | Revoke the `SELECT` grant; move tokens to Vault. |
| API-6 | Low | A doctor can read unverified lab values and discard a technician's draft through the result-entry endpoints. | Gate both on the verifier rule. |
| SAST-5 | Low | IP rate limits trust the left-most `X-Forwarded-For` value; on Cloud Run a client chooses it. | One `clientIp()` helper that takes the platform's trusted hop. |
| SAST-6 | Low | Build inputs are not pinned: GitHub Actions by tag, base images by tag, `npx supabase` without a version, `curl … \| sh` in the server runbook. | Pin to digests and versions. |
| SAST-7 | Low | Staff session cookies are readable by script and there is no script CSP. No XSS sink was found. | `secure` cookies and a nonce-based `script-src`. |

### Before OneID is switched on

| ID | Severity | Finding | Recommended fix |
| --- | --- | --- | --- |
| SAST-2 | High once enabled | **The OneID result is bound to whoever started the request.** An attacker starts OneID, sends the genuine state link to a victim, and the victim's sign-in links the victim's card to the attacker's Telegram account. | Do not link in the callback: show the Telegram account and require an explicit confirmation, and require the OneID phone to match the shared Telegram contact. |
| DB-9 | Low | `apply_oneid_identity` treats a `NULL` JSHSHIR as valid and stamps the card "verified by OneID". Server callers pass validated values today. | `p_pinfl is null or …`. |

## Dependencies

| Package | Version | Issue | Reachable here | Action |
| --- | --- | --- | --- | --- |
| next | 16.3.0 | 20 advisories, several rated critical | The image-optimizer ones were the only plausible path and are now closed off (DEP-1). The rest need features this app does not use: `use cache`, `next/og`, Server Actions, Edge routes, Windows hosting | Upgrade to 16.4.5 or later, with `eslint-config-next`, as its own change with the full browser suite |
| zod | 4.4.3 | Memory exhaustion on unbounded arrays | Yes, for a signed-in clinic administrator, on two routes with uncapped arrays | Upgrade to 4.6.6; cap the two arrays |
| sharp | 0.35.3 | Two image-decoding advisories | Only through the optimizer, now off | Comes with the Next upgrade |
| vitest, vite, brace-expansion, minimatch, js-yaml | — | Development-only advisories | No | `npm audit fix` |

The lockfile is clean: all 562 packages resolve to the npm registry with integrity hashes, and only two development packages run install scripts. Git history holds no real secret — only Supabase's public local-demo keys and test fixtures.

## What held

These were examined and found sound.

- **Anonymous access.** The `anon` role has no table privilege, no policy and no callable privileged function. Probed for the nine new tables and four new functions.
- **Tenant isolation.** No route reaches a service-role query without its `clinic_id` scope. About 100 tenant references use composite foreign keys that include the clinic.
- **Clinical and lab data.** Signed-in roles have no `SELECT` on referrals, clinical records, lab results or the new prescribing tables; reads go through the server, which authorizes with `doctor_patient_access()` and audits.
- **`SECURITY DEFINER` functions.** All 110 pin `search_path`; the six callable by signed-in users answer only about the caller.
- **Booking and money.** Bookings go through the transactional engine and the overlap constraint; the browser never supplies a price or a payment status; the kassa ledger is append-only; the online-payment webhook verifies the raw body before any database call and settles each event once.
- **Telegram.** The webhook secret is per bot and compared in constant time; `initData` is bound to the clinic's own bot; updates are claimed atomically before side effects; only private chats are served.
- **Claimed repairs of 25 November.** Human takeover fails closed, the private-chat rule, voice consent ordering and voice retention all hold. Two hold only partly: urgent regression phrases (AI-1) and log redaction (two call sites still log raw exception text).
- **Production switches.** Development identity, test payment and test SMS providers are refused at startup and again at use; the cron secret default is rejected.

## Checks to run on the hosted database

Read-only. Each expected result is what the migrations produce; anything else is a finding.

```sql
-- 1. RLS on every table: expect no rows
select c.relname from pg_class c
where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p') and not c.relrowsecurity;

-- 2. Nothing granted to anon; functions callable from the browser: expect only the six helpers,
--    normalize_identity_document, set_updated_at, notification_jobs_claim_guard and extension functions
select p.oid::regprocedure, has_function_privilege('anon', p.oid, 'execute') as anon,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'));

-- 3. The test-only retention override must be absent outside test databases: expect 0
select count(*) from internal.retention_override;

-- 4. Traces of DB-1 and DB-2: doctor records written by more than one account; accounts in more than one clinic
select author_doctor_id, count(distinct created_by) from public.clinical_records group by 1 having count(distinct created_by) > 1;
select profile_id, count(*) from public.staff_roles group by 1 having count(*) > 1;

-- 5. Legacy tables the advisor reported, and scheduled jobs still pointing at an old host
select c.relname, c.relrowsecurity from pg_class c
where c.relnamespace = 'public'::regnamespace and c.relname in ('todos','todo_deps','inbox_entries');
select jobname, schedule, command from cron.job;
```

Auth settings are not readable with SQL. Check in the dashboard that public sign-up is off, the minimum password length is at least 12, secure password change is on and leaked-password protection is enabled.

## Verification of this branch

Run on 27 November 2026 on the final tree of this branch — the prescribing work and the fixes above together — against a local disposable Supabase stack (PostgreSQL 17) and the standalone production build. Nothing hosted was contacted.

| Gate | Result |
| --- | --- |
| `npm run lint` | Passed |
| `npm run typecheck` | Passed |
| `REQUIRE_TEST_DATABASE=true npm test` | 160 files, 1,456 tests, all passed, none skipped |
| `npm run test:notification-claims` | 22 checks passed |
| `npm run test:schema-rehearsal` | Clean install of 96 migrations; upgrade from the 84 canonical migrations plus 12 forward; the two schemas are equal; the SQL-editor bundle is equal; the release preflight passed |
| `node scripts/build-full-db-setup.mjs --check` | The bundle is up to date |
| `deploy/uz/scripts/test-backup.sh` | Encrypted backup round trip passed |
| `npm run build` | Passed |
| `npm run test:e2e` | 25 browser workflows, 522 checks, all passed, with no page error and no 5xx response. 148 of the checks are the HTTP red team |

The same 25 workflows passed 522 checks before this branch, so the existing clinic flows are unchanged by it.

Probes of this branch's changes, sent to the built app on the local machine:

| Probe | Answer |
| --- | --- |
| Forged Click `prepare` and `complete` callbacks, signed with an empty key, provider not configured | 404 |
| `/_next/image` | 404 |
| The ten new doctor and administrator endpoints without a session | 401 each |
| Deleting a draft prescription with a foreign `Origin` | 403 |
| `/v/<unknown code>` and a malformed code | 200 with "Hujjat topilmadi"; `Cache-Control: no-store` |
| PostgREST with the public key, each of the nine new tables | 401 |
| PostgREST with the public key, four of the new functions | 404 |

The 404 for the functions only shows PostgREST would not route the call. That the browser roles hold no `EXECUTE` on them is asserted in [`prescribing.test.ts`](../src/lib/supabase/prescribing.test.ts) from the database catalog.

What this run does not show:

- **Prescribing in a browser.** No browser workflow covers it. It is tested through the real routes against the real database ([`prescribing.test.ts`](../src/app/api/doctor/prescribing.test.ts)), not by clicking through the screens.
- **Each commit on its own.** The gates ran on the final tree. The prescribing commit without the security fixes was only linted, type-checked and bundle-checked.
- **CI's Node version.** The run used Node 26.5; CI uses Node 22. On Node 26.5 `npx playwright install chromium` stalled while unpacking, so the Chromium build Playwright 1.56.1 expects was unpacked by hand from Playwright's own archives.
- **The hosted project.** Its grants, policies and auth settings are covered only by the queries in the section above, which have not been run.
