"use client";

import { AEmpty, Card, StatCard } from "@/components/admin/ui";
import { Bars, SectionTitle, formatWaiting } from "@/components/lab/dashboard-ui";

export type WorkloadData = {
  activeOrders: number;
  stages: Record<WorkStageKey, { count: number; oldestSince: string | null }>;
  completedToday: number;
  completedLast7Days: number;
  overdue: number;
  byCategory: Array<{ name: string; open: number }>;
  truncated: boolean;
};

type WorkStageKey = "awaitingCollection" | "inTransit" | "awaitingEntry" | "inProgress" | "awaitingVerification";

export const WORK_STAGE_LABELS: Record<WorkStageKey, { label: string; hint: string }> = {
  awaitingCollection: { label: "Namuna olinishi kutilmoqda", hint: "Buyurtma qilingan, namuna hali olinmagan" },
  inTransit: { label: "Namuna olingan", hint: "Laboratoriyada hali boshlanmagan" },
  awaitingEntry: { label: "Natija kiritilishi kutilmoqda", hint: "Laboratoriyada, natija boshlanmagan" },
  inProgress: { label: "Jarayonda", hint: "Natija qoralamada yoki tashqi laboratoriyada" },
  awaitingVerification: { label: "Tasdiqlash kutilmoqda", hint: "Natija kiritilgan, ikkinchi xodim tasdiqlashi kerak" },
};

/** The laboratory's current work by stage — counts and waiting times only. */
export function WorkloadPanel({ workload }: { workload: WorkloadData }) {
  const open = Object.values(workload.stages).reduce((s, x) => s + x.count, 0);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Faol buyurtmalar" value={workload.activeOrders} tone="info" />
        <StatCard label="Ochiq tahlillar" value={open} />
        <StatCard label="Bugun tasdiqlandi" value={workload.completedToday} tone="pine" />
        <StatCard label="Muddati o‘tgan" value={workload.overdue} tone={workload.overdue > 0 ? "clay" : "neutral"} />
      </div>

      <Card>
        <SectionTitle hint="Har bir ochiq tahlil bitta bosqichda; eng uzoq kutayotgani bilan">Bosqichlar bo‘yicha ish</SectionTitle>
        <ul className="divide-y divide-hairline/70" aria-label="Bosqichlar bo‘yicha ish">
          {(Object.keys(WORK_STAGE_LABELS) as WorkStageKey[]).map((key) => {
            const stage = workload.stages[key];
            return (
              <li key={key} className="flex items-center justify-between gap-3 py-2.5" data-stage={key}>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{WORK_STAGE_LABELS[key].label}</p>
                  <p className="text-xs text-ink-muted">
                    {stage.count > 0 ? `Eng uzoq kutayotgani: ${formatWaiting(stage.oldestSince)}` : WORK_STAGE_LABELS[key].hint}
                  </p>
                </div>
                <span className="font-numeric text-xl font-bold text-foreground">{stage.count}</span>
              </li>
            );
          })}
          <li className="flex items-center justify-between gap-3 py-2.5" data-stage="completed">
            <div>
              <p className="text-sm font-medium text-foreground">Tasdiqlangan (oxirgi 7 kun)</p>
              <p className="text-xs text-ink-muted">Bugun: {workload.completedToday}</p>
            </div>
            <span className="font-numeric text-xl font-bold text-pine">{workload.completedLast7Days}</span>
          </li>
        </ul>
        {workload.truncated && <p className="mt-3 text-xs text-clay-deep">Ochiq tahlillar juda ko‘p: sonlar kamida shuncha.</p>}
      </Card>

      <Card>
        <SectionTitle>Bo‘limlar bo‘yicha ochiq ish</SectionTitle>
        {workload.byCategory.length === 0 ? (
          <AEmpty title="Ochiq ish yo‘q" subtitle="Barcha tahlillar yakunlangan." />
        ) : (
          <Bars rows={workload.byCategory.map((c) => ({ label: c.name, value: c.open }))} />
        )}
      </Card>
    </div>
  );
}
