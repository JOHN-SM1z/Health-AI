import { isProduction } from "@/lib/env";
import { mockLabProvider } from "@/lib/labs/providers/mock";
import type { LabProviderAdapter } from "@/lib/labs/providers/types";

/**
 * A test-only adapter runs outside production — or in a production BUILD
 * that is explicitly allowed (ALLOW_MOCK_LAB_PROVIDER=true) and whose
 * database is a local Supabase stack (the end-to-end runs). A real
 * deployment never points at localhost, so it stays refused there.
 */
function testAdaptersAllowed(): boolean {
  if (!isProduction) return true;
  return (
    process.env.ALLOW_MOCK_LAB_PROVIDER === "true" &&
    /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "")
  );
}

/**
 * The adapters Health AI can speak (Phase 15). A provider row names one;
 * an unknown name — or a test-only adapter in production — is refused, so a
 * misconfiguration fails closed instead of sending data somewhere.
 *
 * No real laboratory is integrated: add an adapter here only once that
 * provider's API and documentation are verified.
 */
const ADAPTERS: Record<string, LabProviderAdapter> = {
  [mockLabProvider.kind]: mockLabProvider,
};

export function availableAdapters(): string[] {
  return Object.values(ADAPTERS)
    .filter((a) => a.productionReady || testAdaptersAllowed())
    .map((a) => a.kind);
}

export function getLabAdapter(kind: string): LabProviderAdapter | null {
  const adapter = ADAPTERS[kind];
  if (!adapter) return null;
  if (!adapter.productionReady && !testAdaptersAllowed()) return null;
  return adapter;
}
