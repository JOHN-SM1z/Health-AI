import { redirect } from "next/navigation";
import Link from "next/link";
import { getStaffContext, hasRole } from "@/lib/auth/staff";
import { HeartPulse, ListOrdered, CalendarRange } from "lucide-react";

export const metadata = { title: "Shifokor paneli" };

export default async function DoctorLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getStaffContext();
  if (!ctx) redirect("/admin/login");
  if (!hasRole(ctx, "doctor")) redirect("/admin");

  return (
    <div className="flex min-h-dvh bg-slate-50">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-slate-200 bg-white p-4 md:flex">
        <div className="mb-6 flex items-center gap-2 px-2">
          <HeartPulse className="h-6 w-6 text-emerald-600" />
          <div>
            <p className="text-sm font-bold text-slate-900">Shifokor</p>
            <p className="text-xs text-slate-400">{ctx.clinicName}</p>
          </div>
        </div>
        <nav className="flex flex-1 flex-col gap-1 text-sm">
          <DocNavLink href="/doctor" icon={<ListOrdered className="h-4 w-4" />}>Bugungi navbat</DocNavLink>
          <DocNavLink href="/doctor/schedule" icon={<CalendarRange className="h-4 w-4" />}>Jadvalim</DocNavLink>
        </nav>
        {hasRole(ctx, "admin") && (
          <Link href="/admin" className="rounded-lg px-3 py-2 text-xs text-emerald-700 hover:bg-emerald-50">
            → Admin panelga o‘tish
          </Link>
        )}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-3 md:hidden">
          <Link href="/doctor" className="flex items-center gap-2">
            <HeartPulse className="h-5 w-5 text-emerald-600" />
            <span className="text-sm font-bold">Shifokor paneli</span>
          </Link>
        </header>
        <div className="flex-1 overflow-x-hidden p-4 md:p-8">{children}</div>
      </div>
    </div>
  );
}

function DocNavLink({ href, children, icon }: { href: string; children: React.ReactNode; icon: React.ReactNode }) {
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