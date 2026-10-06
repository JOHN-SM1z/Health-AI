# Laboratory Module — Phase 15 External Laboratory Integration Adapter

Status: **implemented and tested locally with a mock provider; not deployed.** No real external laboratory is integrated, because no provider API or documentation has been verified. Nothing assumes MedPlus or any other provider's API.

## Shape

```
Health AI lab model (orders, items, samples, results, verification)
  → lab integration service      src/lib/labs/providers/service.ts
      (send-out, worker, webhook, mapping, retries, review)
  → laboratory integration interface   src/lib/labs/providers/types.ts
  → provider adapter             src/lib/labs/providers/mock.ts (only one so far)
      chosen by registry.ts
```

The conceptual operations map onto the repository's lab model like this:

| Concept | Here |
|---|---|
| `createOrder()` | `adapter.createOrder(ctx, order)`. A **send-out** of a test the clinic's lab has already received: `request_external_lab` creates it, and the worker or an immediate dispatch sends it. Idempotent on the send-out id. |
| `getOrderStatus()` | `adapter.getOrderStatus(ctx, externalOrderId)`, polled by the worker |
| `getResult()` | `adapter.getResult(ctx, externalOrderId)` once the provider reports *completed* |
| `submitResult()` (the provider's side) | `adapter.parseWebhook(ctx, {headers, rawBody})` via `POST /api/lab/providers/<id>/webhook`. The adapter authenticates the request before anything is read. |

**Results never bypass the clinic.** A provider result becomes a result version with `source = external`:
- it is entered on behalf of the technician who sent the test out;
- when complete it is **submitted**, and **a second person verifies it** (O4), exactly like an in-house result;
- an incomplete result stays a draft for the requester to complete.

The integration never verifies anything.

## What the layer handles

| Concern | How |
|---|---|
| Authentication | Each provider names an environment variable `LAB_PROVIDER_…` holding its credential (CHECK constraint). **The secret never enters the database**, and the API reports only whether it is set. The adapter authenticates outgoing calls and incoming webhooks (the mock uses an HMAC over the raw body, compared in constant time). |
| Clinic/provider configuration | `lab_providers`: adapter, non-secret `config` validated by the adapter, `pollSeconds`, active flag, and `send_patient_name` (off by default). `lab_provider_codes` holds the provider's codes for the clinic's tests and parameters. Managed in **Boshqaruv → Laboratoriya → Tashqi laboratoriyalar** (`catalog.configure`). |
| Request mapping | test → provider test code; the specimen (code, type, collection time); patient **sex and date of birth only**, plus a pseudonymous reference (the send-out id). The name is sent only when the provider is configured to require it. The patient's record id is never sent. |
| Response mapping | Provider parameter codes → the clinic's parameters of that test. Values are read by each parameter's type (decimals, choices, booleans). Units must match and are **never converted**. Flags come from the clinic's own ranges (database trigger). |
| Status mapping | Provider statuses are normalized to `received / in_progress / completed / rejected / cancelled`, then to the send-out lifecycle `queued → sent → in_progress → resulted` (or `failed / rejected / cancelled`). |
| Retries | Network, timeout, 5xx and unreadable answers back off for 30 s, 2 min, 10 min, 30 min, 2 h, then the send-out is `failed` after 6 consecutive failures. Credential and configuration errors fail at once, because retrying changes nothing. |
| Idempotency | The send-out id is the provider's idempotency key. A lost response followed by a retry finds the existing order (tested). Webhook redeliveries are harmless. |
| Duplicate prevention | One live send-out per test (unique index). A provider order id once per provider. A result id once per send-out (a repeat is a no-op). A *different* second result is never applied over the first: it is flagged `result_conflict`. While a test is out, **no manual result can be entered** (trigger). |
| Provider errors | Adapters return outcomes (`retryable / auth / rejected / invalid_response / misconfigured`), never exceptions for provider behaviour. Error codes are stored and audited; payloads are never stored or logged. |
| Anything that does not map cleanly | Unknown parameter codes, a repeated parameter, other units, values that do not fit, or a conflicting second result: **nothing is recorded**. The send-out is flagged (`review_reason`) and held for a person, who can stop it and enter the result by hand. |
| Concurrency | `claim_external_lab_requests` uses SKIP LOCKED and a lease, so two workers never act on the same send-out. `record_external_lab_result` locks the send-out (worker and webhook racing → one result). |
| Audit | Trigger rows `lab_external_requested / _sent / _in_progress / _resulted / _failed / _rejected / _cancelled / _needs_review`, carrying ids, status, attempts and codes only. The result itself is audited as `lab_result_entered` / `lab_result_submitted` with source `external`. |
| No contamination of the core model | Provider codes, order ids and statuses live in the three new tables. The core lab tables only gained the use of the existing `lab_result_source = 'external'` value. |
| Fail closed | An unknown adapter name, or the **mock in production**, is refused by the registry. The mock is available only outside production, or in a production *build* explicitly allowed with `ALLOW_MOCK_LAB_PROVIDER=true` whose database is a local Supabase on localhost (the e2e runs). A real deployment never matches. |

## The mock provider

`mock.ts` is a fake laboratory held in server memory. Its behaviour is driven by the provider's settings:
- require a credential (missing → *misconfigured*, `"wrong"` → *auth*);
- fail the first *N* `createOrder` calls (optionally *after* creating the order: a lost response);
- reject given test codes;
- complete after *N* polls;
- answer status polls with garbage;
- the results it returns per test code;
- signed webhooks.

## Endpoints

| Route | Who | |
|---|---|---|
| `POST /api/lab/items/<item>/send-out {providerId}` | lab (`sample.process`) | send out (201; a repeat returns 200 with the same send-out; another laboratory → 409) |
| `POST /api/lab/send-outs/<id> {action:"cancel"}` | lab | stop a live send-out (the provider is not told: no adapter cancels yet) |
| `GET /api/lab/send-outs?items=…` | `queue.read` | status per test and the laboratories each test can go to — **no values** |
| `POST /api/lab/providers/process` | scheduler (`Bearer $CRON_SECRET`) | the worker: send queued send-outs, poll the rest |
| `POST /api/lab/providers/<id>/webhook` | the provider | authenticated by the adapter; rate limited; 401 / 400 / 404 otherwise |
| `GET/POST /api/admin/lab/providers`, `PATCH …/<id>`, `PUT …/<id>/codes` | `catalog.configure` | configuration. The code table is checked whole before it is replaced, so a bad request never wipes it. |

The work queue (`/lab`) gains, on received tests:
- **Tashqi laboratoriyaga** (send-out);
- the send-out status and its review note;
- **To‘xtatish** (stop).

Manual entry is hidden while a test is out.

**Operations:** the scheduler that calls `/api/notifications/process` should also call `/api/lab/providers/process` (same secret). Until it does, send-outs are dispatched immediately, but polling waits for webhooks.

## Tests

| Suite | Covers |
|---|---|
| `src/app/api/lab/lab-external.test.ts` (9) | Real routes, worker and database with the mock.<br>**End to end:** send-out, request mapping, manual entry refused while out, poll → completed → mapped result submitted with source external, the requester cannot verify, a second person does; audit without values; the status API without values.<br>**Idempotency:** lost response + retry gives one provider order, replay returns the same send-out, another laboratory is refused, back-off respected, a provider order id once per provider.<br>**Retry limit** then resend.<br>**Provider errors:** rejection, missing or refused credential, unreadable answers, status mapping via webhook (in progress, rejected).<br>**Mapping safety:** unknown code, other unit, non-numeric or over-precise value → nothing recorded, held for review; incomplete → draft.<br>**Webhooks:** bad signature 401, unknown provider 404, bad payloads 400, a result once, a redelivery is a no-op, a conflicting result never applied, unknown orders ignored.<br>**Concurrency:** two workers, six send-outs, six provider orders; the worker endpoint needs its secret.<br>**Stop** a send-out: a late result is ignored and manual entry is open again.<br>**Access:** reception, doctor and owner cannot send out; another clinic gets 404; another clinic's provider is refused; untimely send-outs refused; configuration is management-only; unknown adapter, a non-`LAB_PROVIDER_` credential name and bad mock settings refused; secrets never returned; anonymous and signed-in clients get no table and no function |
| `src/lib/labs/providers/registry.test.ts` (3) | the mock is refused in production (and allowed only with the explicit flag against a local database); webhook signatures |
| `e2e/lab-external.mjs` (13) | Browser:<br>• the owner configures a laboratory and its codes;<br>• a technician sends a test out from the work queue (no manual entry while out);<br>• the scheduler endpoint (secret required) brings the result;<br>• the queue shows it;<br>• the requester cannot verify; a second technician verifies;<br>• an unsigned webhook gets 401;<br>• audit trail |

Local run after a clean `supabase db reset`:
- `npm test`: **945/945** across 98 files.
- `npm run test:e2e`: referral 84/84, booking 9/9, staff & safety 14/14, lab configuration 11/11, lab ordering 14/14, lab collection 12/12, lab result entry 11/11, lab verification 13/13, lab history 12/12, lab documents 12/12, lab patient results 10/10, lab import 18/18, patient merge 14/14, **lab external 13/13**, HTTP red team 55/55.
- Lint, typecheck and build pass; `full-db-setup.sql` regenerated.

## Not built / decisions

- **A real provider adapter.** Each needs its verified API and documentation:
  - authentication and signature scheme;
  - order and result formats;
  - status codes;
  - test and parameter code lists;
  - a data-processing agreement for what patient data may be sent.
  
  A real adapter must also pin its base URL to HTTPS hosts it expects.
- **Cancelling at the provider** (stopping is local only), and **amended results** from a provider. An amended result is flagged as `result_conflict` for a person; it is not turned into a correction automatically.
- **Unit conversion.** Not done; mismatches are held for review.
- **Imported orders** (`external_import`) are never sent out.
