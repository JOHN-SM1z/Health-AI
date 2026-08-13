import { redirect } from "next/navigation";
import Link from "next/link";
import { getStaffContext, hasRole } from "@/lib/auth/staff";
import { CalendarDays, LayoutDashboard, MessagesSquare, Stethoscope, Scissors, Sparkles, Settings, BarChart3, HeartPulse, ClipboardList } from "lucide-react";

export const metadata = { title: "Boshqaruv paneli" };

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getStaffContext();
  if (!ctx) redirect("/admin/login");

  const isAdminLike = hasRole(ctx, "admin");
  const isOwner = hasRole(ctx, "owner");

  return (
    <div className="flex min-h-dvh bg-slate-50">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-slate-200 bg-white p-4 md:flex">
        <div className="mb-6 flex items-center gap-2 px-2">
          <HeartPulse className="h-6 w-6 text-emerald-600" />
          <div>
            <p className="text-sm font-bold text-slate-900">Health AI</p>
            <p className="text-xs text-slate-400">{ctx.clinicName}</p>
          </div>
        </div>
        <nav className="flex flex-1 flex-col gap-1 text-sm">
          <NavLink href="/admin" icon={<LayoutDashboard className="h-4 w-4" />}>Bugun</NavLink>
          {isAdminLike && <NavLink href="/admin/appointments" icon={<ClipboardList className="h-4 w-4" />}>Qabullar</NavLink>}
          {isAdminLike && <NavLink href="/admin/calendar" icon={<CalendarDays className="h-4 w-4" />}>Kalendar</NavLink>}
          {isAdminLike && <NavLink href="/admin/conversations" icon={<MessagesSquare className="h-4 w-4" />}>Suhbatlar</NavLink>}
          {isAdminLike && <NavLink href="/admin/doctors" icon={<Stethoscope className="h-4 w-4" />}>Shifokorlar</NavLink>}
          {isAdminLike && <NavLink href="/admin/services" icon={<Scissors className="h-4 w-4" />}>Xizmatlar</NavLink>}
          {isAdminLike && <NavLink href="/admin/specialties" icon={<Sparkles className="h-4 w-4" />}>Yo‘nalishlar</NavLink>}
          {isAdminLike && <NavLink href="/admin/faqs" icon={<MessagesSquare className="h-4 w-4" />}>Savol-javoblar</NavLink>}
          {isOwner && <NavLink href="/admin/analytics" icon={<BarChart3 className="h-4 w-4" />}>Tahlillar</NavLink>}
          {isOwner && <NavLink href="/admin/settings" icon={<Settings className="h-4 w-4" />}>Sozlamalar</NavLink>}
        </nav>
        <div className="border-t border-slate-100 pt-3 text-xs text-slate-400">
          {ctx.profileId.slice(0, 8)} · {ctx.roles.join(", ")}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 md:hidden">
          <Link href="/admin" className="flex items-center gap-2">
            <HeartPulse className="h-5 w-5 text-emerald-600" />
            <span className="text-sm font-bold">Health AI</span>
          </Link>
        </header>
        <div className="flex-1 overflow-x-hidden p-4 md:p-8">{children}</div>
      </div>
    </div>
  );
}

function NavLink({ href, children, icon }: { href: string; children: React.ReactNode; icon: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-slate-600 transition-colors hover:bg-emerald-50 hover:text-emerald-800"
    >
      {icon}
      {children}
    </Link>
  );
}