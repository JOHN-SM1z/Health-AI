import { formatDateTime } from "@/lib/admin/client";

type Props = {
  status: string;
  createdAt: string;
  acceptedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

const STEPS = [
  { key: "pending", label: "Yuborildi" },
  { key: "accepted", label: "Qabul qilindi" },
  { key: "in_progress", label: "Qabul boshlandi" },
  { key: "completed", label: "Yakunlandi" },
] as const;

const CLOSED: Record<string, string> = {
  declined: "Rad etildi",
  revoked: "Bekor qilindi",
  expired: "Muddati o‘tdi",
};

/**
 * PENDING → ACCEPTED → IN_PROGRESS → COMPLETED, with the time each step was
 * reached; a declined, revoked or expired referral shows where it stopped.
 */
export function ReferralLifecycle({ status, createdAt, acceptedAt, startedAt, completedAt }: Props) {
  const at: Record<string, string | null> = { pending: createdAt, accepted: acceptedAt, in_progress: startedAt, completed: completedAt };
  const reached = STEPS.filter((s) => at[s.key]).length;
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs" aria-label="Yo‘llanma bosqichlari">
      {STEPS.map((step, i) => {
        const done = i < reached;
        const current = done && i === reached - 1 && !CLOSED[status];
        return (
          <li key={step.key} className="flex items-center gap-2">
            <span
              aria-current={current ? "step" : undefined}
              className={`rounded-full px-2 py-0.5 ${
                current ? "bg-pine text-white" : done ? "bg-pine-tint text-pine-deep" : "bg-sand text-ink-muted"
              }`}
              title={at[step.key] ? formatDateTime(at[step.key]!) : undefined}
            >
              {step.label}
            </span>
            {i < STEPS.length - 1 && <span className="text-ink-muted">→</span>}
          </li>
        );
      })}
      {CLOSED[status] && <li className="rounded-full bg-sand px-2 py-0.5 font-medium text-foreground">{CLOSED[status]}</li>}
    </ol>
  );
}
