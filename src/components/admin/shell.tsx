import type { ReactNode } from "react";
import Link from "next/link";
import { HeartPulse } from "lucide-react";
import { NavLink } from "@/components/admin/nav-link";
import type { NavItem } from "@/lib/admin/nav";

/**
 * Sidebar/topbar chrome shared by /admin and /doctor, extracted from what
 * used to be two hand-duplicated layouts. Content (which links, which
 * section label) is passed in — this component only knows how to render a
 * nav list, not which role sees what.
 */
export function StaffShell({
  brandLabel,
  clinicName,
  sectionLabel,
  nav,
  afterNav,
  profileId,
  roleLabel,
  homeHref,
  liveIndicator = false,
  children,
}: {
  brandLabel: string;
  clinicName: string;
  sectionLabel: string;
  nav: NavItem[];
  afterNav?: ReactNode;
  profileId: string;
  roleLabel: string;
  homeHref: string;
  liveIndicator?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh bg-sand">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-hairline bg-surface md:flex">
        <div className="flex items-center gap-3 px-5 pb-5 pt-6">
          <span className="brand-tile flex h-9 w-9 items-center justify-center rounded-xl text-white">
            <HeartPulse className="h-5 w-5" />
          </span>
          <div>
            <p className="font-display text-sm font-bold tracking-tight text-foreground">{brandLabel}</p>
            <p className="max-w-[10rem] truncate text-xs text-ink-muted">{clinicName}</p>
          </div>
        </div>
        <nav className="flex flex-1 flex-col gap-1 px-3 text-sm">
          <p className="font-numeric px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-[0.16em] text-ink-muted/80">
            {sectionLabel}
          </p>
          {nav.map((n) => {
            const Icon = n.icon;
            return (
              <NavLink key={n.href} href={n.href} icon={<Icon className="h-4 w-4" />}>
                {n.label}
              </NavLink>
            );
          })}
          {afterNav}
        </nav>
        <div className="border-t border-hairline px-5 py-4">
          <p className="font-numeric text-xs text-ink-muted">{profileId.slice(0, 8)}</p>
          <p className="mt-0.5 text-xs font-medium text-pine-deep">{roleLabel}</p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-hairline bg-surface px-4 py-3 md:hidden">
          <Link href={homeHref} className="flex items-center gap-2.5">
            <span className="brand-tile flex h-8 w-8 items-center justify-center rounded-lg text-white">
              <HeartPulse className="h-4 w-4" />
            </span>
            <span className="font-display text-sm font-bold tracking-tight">{brandLabel}</span>
          </Link>
          {liveIndicator && <span className="pulse-dot" title="Jonli" />}
        </header>
        <div className="flex-1 overflow-x-hidden p-4 md:p-8">{children}</div>
      </div>
    </div>
  );
}
