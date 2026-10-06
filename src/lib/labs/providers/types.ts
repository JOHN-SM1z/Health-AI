/**
 * The laboratory integration interface (Phase 15).
 *
 *   Health AI  →  lab integration service (service.ts)  →  provider adapter
 *
 * Adapters translate between a provider's API and these NORMALIZED shapes;
 * nothing provider-specific reaches the core lab model. The service maps
 * normalized data to the clinic's tests and parameters through the
 * provider's code table (lab_provider_codes) and records it through the
 * database functions, which enforce tenancy, duplicates and verification.
 *
 * Operations (the conceptual createOrder / getOrderStatus / getResult /
 * submitResult):
 *   createOrder     send a test out; idempotent on `requestId`
 *   getOrderStatus  poll the provider's status
 *   getResult       fetch a completed result
 *   parseWebhook    the provider pushes status or results to us
 *                   (submitResult from the provider's side); authenticated
 *                   by the adapter before anything is read
 *
 * Every adapter call returns an outcome — never throws for provider
 * behaviour — so retries and errors are decided in one place.
 */

/** Non-secret provider settings plus the credential read from the environment. */
export type ProviderContext = {
  providerId: string;
  clinicId: string;
  config: Record<string, unknown>;
  /** The secret from the environment variable named by credential_ref (never stored or logged). */
  credential: string | null;
};

/** What is sent for one test — minimum necessary patient data. */
export type ExternalOrderRequest = {
  /** Health AI's send-out id: the provider's idempotency key. */
  requestId: string;
  testCode: string;
  sample: { code: string | null; type: string | null; collectedAt: string | null };
  patient: {
    /** A pseudonymous reference (the send-out id), not the patient's record id. */
    reference: string;
    sex: "male" | "female" | null;
    dateOfBirth: string | null;
    /** Only when the provider requires it (lab_providers.send_patient_name). */
    fullName?: string | null;
  };
};

export type ProviderStatus = "received" | "in_progress" | "completed" | "rejected" | "cancelled";

/** A provider result, normalized: provider parameter codes and typed values. */
export type ExternalResult = {
  externalResultId: string;
  performedAt: string | null;
  values: Array<{ code: string; value: number | string | boolean; unit?: string | null }>;
};

/** Why a call did not succeed — decides retry vs stop. */
export type ProviderErrorKind =
  | "retryable" // network, timeout, 5xx, rate limit: try again later
  | "auth" // credentials refused: stop until configured
  | "rejected" // the provider refuses this request (unknown test, bad sample…)
  | "invalid_response" // the provider answered something we cannot read
  | "misconfigured"; // missing credential or settings

export type ProviderError = { ok: false; kind: ProviderErrorKind; code: string };

export type CreateOrderOutcome = { ok: true; externalOrderId: string; status: ProviderStatus } | ProviderError;
export type StatusOutcome = { ok: true; status: ProviderStatus; rejectReason?: string } | ProviderError;
export type ResultOutcome = { ok: true; result: ExternalResult | null } | ProviderError;

export type WebhookEvent =
  | { type: "status"; externalOrderId: string; status: ProviderStatus }
  | { type: "result"; externalOrderId: string; result: ExternalResult };
export type WebhookOutcome = { ok: true; events: WebhookEvent[] } | { ok: false; kind: "unauthenticated" | "invalid" };

export interface LabProviderAdapter {
  /** The adapter name stored in lab_providers.adapter. */
  readonly kind: string;
  /** Whether this adapter may run in production (a mock never may). */
  readonly productionReady: boolean;
  /** Checks the non-secret settings; returns an error code or null. */
  validateConfig(config: Record<string, unknown>): string | null;
  createOrder(ctx: ProviderContext, order: ExternalOrderRequest): Promise<CreateOrderOutcome>;
  getOrderStatus(ctx: ProviderContext, externalOrderId: string): Promise<StatusOutcome>;
  getResult(ctx: ProviderContext, externalOrderId: string): Promise<ResultOutcome>;
  parseWebhook(ctx: ProviderContext, request: { headers: Headers; rawBody: string }): Promise<WebhookOutcome>;
}

export const fail = (kind: ProviderErrorKind, code: string): ProviderError => ({ ok: false, kind, code });
