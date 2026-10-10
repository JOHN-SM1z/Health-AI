# Clinics sign up on the website, pay by invoice, and run their team from one web app

Owner decisions (2026-10-10):
- employees sign in with a **login + password**;
- **draft plans** that the platform owner edits;
- payment by **invoice + bank transfer**, confirmed by the platform;
- **departments organise staff**, while access stays by role.

## Pages

| Page | Who | What |
|---|---|---|
| `/` | Anyone | Landing page: product, a clinic day, modules, roles, privacy, plans (from the database), FAQ. A Telegram Mini App opened at `/` is forwarded to `/home` (the patient menu). |
| `/signup` | A new clinic | Clinic name, city, phone; the owner's name, phone, login and password; plan. Creates everything and signs the owner in. |
| `/login` | Every employee | One login page: a login (`dilnoza.qabul`) or, for older accounts, an email. Each role lands on its own panel. |
| `/account/password` | An employee on a temporary password | Every panel sends them here first; nothing else works (the API answers `password_change_required`) until they set their own. |
| `/admin` | Owner | A setup checklist: departments, services, doctors, staff logins, Telegram bot, subscription. |
| `/admin/departments` | Owner, administrator (managers read) | Departments: name and type. Deleting one keeps its members. |
| `/admin/staff` | Owner | Add an employee with name, login, role and department. The temporary password is shown once, with the login URL. Also: move to another department, reset a forgotten password (new temporary one), remove. |
| `/admin/billing` | Owner | Plan and status, the open invoice with the payee's bank details, invoice for 1/3/6/12 months, plan change, invoice history. |
| `/admin/billing/invoice/[id]` | Owner | Printable invoice ("Save as PDF"). |
| `/platform` | Health AI staff (`platform_admins`) | **Klinikalar**: plan, status, staff, bot, switch on/off. **To‘lovlar**: confirm a transfer with the bank reference. **Tariflar**: edit name, price, limits and features; saving confirms the price. **Rekvizitlar**: the payee details printed on invoices. |

## Sign-up

`POST /api/signup`:
- **Limits:** 5 per IP per hour, plus a hidden honeypot field.
- **Steps:**
  - the owner's auth account is created first (login mapped to `<login>@staff.health-ai.invalid`; the reserved
    `.invalid` domain never receives mail);
  - then `provision_clinic()` runs in one transaction. It creates:
    - the clinic and the owner's profile and role;
    - five starter departments: Rahbariyat, Qabulxona, Kassa, Terapiya, Laboratoriya;
    - a 14-day trial;
    - the first invoice.
- **On failure:** the auth account is deleted, so nothing is left behind.

## Subscription lifecycle

- **Trial:** 14 days. Once it ends, the panel shows a banner; work is never blocked automatically, because patients
  being seen must not depend on a bank transfer.
- **Payment:** the owner prints the invoice and pays by bank transfer.
- **Confirmation:**
  - a platform admin enters the bank reference in `/platform` → To‘lovlar → "Pul tushdi";
  - `confirm_subscription_invoice()` marks the invoice paid and extends the period by the invoice's months, counted
    from the later of today, the trial end or the paid-up date;
  - it switches the clinic on if it was off;
  - it is idempotent, and it is the only way anything becomes paid.
- **Overdue:** after the period, the banner turns red. Switching a clinic off (`/platform`) blocks its staff from
  signing in; patient data is untouched.
- **Plan limits:** staff and doctor counts are enforced when adding staff, and a downgrade below current headcount is
  refused.
- **Pilot clinics:** clinics that existed before sign-up opened are on a hidden "Pilot" plan with no end date.

## Before production

1. Back up production. Rehearse migrations `20261010000002_saas_onboarding.sql` and
   `20261010000003_oneid_identity.sql` on a restored copy, then apply them (the runbook method).
2. Open `/platform` → **Tariflar**: set the real prices and limits; the landing page stops showing "taxminiy".
3. **Rekvizitlar**: enter Health AI's legal name, TIN, bank, account and MFO. Invoices show them.
4. Make sure at least one platform admin exists. They are added in SQL:

   ```sql
   insert into public.platform_admins (profile_id) values ('<profile id>');
   ```

5. Clinic records can no longer be changed by a browser session except for display details (name, address, phone,
   email, hours, privacy notice, timezone, currency). Activation, slugs and the identity/SMS switches are server-only.

## Not included yet

- **Card payment for subscriptions:** it needs a Click/Payme/Rahmat merchant contract and a verified adapter, as the
  project rules require.
- **Automatic invoice emails/SMS:** the owner gets invoices from the panel.
- **Department-restricted data access:** departments organise staff only, by decision.
