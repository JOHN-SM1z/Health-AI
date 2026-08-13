import Link from "next/link";
import { ChevronLeft, HeartPulse } from "lucide-react";

/**
 * Shared shell for patient Mini App pages.
 */
export default function MiniAppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center gap-3">
        <Link
          href="/"
          aria-label="Bosh sahifa"
          className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--tg-secondary-bg,#e2e8f0)] text-[var(--tg-text,#0f172a)]"
        >
          <ChevronLeft className="h-5 w-5" />
        </Link>
        <div className="flex items-center gap-2">
          <HeartPulse className="h-5 w-5 text-[var(--tg-button,#16a34a)]" />
          <span className="text-sm font-semibold text-[var(--tg-text,#0f172a)]">Health AI</span>
        </div>
      </header>
      {children}
    </div>
  );
}