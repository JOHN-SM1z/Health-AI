/** Plan and subscription shapes shared by the server, the landing page and the panels (no server-only imports). */

export type Plan = {
  id: string;
  code: string;
  name: string;
  tagline: string;
  monthlyPriceUzs: number;
  maxStaff: number | null;
  maxDoctors: number | null;
  features: string[];
  /** The platform owner has not confirmed this price yet: shown as "taxminiy". */
  priceIsDraft: boolean;
  isPublic: boolean;
  sortOrder: number;
};

/**
 * What the clinic sees:
 *   trialing     — inside the free trial
 *   trial_ended  — the trial is over and no payment has been confirmed
 *   active       — paid up (or a pilot clinic with no end date)
 *   past_due     — the paid period is over
 *   cancelled
 */
export type EffectiveStatus = "trialing" | "trial_ended" | "active" | "past_due" | "cancelled";

export type SubscriptionView = {
  plan: Plan;
  storedStatus: string;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  status: EffectiveStatus;
  /** Days until the trial or the paid period ends (negative once over); null with no end date. */
  daysLeft: number | null;
};

const DAY = 86_400_000;

export function effectiveStatus(
  stored: string,
  trialEndsAt: string | null,
  currentPeriodEnd: string | null,
  now: Date = new Date(),
): { status: EffectiveStatus; daysLeft: number | null } {
  const days = (iso: string | null) => (iso ? Math.ceil((Date.parse(iso) - now.getTime()) / DAY) : null);
  if (stored === "cancelled") return { status: "cancelled", daysLeft: null };
  if (stored === "trialing") {
    const left = days(trialEndsAt);
    return { status: left !== null && left <= 0 && Date.parse(trialEndsAt!) <= now.getTime() ? "trial_ended" : "trialing", daysLeft: left };
  }
  const left = days(currentPeriodEnd);
  if (left === null) return { status: "active", daysLeft: null };
  return { status: Date.parse(currentPeriodEnd!) <= now.getTime() ? "past_due" : "active", daysLeft: left };
}

export function formatUzs(amount: number): string {
  return `${new Intl.NumberFormat("ru-RU").format(amount).replace(/,/g, " ")} so‘m`;
}

export const STATUS_LABEL: Record<EffectiveStatus, string> = {
  trialing: "Sinov davri",
  trial_ended: "Sinov davri tugadi",
  active: "Faol",
  past_due: "To‘lov muddati o‘tdi",
  cancelled: "Bekor qilingan",
};
