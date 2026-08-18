import { redirect } from "next/navigation";
import Link from "next/link";
import { getStaffContext, hasRole } from "@/lib/auth/staff";
import { NavLink } from "@/components/admin/nav-link";
import { HeartPulse, ListOrdered, CalendarRange } from "lucide-react";

export const metadata = { title: "Shifokor paneli" };

export default async function DoctorLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getStaffContext();
  if (!ctx) redirect("/login");
  if (!hasRole(ctx, "doctor")) redirect("/admin");

  return (
    <div className="flex min-h-dvh bg-sand">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-hairline bg-surface md:flex">
        <div className="flex items-center gap-3 px-5 pb-5 pt-6">
          <span className="brand-tile flex h-9 w-9 items-center justify-center rounded-xl text-white">
            <HeartPulse className="h-5 w-5" />
          </span>
          <div>
            <p className="font-display text-sm font-bold tracking-tight text-foreground">Shifokor</p>
            <p className="max-w-[10rem] truncate text-xs text-ink-muted">{ctx.clinicName}</p>
          </div>
        </div>
        <nav className="flex flex-1 flex-col gap-1 px-3 text-sm">
          <p className="font-numeric px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-[0.16em] text-ink-muted/80">
            Ish jarayoni
          </p>
          <NavLink href="/doctor" icon={<ListOrdered className="h-4 w-4" />}>Bugungi navbat</NavLink>
          <NavLink href="/doctor/schedule" icon={<CalendarRange className="h-4 w-4" />}>Jadvalim</NavLink>
          {hasRole(ctx, "admin") && (
            <Link
              href="/admin"
              className="mt-2 flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium text-pine hover:bg-pine-tint"
            >
              → Admin panelga o‘tish
            </Link>
          )}
        </nav>
        <div className="border-t border-hairline px-5 py-4">
          <p className="font-numeric text-xs text-ink-muted">{ctx.profileId.slice(0, 8)}</p>
          <p className="mt-0.5 text-xs font-medium text-pine-deep">{ctx.roles.join(", ")}</p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-hairline bg-surface px-4 py-3 md:hidden">
          <Link href="/doctor" className="flex items-center gap-2.5">
            <span className="brand-tile flex h-8 w-8 items-center justify-center rounded-lg text-white">
              <HeartPulse className="h-4 w-4" />
            </span>
            <span className="font-display text-sm font-bold tracking-tight">Shifokor paneli</span>
          </Link>
        </header>
        <div className="flex-1 overflow-x-hidden p-4 md:p-8">{children}</div>
      </div>
    </div>
  );
}
