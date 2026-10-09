/**
 * An SMS provider (Slice D, 20261008000013). "accepted" means the provider took the message for delivery — never that
 * the patient received it; delivery comes only from the provider's delivery report.
 */
export type SmsSendResult = { accepted: true; providerMessageId: string } | { accepted: false; error: string };

export interface SmsProvider {
  readonly name: "eskiz" | "test";
  configured(): boolean;
  /** `phone` is +998XXXXXXXXX. The text is short, Latin, and never holds medical details. */
  send(phone: string, text: string, ref: string): Promise<SmsSendResult>;
}
