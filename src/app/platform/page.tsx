import { redirect } from "next/navigation";
import { HeartPulse } from "lucide-react";
import { getStaffContext } from "@/lib/auth/staff";
import { PlatformConsole } from "@/components/platform/console";

export const dynamic = "force-dynamic";
export const metadata = { title: "Health AI Platform" };

export default async function PlatformPage() {
  const ctx = await getStaffContext();
  if (!ctx?.platformAdmin) redirect("/login");
  if (ctx.mustChangePassword) redirect("/account/password");

  return (
    <div className="min-h-dvh bg-sand">
      <header className="flex items-center gap-3 border-b border-hairline bg-surface px-6 py-4">
        <span className="brand-tile flex h-9 w-9 items-center justify-center rounded-xl text-white">
          <HeartPulse className="h-5 w-5" />
        </span>
        <div>
          <h1 className="font-display text-lg font-bold tracking-tight">Health AI Platform</h1>
          <p className="text-xs text-ink-muted">Klinikalar, obunalar va to‘lovlar — faqat Health AI jamoasi uchun</p>
        </div>
      </header>
      <main className="mx-auto max-w-6xl p-4 md:p-6">
        <PlatformConsole />
      </main>
    </div>
  );
}
