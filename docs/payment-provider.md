# Payment provider

## Status machine

Payment statuses: `pending → paid | failed | unpaid | manual_review | refunded`.

Transitions are validated by `canTransition` in `src/lib/payments/status.ts` and applied
through `transitionPaymentStatus`, which:

- writes the transition only if legal,
- appends an `audit_events` row (who/what/when),
- is idempotent (repeating the same transition is a no-op).

## Manual mode (pilot default)

`PAYMENT_PROVIDER=manual`:

- patients book with "To'lov qabulxonada" — no payment is initiated,
- staff mark the payment paid at the front desk:
  `POST /api/admin/appointments/[id]/payment` (admin panel booking detail),
- the route returns 409 if a real provider is active and a payment was initiated.

## Provider adapters

The interface lives in `src/lib/payments/provider.ts` — implement `PaymentProvider`
(`createPaymentLink`, `handleWebhook`, `verifyPayment`) and register it in the factory
keyed by `PAYMENT_PROVIDER` (`click` / `payme`). Provider env vars (merchant ids, keys)
are read from the environment; nothing is hardcoded.

## Go-live with Click/PayMe

1. Implement the adapter (link creation + webhook verification) in `src/lib/payments/`.
2. Add the provider's env vars to `.env.example` and Secret Manager.
3. Set `PAYMENT_PROVIDER=click` (or `payme`).
4. Add the webhook route for the provider and register the URL with the provider.
5. Keep `manual` as a fallback for cash payments — the admin panel already supports it.