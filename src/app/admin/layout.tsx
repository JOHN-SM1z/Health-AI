import { getOperationsSettings } from "@/lib/operations/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { adminWorkspaceRedirect, getStaffContext, hasRole, isCallCenterStaff } from "@/lib/auth/staff";
import { NavLink } from "@/components/admin/nav-link";
import { CalendarDays, LayoutDashboard, MessagesSquare, Stethoscope, Scissors, Sparkles, Settings, BarChart3, HeartPulse, ClipboardList, Users } from "lucide-react";

export const metadata = { title: "Boshqaruv paneli" };

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getStaffContext();
  if (!ctx) redirect("/login");
  const workspaceRedirect = adminWorkspaceRedirect(ctx);
  if (workspaceRedirect) redirect(workspaceRedirect);

  const isManagement = hasRole(ctx, "admin");
  const callCenter = isCallCenterStaff(ctx);

  const scheduled = (await getOperationsSettings(ctx.clinicId!)).mode !== "walk_in";
  const nav = [
    { href: "/admin", label: "Registratsiya va navbat", icon: <LayoutDashboard className="h-4 w-4" />, show: true },
    { href: "/admin/appointments", label: "Belgilangan qabullar", icon: <ClipboardList className="h-4 w-4" />, show: scheduled },
    { href: "/admin/calendar", label: "Kalendar", icon: <CalendarDays className="h-4 w-4" />, show: scheduled },
    { href: "/admin/cashier", label: "Xizmatlar kassasi", icon: <ClipboardList className="h-4 w-4" />, show: isManagement },
    { href: "/admin/staff", label: "Xodimlar", icon: <Users className="h-4 w-4" />, show: ctx.roles.includes("owner") },
    { href: "/admin/conversations", label: "Suhbatlar", icon: <MessagesSquare className="h-4 w-4" />, show: true },
    { href: "/admin/patients", label: "Bemorlar", icon: <Users className="h-4 w-4" />, show: true },
    { href: "/admin/doctors", label: "Shifokorlar", icon: <Stethoscope className="h-4 w-4" />, show: isManagement },
    { href: "/admin/services", label: "Xizmatlar", icon: <Scissors className="h-4 w-4" />, show: isManagement },
    { href: "/admin/specialties", label: "Yo‘nalishlar", icon: <Sparkles className="h-4 w-4" />, show: isManagement },
    { href: "/admin/faqs", label: "Savol-javoblar", icon: <MessagesSquare className="h-4 w-4" />, show: isManagement },
    { href: "/admin/operations", label: "Tashriflar hisoboti", icon: <BarChart3 className="h-4 w-4" />, show: isManagement },
    { href: "/admin/analytics", label: "Belgilangan qabullar tahlili", icon: <BarChart3 className="h-4 w-4" />, show: isManagement && scheduled },
    { href: "/admin/settings", label: "Sozlamalar", icon: <Settings className="h-4 w-4" />, show: isManagement },
  ].filter((n) => n.show !== false);

  return (
    <div className="flex min-h-dvh bg-sand">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-hairline bg-surface md:flex">
        <div className="flex items-center gap-3 px-5 pb-5 pt-6">
          <span className="brand-tile flex h-9 w-9 items-center justify-center rounded-xl text-white">
            <HeartPulse className="h-5 w-5" />
          </span>
          <div>
            <p className="font-display text-sm font-bold tracking-tight text-foreground">Health AI</p>
            <p className="max-w-[10rem] truncate text-xs text-ink-muted">{ctx.clinicName}</p>
          </div>
        </div>
        <nav className="flex flex-1 flex-col gap-1 px-3 text-sm">
          <p className="font-numeric px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-[0.16em] text-ink-muted/80">
            {callCenter ? "Registratsiya" : "Klinika boshqaruvi"}
          </p>
          {nav.map((n) => (
            <NavLink key={n.href} href={n.href} icon={n.icon} exact={n.href === "/admin"}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-hairline px-5 py-4">
          <p className="font-numeric text-xs text-ink-muted">{ctx.profileId.slice(0, 8)}</p>
          <p className="mt-0.5 text-xs font-medium text-pine-deep">{ctx.roles.join(", ")}</p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-hairline bg-surface px-4 py-3 md:hidden">
          <Link href="/admin" className="flex items-center gap-2.5">
            <span className="brand-tile flex h-8 w-8 items-center justify-center rounded-lg text-white">
              <HeartPulse className="h-4 w-4" />
            </span>
            <span className="font-display text-sm font-bold tracking-tight">Health AI</span>
          </Link>
          <span className="pulse-dot" title="Jonli" />
        </header>
        <nav aria-label="Mobil ish bo‘limlari" className="flex gap-2 overflow-x-auto border-b border-hairline bg-surface p-3 md:hidden">{nav.map(n => <NavLink key={n.href} href={n.href} exact={n.href === "/admin"}><span className="whitespace-nowrap">{n.label}</span></NavLink>)}</nav>
        <div className="flex-1 overflow-x-hidden p-4 md:p-8">{children}</div>
      </div>
    </div>
  );
}
