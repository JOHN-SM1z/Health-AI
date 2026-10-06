import {Suspense} from "react";
import {ClinicHomeLink} from "@/components/mini-app/clinic-home-link";
import { HeartPulse } from "lucide-react";

/**
 * Shared shell for patient Mini App pages.
 */
export default function MiniAppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4 px-4 pb-10 pt-5">
      <header className="flex items-center gap-3">
        <Suspense fallback={<span className="h-9 w-9" />}><ClinicHomeLink/></Suspense>
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