"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Circle, Rocket } from "lucide-react";
import { Card } from "@/components/admin/ui";

type Step = { key: string; title: string; href: string; done: boolean };

/**
 * The owner's “getting started” card on the dashboard until every step is done. Other roles get a 403 from the API
 * and see nothing.
 */
export function OnboardingChecklist() {
  const [steps, setSteps] = useState<Step[] | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/admin/onboarding")
      .then((r) => (r.ok ? r.json() : null))
      .then((json: { ok?: boolean; data?: { steps: Step[] } } | null) => {
        if (alive && json?.ok && json.data) setSteps(json.data.steps);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  if (!steps || steps.every((s) => s.done)) return null;
  const done = steps.filter((s) => s.done).length;

  return (
    <Card className="mb-5 border-pine/30">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-pine-tint text-pine-deep">
          <Rocket className="h-5 w-5" />
        </span>
        <div>
          <p className="font-display font-semibold text-foreground">Klinikani ishga tushirish</p>
          <p className="text-xs text-ink-muted">
            {done} / {steps.length} qadam bajarildi
          </p>
        </div>
        <div className="ml-auto h-1.5 w-40 overflow-hidden rounded-full bg-sand">
          <div className="h-full rounded-full bg-pine" style={{ width: `${(done / steps.length) * 100}%` }} />
        </div>
      </div>
      <ol className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {steps.map((s, i) => (
          <li key={s.key}>
            <Link
              href={s.href}
              className={`flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-sm transition ${
                s.done ? "border-transparent bg-sand text-ink-muted" : "border-hairline bg-surface font-medium text-foreground hover:border-pine/40"
              }`}
            >
              {s.done ? <CheckCircle2 className="h-4 w-4 shrink-0 text-pine" /> : <Circle className="h-4 w-4 shrink-0 text-ink-muted" />}
              <span className={s.done ? "line-through" : ""}>
                {i + 1}. {s.title}
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </Card>
  );
}
