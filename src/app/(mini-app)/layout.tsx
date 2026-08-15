import Link from "next/link";
import { ChevronLeft, HeartPulse } from "lucide-react";

/**
 * Shared shell for patient Mini App pages.
 */
export default function MiniAppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4 px-4 pb-10 pt-4">
      <header className="flex items-center gap-3">
        <Link
          href="/"
          aria-label="Bosh sahifa"
          className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--tg-secondary-bg,var(--hairline))] bg-[var(--tg-secondary-bg,#f1f5f9)] text-[var(--tg-text,var(--foreground))] transition-colors hover:bg-[var(--tg-bg,#ffffff)]"
        >
          <ChevronLeft className="h-5 w-5" />
        </Link>
        <div className="flex items-center gap-2.5">
          <span className="brand-tile flex h-7 w-7 items-center justify-center rounded-lg text-white">
            <HeartPulse className="h-4 w-4" />
          </span>
          <span className="font-display text-sm font-semibold tracking-tight text-[var(--tg-text,var(--foreground))]">
            Health AI
          </span>
        </div>
      </header>
      {children}
    </div>
  );
}