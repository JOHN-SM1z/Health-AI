"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { usePathname } from "next/navigation";

/**
 * The phone/tablet navigation strip: the sidebar's sections in one row that
 * scrolls sideways. The current section is scrolled into view within the strip
 * (only the strip moves, never the page), so it is visible on arrival.
 */
export function NavStrip({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const pathname = usePathname();

  useEffect(() => {
    const strip = ref.current;
    const current = strip?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!strip || !current) return;
    const left = current.offsetLeft - strip.offsetLeft;
    if (left < strip.scrollLeft || left + current.offsetWidth > strip.scrollLeft + strip.clientWidth) {
      strip.scrollLeft = Math.max(0, left - (strip.clientWidth - current.offsetWidth) / 2);
    }
  }, [pathname]);

  return (
    <nav
      ref={ref}
      aria-label={label}
      className="flex gap-1 overflow-x-auto border-b border-hairline bg-surface px-2 py-1.5 md:hidden print:hidden [&>a]:shrink-0 [&>a]:whitespace-nowrap"
    >
      {children}
    </nav>
  );
}
