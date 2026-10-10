import "server-only";
import { eskizProvider } from "@/lib/sms/eskiz";
import { testSmsProvider } from "@/lib/sms/test-provider";
import type { SmsProvider } from "@/lib/sms/types";

/** The configured SMS provider (SMS_PROVIDER), or null: SMS off. */
export function activeSmsProvider(): SmsProvider | null {
  const name = process.env.SMS_PROVIDER ?? "none";
  const provider = name === "eskiz" ? eskizProvider : name === "test" ? testSmsProvider : null;
  return provider && provider.configured() ? provider : null;
}
