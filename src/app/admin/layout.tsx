import { redirect } from "next/navigation";
import { adminWorkspaceRedirect, getStaffContext, isCallCenterStaff } from "@/lib/auth/staff";
import { getPermissions } from "@/lib/auth/permissions";
import { adminNavItems } from "@/lib/admin/nav";
import { StaffShell } from "@/components/admin/shell";

export const metadata = { title: "Boshqaruv paneli" };

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getStaffContext();
  if (!ctx) redirect("/login");
  const workspaceRedirect = adminWorkspaceRedirect(ctx);
  if (workspaceRedirect) redirect(workspaceRedirect);

  const permissions = getPermissions(ctx.roles);
  const callCenter = isCallCenterStaff(ctx);

  return (
    <StaffShell
      brandLabel="Health AI"
      clinicName={ctx.clinicName}
      sectionLabel={callCenter ? "Call Center" : "Klinika boshqaruvi"}
      nav={adminNavItems(permissions)}
      profileId={ctx.profileId}
      roleLabel={ctx.roles.join(", ")}
      homeHref="/admin"
      liveIndicator
    >
      {children}
    </StaffShell>
  );
}
