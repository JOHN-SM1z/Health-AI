# Verifying patients' passport details: what is built, what OneID adds, what to negotiate

Owner question (2026-10-10): *"When someone enters ID/passport details in the Mini App, the system should check whether
they are true. What's needed? Should we negotiate with OneID? No face recognition, but all personal details must be
accurate."*

## 1. What the system checks today (no contract needed)

| Check | What it catches | Where |
|---|---|---|
| Passport / ID card format: two letters + seven digits | Typos, a phone number typed as a passport number | `parseIdentityDocument` |
| JSHSHIR structure: 14 digits, first digit 1–6 (century and sex), digits 2–7 = the date of birth DDMMYY | A JSHSHIR typed with the wrong birth date, an invented number, an impossible date | `src/lib/identity/pinfl.ts` |
| Date of birth is a real date, not in the future, at most 120 years ago | Typos | `plausibleDateOfBirth` |
| The phone belongs to the person: their own Telegram contact, or a one-time SMS code to the phone on their card | Someone typing another person's passport | Online identity, steps 2–3 |
| Identical answer whatever the database holds; three wrong dates of birth per document per day stop the comparison | Guessing whose passport exists | `online_identity_lookup` |

**What it cannot check without the state:**
- whether the passport number exists;
- whether it belongs to the person typing it;
- whether the name is spelled as on the document.

The JSHSHIR check digit (digit 14) uses an unpublished formula, so it is not checked.

## 1b. The passport in hand, at the desk (20261010000004)

Every card carries whether its identity is confirmed, and how. The status, never the values, is shown:
- at reception, on the found card and on each patient in "Bugun onlayn to‘laganlar";
- in the Mini App, on the patient's own details.

How the desk confirms a card:
- The receptionist presses **"Hujjatni tekshirish"** and copies the series/number (or JSHSHIR) and the date of birth
  from the patient's passport or ID card.
- `verify_identity_at_desk()` compares them with the card and answers only:
  - `verified` — the card is confirmed by reception;
  - `mismatch`;
  - `other_document` — the card holds the other kind of number;
  - `document_in_use` — another card already has it; reception merges the two.
- A card with no document yet (for example a Telegram-only patient) takes the document from the desk.
- **Limits:** desk roles only; 5 attempts per card and 30 per staff member an hour; every attempt is audited with ids
  and the outcome only.

**Result:** every patient is confirmed once — online by OneID (once connected), or at their first visit by the
passport in hand. The Mini App tells unconfirmed patients to bring their passport or ID card.

## 2. What OneID adds, and why it is the right choice

OneID (id.egov.uz) is the state identification system. The patient signs in there with a login and password, an
electronic signature (ERI), or their phone. **No face check is needed.** OneID then returns the person's details as the
state holds them:

- `pin` — JSHSHIR;
- `pport_no`, plus the passport issue and expiry dates;
- `sur_name`, `first_name`, `mid_name`;
- `birth_date`, and `gd` (sex);
- `per_adr` — permanent address;
- `mob_phone_no`;
- `valid` — whether OneID has verified the profile.

With OneID, nothing personal is typed by the patient: the card gets the state's values. That meets "accuracy of all
personal details" without face recognition.

**Alternatives considered:**

| Option | Face check | Cost | Fit |
|---|---|---|---|
| **OneID** | No | Agreement with the operator (fees, if any, are set in the agreement) | Returns all the needed fields; patients already have accounts for my.gov.uz |
| MyID | Yes (biometric) | Paid per check | Rejected by the owner: face check |
| Commercial KYC (e.g. Sumsub's PINFL check) | Selfie required | Paid per check; data goes abroad | Rejected: selfie, and data leaves the country |
| Direct connection to the Personalization Center through the e-government interoperability platform | No | Usually for state bodies and licensed organisations | Not available to a private clinic software vendor in practice |

**Recommendation: negotiate OneID.**

## 3. What to request

Apply as a legal entity (the company that operates Health AI) to the OneID / e-government operator. Contacts are listed
on id.egov.uz.

**Request:** connection of the information system "Health AI" to OneID as a non-government organization, for
identifying patients who book clinic appointments online.

**Send:**
- the company registration certificate, TIN, and director's details;
- a short system description: patients book in a Telegram Mini App; OneID confirms their identity before the first
  booking; staff see only the patient's name and phone;
- the callback (redirect) URL: `https://<your production domain>/api/oneid/callback`;
- the requested fields: `pin`, `pport_no`, `sur_name`, `first_name`, `mid_name`, `birth_date`, `gd`, `per_adr`,
  `valid`. Request only these;
- how the data is protected:
  - stored only in the clinic's database;
  - never shown to staff, logs or analytics;
  - every read audited;
  - TLS in transit;
- where the servers are. The production database is currently outside Uzbekistan. Ask the operator and your lawyer
  whether the personal-data localization rules require hosting in Uzbekistan before connecting; the system can move to
  a server in Uzbekistan (self-hosted Supabase + the Next.js server; see the Dockerfile);
- a contact person.

**You receive:**
- `client_id` and `client_secret` (they may call them login and password);
- the `scope` value;
- the test environment address, if they provide one.

## 4. Switching it on (after the agreement)

1. Set on Vercel → Production, as sensitive values:
   - `ONEID_CLIENT_ID`;
   - `ONEID_CLIENT_SECRET`;
   - `ONEID_SCOPE` (if they gave one);
   - `ONEID_BASE_URL` (only for their test environment; production defaults to
     `https://sso.egov.uz/sso/oauth/Authorization.do`).
2. `NEXT_PUBLIC_APP_URL` must be the `https://` domain registered with OneID. The server refuses to start with one
   OneID credential and not the other, or with a non-HTTPS app URL.
3. Apply migration `20261010000003_oneid_identity.sql` to production (backup first, as in the runbook).
4. Redeploy.
5. The Mini App's first screen now shows **"OneID orqali tasdiqlash (tavsiya etiladi)"** above the passport form.
6. Check:
   - sign in with a real OneID account in the test environment;
   - the Mini App shows "Davlat tizimi (OneID) orqali tasdiqlangan";
   - in the database, the patient has `identity_verified_by = 'oneid'`.

## 5. How it works

1. Mini App → `POST /api/mini-app/identity/oneid {action:"start"}`. This creates an `oneid_requests` row (only the
   SHA-256 of a random state is stored; 15 minutes; bound to the Telegram user) and returns the OneID URL, opened in
   the phone's browser.
2. OneID → `GET /api/oneid/callback?code&state`. The server exchanges the code (`one_authorization_code`), then reads
   the person (`one_access_token_identify`). It uses the result only when:
   - `valid` is true;
   - the JSHSHIR carries the returned birth date.
3. `apply_oneid_identity()` in one transaction:
   - a card with that JSHSHIR (or that passport with the same birth date) is linked to the patient's Telegram, with
     method `oneid`;
   - with no card, the patient's own record gets the details;
   - `identity_verified_at` and `identity_verified_by` are set;
   - the audit row carries the outcome only, never the values.
4. The patient returns to Telegram; the Mini App polls `{action:"poll"}` and shows their own verified details.

Tests: `src/lib/identity/oneid.test.ts`.
- The protocol and every outcome are covered against the real database, with OneID's server stubbed.
- Covered outcomes: verified, linked, invalid, failed, expired/forged state, and single use.
