import Link from "next/link";
import { Clock, AlertTriangle } from "lucide-react";
import type { SubscriptionView } from "@/lib/billing/status";

/**
 * A quiet line at the top of the panel while the trial runs out or after a paid period ends. It never blocks work:
 * patients being seen must not depend on a bank transfer. The platform decides about deactivation.
 */
export function SubscriptionBanner({ subscription, isOwner }: { subscription: SubscriptionView; isOwner: boolean }) {
  const { status, daysLeft } = subscription;
  const soon = status === "trialing" && daysLeft !== null && daysLeft <= 5;
  const overdue = status === "trial_ended" || status === "past_due";
  if (!soon && !overdue) return null;

  const text = overdue
    ? status === "trial_ended"
      ? "Bepul sinov davri tugadi. Ishni uzluksiz davom ettirish uchun obunani to‘lang."
      : "Obuna muddati o‘tdi. To‘lov tasdiqlangach, ogohlantirish yo‘qoladi."
    : `Bepul sinov davri tugashiga ${daysLeft} kun qoldi.`;

  return (
    <div
      role="status"
      className={`mb-4 flex flex-wrap items-center gap-2 rounded-xl px-4 py-2.5 text-sm print:hidden ${
        overdue ? "bg-danger-tint text-danger" : "bg-clay-tint text-clay-deep"
      }`}
    >
      {overdue ? <AlertTriangle className="h-4 w-4 shrink-0" /> : <Clock className="h-4 w-4 shrink-0" />}
      <span className="font-medium">{text}</span>
      {isOwner ? (
        <Link href="/admin/billing" className="ml-auto font-semibold underline-offset-2 hover:underline">
          Obuna va to‘lov →
        </Link>
      ) : (
        <span className="ml-auto text-xs opacity-80">Klinika egasiga xabar bering</span>
      )}
    </div>
  );
}
