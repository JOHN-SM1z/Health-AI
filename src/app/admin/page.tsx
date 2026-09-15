"use client";

import { useEffect, useState } from "react";
import { Card, LoadingRow } from "@/components/admin/ui";
import type { Permission } from "@/lib/auth/permissions";
import { OwnerDashboard } from "@/components/admin/owner-dashboard";
import { ManagerDashboard } from "@/components/admin/manager-dashboard";
import { ReceptionistDashboard } from "@/components/admin/receptionist-dashboard";

/**
 * Each admin-workspace role's job is different enough that they no longer
 * share one page with a swapped-out top section — this is a thin router to
 * a completely separate component tree per role (Owner: business
 * performance; Manager: today's operations across the clinic;
 * Receptionist: the fast, action-oriented front-desk board).
 */
export default function TodayPage() {
  const [permissions, setPermissions] = useState<Set<Permission> | null>(null);
  const [clinicTimezone, setClinicTimezone] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/admin/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        setPermissions(new Set<Permission>(j?.data?.permissions ?? []));
        setClinicTimezone(j?.data?.clinicTimezone ?? "Asia/Tashkent");
      })
      .catch(() => {
        setPermissions(new Set());
        setClinicTimezone("Asia/Tashkent");
      });
  }, []);

  if (permissions === null || clinicTimezone === null) {
    return (
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i}>
            <LoadingRow />
          </Card>
        ))}
      </div>
    );
  }

  if (permissions.has("finance:view")) {
    return <OwnerDashboard clinicTimezone={clinicTimezone} />;
  }

  if (permissions.has("catalog:manage")) {
    return <ManagerDashboard clinicTimezone={clinicTimezone} />;
  }

  return <ReceptionistDashboard />;
}
