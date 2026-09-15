import { redirect } from "next/navigation";
import Link from "next/link";
import { getStaffContext, hasRole } from "@/lib/auth/staff";
import { doctorNavItems } from "@/lib/admin/nav";
import { ROLE_LABELS } from "@/lib/admin/client";
import { StaffShell } from "@/components/admin/shell";

export const metadata = { title: "Shifokor paneli" };

export default async function DoctorLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getStaffContext();
  if (!ctx) redirect("/login");
  if (!hasRole(ctx, "doctor")) redirect("/admin");

  return (
    <StaffShell
      brandLabel="Shifokor"
      clinicName={ctx.clinicName}
      sectionLabel="Ish jarayoni"
      nav={doctorNavItems()}
      afterNav={
        hasRole(ctx, "admin") && (
          <Link
            href="/admin"
            className="mt-2 flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium text-pine hover:bg-pine-tint"
          >
            → Admin panelga o‘tish
          </Link>
        )
      }
      profileId={ctx.profileId}
      roleLabel={ctx.roles.map((r) => ROLE_LABELS[r] ?? r).join(", ")}
      homeHref="/doctor"
    >
      {children}
    </StaffShell>
  );
}
