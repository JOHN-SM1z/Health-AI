"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { cn } from "@/components/mini-app/ui";

export function NavLink({
  href,
  children,
  icon,
  exact = false,
}: {
  href: string;
  children: ReactNode;
  icon?: ReactNode;
  exact?: boolean;
}) {
  const pathname = usePathname();
  const active = exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors",
        active
          ? "bg-pine-tint font-semibold text-pine-deep"
          : "text-ink-muted hover:bg-pine-tint/60 hover:text-pine-deep",
      )}
      aria-current={active ? "page" : undefined}
    >
      {icon}
      {children}
    </Link>
  );
}
