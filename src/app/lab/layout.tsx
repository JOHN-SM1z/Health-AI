import { redirect } from "next/navigation";
import { getStaffContext, hasAnyRole } from "@/lib/auth/staff";
import { NavLink } from "@/components/admin/nav-link";
import { HeartPulse, FlaskConical, KeyRound } from "lucide-react";

export const metadata = { title: "Laboratoriya" };

/**
 * The laboratory technician's workspace. Reached only with the lab_staff role (the API routes enforce it
 * again; hiding links is never the defence). Management configures the laboratory under /admin/lab and
 * has no result access; a technician has no patient, booking or finance access.
 */
export default async function LabLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getStaffContext();
  if (!ctx) redirect("/login");
  if (ctx.platformAdmin) redirect("/platform");
  if (!hasAnyRole(ctx.roles, ["lab_staff"])) redirect("/admin");

  return (
    <div className="flex min-h-dvh bg-sand">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-hairline bg-surface md:flex">
        <div className="flex items-center gap-3 px-5 pb-5 pt-6">
          <span className="brand-tile flex h-9 w-9 items-center justify-center rounded-xl text-white">
            <HeartPulse className="h-5 w-5" />
          </span>
          <div>
            <p className="font-display text-sm font-bold tracking-tight text-foreground">Laboratoriya</p>
            <p className="max-w-[10rem] truncate text-xs text-ink-muted">{ctx.clinicName}</p>
          </div>
        </div>
        <nav className="flex flex-1 flex-col gap-1 px-3 text-sm">
          <NavLink href="/lab" exact icon={<FlaskConical className="h-4 w-4" />}>Tahlillar</NavLink>
          <NavLink href="/lab/password" icon={<KeyRound className="h-4 w-4" />}>Parolim</NavLink>
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <main className="flex-1 p-4 md:p-8">{children}</main>
      </div>
    </div>
  );
}
