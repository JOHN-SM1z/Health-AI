"use client";

import Link from "next/link";
import { PageHeader, AButton } from "@/components/admin/ui";
import { DashboardState, useDashboard } from "@/components/lab/dashboard-ui";
import { WorkloadPanel, type WorkloadData } from "@/components/lab/workload-panel";

/** The lab staff dashboard: the laboratory's current work by stage (status only). */
export default function LabDashboardPage() {
  const { load, reload } = useDashboard<{ workload: WorkloadData }>("/api/lab/dashboard");
  return (
    <div>
      <PageHeader
        title="Ko‘rsatkichlar"
        subtitle="Laboratoriyaning hozirgi ishi bosqichlar bo‘yicha"
        action={
          <div className="flex gap-2">
            <AButton variant="secondary" onClick={reload}>Yangilash</AButton>
            <Link href="/lab" className="inline-flex items-center rounded-xl bg-pine px-4 py-2 text-sm font-semibold text-white">
              Ish navbatiga
            </Link>
          </div>
        }
      />
      <DashboardState load={load}>{(d) => <WorkloadPanel workload={d.workload} />}</DashboardState>
    </div>
  );
}
