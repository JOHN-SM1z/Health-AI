import "server-only";
import { randomUUID } from "node:crypto";
import { isProduction } from "@/lib/env";
import type { SmsProvider } from "@/lib/sms/types";

/**
 * A local SMS "provider" for development and E2E: accepts every message without sending anything. The last texts are
 * kept in this process's memory (testOutbox) so tests can read a one-time code; nothing is written anywhere. Refused in
 * production unless the build is an E2E run against a local database (src/instrumentation.ts).
 */
export const testOutbox: Array<{ phone: string; text: string; at: number }> = [];

function allowed(): boolean {
  if (!isProduction) return true;
  return (
    process.env.ALLOW_TEST_SMS === "true" && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "")
  );
}

export const testSmsProvider: SmsProvider = {
  name: "test",
  configured: allowed,
  async send(phone, text) {
    testOutbox.push({ phone, text, at: Date.now() });
    if (testOutbox.length > 100) testOutbox.shift();
    return { accepted: true, providerMessageId: `test-${randomUUID()}` };
  },
};
