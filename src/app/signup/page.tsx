import type { Metadata } from "next";
import Link from "next/link";
import { HeartPulse, ShieldCheck, Clock3, Receipt } from "lucide-react";
import { listPublicPlans } from "@/lib/billing/subscription";
import type { Plan } from "@/lib/billing/status";
import { SignupForm } from "./signup-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: { absolute: "Klinikani ro‘yxatdan o‘tkazish — Health AI" },
  robots: { index: true, follow: true },
};

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ plan?: string }> }) {
  const { plan } = await searchParams;
  let plans: Plan[] = [];
  try {
    plans = await listPublicPlans();
  } catch {
    plans = [];
  }
  const initialPlan = plans.find((p) => p.code === plan)?.code ?? plans[1]?.code ?? plans[0]?.code ?? "";

  return (
    <div className="mx-auto grid min-h-dvh max-w-6xl gap-10 px-4 py-8 md:px-6 lg:grid-cols-[1fr_1.15fr] lg:py-14">
      <aside className="flex flex-col">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="brand-tile flex h-8 w-8 items-center justify-center rounded-lg text-white">
            <HeartPulse className="h-4 w-4" />
          </span>
          <span className="font-display text-[15px] font-bold tracking-tight">Health AI</span>
        </Link>
        <h1 className="font-display mt-10 text-3xl font-bold leading-tight tracking-tight md:text-4xl">Klinikangizni ulang</h1>
        <p className="mt-3 max-w-md leading-relaxed text-ink-muted">
          Ro‘yxatdan o‘tganingizdan so‘ng darhol klinika paneliga kirasiz. Keyingi qadamlar panelda: bo‘limlar, xodimlar, xizmatlar va Telegram bot.
        </p>
        <ul className="mt-8 flex max-w-md flex-col gap-4 text-sm">
          <li className="flex gap-3">
            <Clock3 className="mt-0.5 h-5 w-5 shrink-0 text-pine" />
            <span>
              <b className="font-semibold">14 kun bepul.</b> Karta kerak emas. Sinov tugaganda ish to‘xtamaydi.
            </span>
          </li>
          <li className="flex gap-3">
            <Receipt className="mt-0.5 h-5 w-5 shrink-0 text-pine" />
            <span>
              <b className="font-semibold">Bank o‘tkazmasi.</b> Hisob-faktura “Obuna” bo‘limida, PDF ko‘rinishida.
            </span>
          </li>
          <li className="flex gap-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-pine" />
            <span>
              <b className="font-semibold">Parolingizni faqat siz bilasiz.</b> Health AI jamoasi uni ko‘rmaydi.
            </span>
          </li>
        </ul>
        <p className="mt-auto pt-10 text-sm text-ink-muted">
          Hisobingiz bormi?{" "}
          <Link href="/login" className="font-semibold text-pine hover:underline">
            Kirish
          </Link>
        </p>
      </aside>
      <SignupForm plans={plans} initialPlan={initialPlan} />
    </div>
  );
}
