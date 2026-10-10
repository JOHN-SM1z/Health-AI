import { redirect } from "next/navigation";
import Link from "next/link";
import { getStaffContext, hasAnyRole } from "@/lib/auth/staff";
import { NavLink } from "@/components/admin/nav-link";
import { NavStrip } from "@/components/admin/nav-strip";
import { BarChart3, FileUp, FlaskConical, KeyRound, ListChecks } from "lucide-react";
import { NotificationBell } from "@/components/staff/notification-bell";

export const metadata = { title: "Laboratoriya" };

/**
 * The laboratory workspace. Only lab staff work here; everyone else goes to
 * their own workspace (/admin decides between /admin, /doctor and /platform).
 * The layout is a convenience — every lab API route enforces its capability
 * on the server (requireLabCapability).
 */
export default async function LabLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getStaffContext();
  if (!ctx) redirect("/login");
  if (ctx.platformAdmin || !hasAnyRole(ctx.roles, ["lab"])) redirect("/admin");

  return (
    <div className="flex min-h-dvh bg-sand">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-hairline bg-surface md:flex">
        <div className="flex items-center gap-3 px-5 pb-5 pt-6">
          <span className="brand-tile flex h-9 w-9 items-center justify-center rounded-xl text-white">
            <FlaskConical className="h-5 w-5" />
          </span>
          <div>
            <p className="font-display text-sm font-bold tracking-tight text-foreground">Laboratoriya</p>
            <p className="max-w-[10rem] truncate text-xs text-ink-muted">{ctx.clinicName}</p>
          </div>
          <div className="ml-auto">
            <NotificationBell />
          </div>
        </div>
        <nav className="flex flex-1 flex-col gap-1 px-3 text-sm">
          <p className="font-numeric px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-[0.16em] text-ink-muted/80">
            Ish jarayoni
          </p>
          <NavLink href="/lab" exact icon={<ListChecks className="h-4 w-4" />}>Ish navbati</NavLink>
          <NavLink href="/lab/dashboard" icon={<BarChart3 className="h-4 w-4" />}>Ko‘rsatkichlar</NavLink>
          <NavLink href="/lab/imports" icon={<FileUp className="h-4 w-4" />}>Import</NavLink>
          <NavLink href="/lab/password" icon={<KeyRound className="h-4 w-4" />}>Parolim</NavLink>
        </nav>
        <div className="border-t border-hairline px-5 py-4">
          <p className="font-numeric text-xs text-ink-muted">{ctx.profileId.slice(0, 8)}</p>
          <p className="mt-0.5 text-xs font-medium text-pine-deep">{ctx.roles.join(", ")}</p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-hairline bg-surface px-4 py-3 md:hidden">
          <Link href="/lab" className="flex items-center gap-2.5">
            <span className="brand-tile flex h-8 w-8 items-center justify-center rounded-lg text-white">
              <FlaskConical className="h-4 w-4" />
            </span>
            <span className="font-display text-sm font-bold tracking-tight">Laboratoriya</span>
          </Link>
          <div className="ml-auto">
            <NotificationBell />
          </div>
        </header>
        <NavStrip label="Laboratoriya bo‘limlari">
          <NavLink href="/lab" exact icon={<ListChecks className="h-4 w-4" />}>Ish navbati</NavLink>
          <NavLink href="/lab/dashboard" icon={<BarChart3 className="h-4 w-4" />}>Ko‘rsatkichlar</NavLink>
          <NavLink href="/lab/imports" icon={<FileUp className="h-4 w-4" />}>Import</NavLink>
          <NavLink href="/lab/password" icon={<KeyRound className="h-4 w-4" />}>Parolim</NavLink>
        </NavStrip>
        <div className="flex-1 overflow-x-hidden p-4 md:p-8">{children}</div>
      </div>
    </div>
  );
}
