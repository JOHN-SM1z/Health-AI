import { redirect } from "next/navigation";
import Link from "next/link";
import { requirePanelContext, hasAnyRole, KASSA_ROLES } from "@/lib/auth/staff";
import { NavLink } from "@/components/admin/nav-link";
import { NavStrip } from "@/components/admin/nav-strip";
import { KeyRound, LayoutDashboard, Wallet } from "lucide-react";

export const metadata = { title: "Kassa" };

/**
 * The kassa workspace (outpatient pilot): cashiers work here only; owner,
 * manager and admin reach it from the admin panel. The layout is a
 * convenience — every kassa API route checks the role on the server, and the
 * database checks it again.
 */
export default async function KassaLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requirePanelContext();
  if (ctx.platformAdmin || !hasAnyRole(ctx.roles, KASSA_ROLES)) redirect("/admin");
  const adminToo = hasAnyRole(ctx.roles, ["owner", "manager", "admin", "receptionist"]);

  const links = (
    <>
      <NavLink href="/kassa" exact icon={<Wallet className="h-4 w-4" />}>
        Kassa
      </NavLink>
      {adminToo && (
        <NavLink href="/admin" exact icon={<LayoutDashboard className="h-4 w-4" />}>
          Boshqaruv paneli
        </NavLink>
      )}
      <NavLink href="/kassa/password" icon={<KeyRound className="h-4 w-4" />}>
        Parolim
      </NavLink>
    </>
  );

  return (
    <div className="flex min-h-dvh bg-sand">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-hairline bg-surface md:flex">
        <div className="flex items-center gap-3 px-5 pb-5 pt-6">
          <span className="brand-tile flex h-9 w-9 items-center justify-center rounded-xl text-white">
            <Wallet className="h-5 w-5" />
          </span>
          <div>
            <p className="font-display text-sm font-bold tracking-tight text-foreground">Kassa</p>
            <p className="max-w-[10rem] truncate text-xs text-ink-muted">{ctx.clinicName}</p>
          </div>
        </div>
        <nav className="flex flex-1 flex-col gap-1 px-3 text-sm">{links}</nav>
        <div className="border-t border-hairline px-5 py-4">
          <p className="font-numeric text-xs text-ink-muted">{ctx.profileId.slice(0, 8)}</p>
          <p className="mt-0.5 text-xs font-medium text-pine-deep">{ctx.roles.join(", ")}</p>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-hairline bg-surface px-4 py-3 md:hidden">
          <Link href="/kassa" className="flex items-center gap-2.5">
            <span className="brand-tile flex h-8 w-8 items-center justify-center rounded-lg text-white">
              <Wallet className="h-4 w-4" />
            </span>
            <span className="font-display text-sm font-bold tracking-tight">Kassa</span>
          </Link>
        </header>
        <NavStrip label="Kassa bo‘limlari">{links}</NavStrip>
        <div className="flex-1 overflow-x-hidden p-4 md:p-8">{children}</div>
      </div>
    </div>
  );
}
