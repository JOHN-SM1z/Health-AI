# Local staging

There is no remote staging project and none is needed for now: Supabase branches are a paid,
shared-environment feature, and everything a migration review needs can be rehearsed on the local
Supabase stack (Docker) — which is also where `supabase db push` is rehearsed *before* it touches
the production project. **Never test on production directly.**

## 1. Fresh database from the migrations (catches a migration that fails)

```bash
supabase start            # core stack is enough: db, auth, rest, storage, kong
npm run db:reset-local    # recreates the database from supabase/migrations in order, then the seed
npm run create-owner      # needed once after every reset (session-expiry suite)
```

## 2. Automated tests

```bash
npm run lint && npm run typecheck && npm test && npm run build
npm run e2e:seed && npm run test:e2e   # against the built app, see e2e/ (local Supabase only)
```

`npm test` includes the database suites for the four areas a release must keep: **RLS** (clinic and
doctor isolation, no signed-in access to clinical tables: `clinical-access`, `clinical-records`,
`tenant-isolation`, `role-authorization`), **retention refusals** (`tenant-integrity`,
`department-referrals`), **referral lifecycle** (`referral-lifecycle`, `referrals`,
`consultation-start`, `handoff`) and **booking** (`booking-engine`, `booking-channels`,
`multi-channel-booking`). Run it twice on one database: a suite that leaks fixtures fails the second run.

## 3. Upgrade rehearsal at volume (before any production migration)

`db reset` proves the migrations apply to an *empty* database. Production is not empty, and some
migrations rewrite or validate whole tables (e.g. `20261002000003` rebuilds the generated
`patients.phone_normalized` column; `20261001000003` re-adds foreign keys). Rehearse the real upgrade:

```bash
# the last migration the production project has applied: read it from its migration list
scripts/rehearse-upgrade.sh 20260930000006
```

It rebuilds the schema exactly as production has it, loads synthetic volume (500k patients with
realistic and hostile phone formats, 200k appointments + payments, 1M audit rows — see
`scripts/rehearsal/volume.sql`), applies every pending migration in order in its own transaction with
timing, then runs `scripts/rehearsal/verify.sql` (all foreign keys validated, no cascading FK from a
retained domain, RLS on every table, no signed-in SELECT on `referrals`/`clinical_records`, privileged
functions not executable by `authenticated`/`anon`, fixed `search_path`, phone range). Run
`npm run db:reset-local` afterwards.

### Result of the rehearsal for the PR "longitudinal history" (2026-10-01)

| Migration | Time on 500k patients / 200k appointments / 1M audit rows |
| --- | --- |
| `20261001000001` – `…0003`, `…0004`, `…0005` | under 1 s each |
| `20261002000001` (adds `patients.phone_normalized`, rewrites `patients`) | 8–12 s |
| `20261002000003` (rebuilds `phone_normalized`, rewrites `patients` again) | 16–20 s |

The `patients` rewrites hold an `ACCESS EXCLUSIVE` lock for their duration (reads and writes of
`patients`, i.e. booking and registration, wait). Roughly 35 s in total for 500k patients, about
linear — so a clinic base of tens of thousands is seconds; apply in a quiet period regardless.
Everything else applied cleanly, all foreign keys validated, every structural check returned 0, the
retention refusals fired, TypeScript and SQL normalization agreed on all 460k distinct stored phone
strings, and the only rows whose `phone_normalized` changed are the intended categories (international
numbers no longer read as Uzbek, `00`-prefixed non-998 numbers, fewer than 7 and more than 15 digits).

## 4. Then, and only then

```
feature branch → GitHub PR → review → merge to main → supabase db push (production)
```

The production project has no staging twin: take a backup/point-in-time marker first, apply during a
quiet period, and re-check the structural checks of `scripts/rehearsal/verify.sql` there (read-only).
