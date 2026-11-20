import { redirect } from "next/navigation";
import { HeartPulse, KeyRound } from "lucide-react";
import { getStaffContext } from "@/lib/auth/staff";
import { FirstPasswordChange } from "./first-password-change";

export const metadata = { title: "Parolni o‘zgartirish" };

/**
 * The first stop for an account on a temporary password (the owner created it or reset it): no panel opens until
 * the employee sets their own. Reachable outside every panel layout, which would otherwise redirect here in a loop.
 */
export default async function AccountPasswordPage() {
  const ctx = await getStaffContext();
  if (!ctx) redirect("/login");

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-7 text-center">
          <div className="brand-tile mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl text-white">
            <HeartPulse className="h-7 w-7" />
          </div>
          <p className="font-numeric text-[11px] font-medium uppercase tracking-[0.16em] text-ink-muted">{ctx.clinicName}</p>
          <h1 className="font-display mt-2 flex items-center justify-center gap-2 text-2xl font-bold tracking-tight text-foreground">
            <KeyRound className="h-5 w-5 text-pine" /> O‘z parolingizni o‘rnating
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-muted">
            {ctx.mustChangePassword
              ? "Sizga berilgan parol vaqtinchalik. Panelga kirishdan oldin faqat o‘zingiz biladigan, kamida 12 belgili yangi parol o‘rnating."
              : "Joriy parolni kiriting va yangisini tanlang."}
          </p>
        </div>
        <FirstPasswordChange />
      </div>
    </div>
  );
}
