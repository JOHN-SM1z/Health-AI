"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";
import { AButton } from "@/components/admin/ui";
import { LogOut } from "lucide-react";

const ROLE_LABELS: Record<string, string> = {
  owner: "Egasi",
  admin: "Administrator",
  manager: "Menejer",
  doctor: "Shifokor",
  receptionist: "Qabulxona",
};

export function UserMenu({ fullName, roles }: { fullName: string | null; roles: string[] }) {
  const router = useRouter();
  const label = roles.map((r) => ROLE_LABELS[r] ?? r).join(", ");
  const name = fullName ?? "Xodim";

  const signOut = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  };

  return (
    <div className="flex items-center justify-between gap-3 border-t border-hairline px-5 py-4">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-foreground">{name}</p>
        <p className="mt-0.5 text-xs font-medium text-pine-deep">{label || "—"}</p>
      </div>
      <AButton variant="ghost" size="sm" onClick={() => void signOut()} aria-label="Chiqish">
        <LogOut className="h-4 w-4" />
        Chiqish
      </AButton>
    </div>
  );
}
