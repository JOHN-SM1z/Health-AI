import { redirect } from "next/navigation";
import { adminWorkspaceRedirect, getStaffContext } from "@/lib/auth/staff";
import { getPermissions } from "@/lib/auth/permissions";
import { adminNavItems } from "@/lib/admin/nav";
import { ROLE_LABELS } from "@/lib/admin/client";
import { StaffShell } from "@/components/admin/shell";

export const metadata = { title: "Boshqaruv paneli" };

/**
 * Owner/admin share the full "Klinika boshqaruvi" identity; manager and
 * receptionist each got their own distinct dashboard in the redesign
 * (operational control vs. the fast-action call center board), so they no
 * longer share one generic "Call Center" section label either — only
 * receptionist's sidebar now says that, matching that dashboard's own
 * "Health AI — Call Center" header.
 */
function sectionLabelFor(roles: readonly string[]): string {
  if (roles.includes("receptionist")) return "Call Center";
  if (roles.includes("manager")) return "Boshqaruv";
  return "Klinika boshqaruvi";
}

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getStaffContext();
  if (!ctx) redirect("/login");
  const workspaceRedirect = adminWorkspaceRedirect(ctx);
  if (workspaceRedirect) redirect(workspaceRedirect);

  const permissions = getPermissions(ctx.roles);

  return (
    <StaffShell
      brandLabel="Health AI"
      clinicName={ctx.clinicName}
      sectionLabel={sectionLabelFor(ctx.roles)}
      nav={adminNavItems(permissions)}
      profileId={ctx.profileId}
      roleLabel={ctx.roles.map((r) => ROLE_LABELS[r] ?? r).join(", ")}
      homeHref="/admin"
      liveIndicator
    >
      {children}
    </StaffShell>
  );
}
