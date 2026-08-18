import { redirect } from "next/navigation";
import { getStaffContext } from "@/lib/auth/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { PlatformClinics } from "@/components/platform/clinics";

export const dynamic = "force-dynamic";

export default async function PlatformPage() {
  const ctx = await getStaffContext();
  if (!ctx?.platformAdmin) redirect("/admin/login");

  const supabase = createAdminClient();
  const { data: clinics, error } = await supabase
    .from("clinics")
    .select(
      `id, name, slug, timezone, is_active, created_at,
       clinic_telegram_integrations(status, enabled, telegram_username, webhook_status, validated_at)`,
    )
    .order("created_at", { ascending: true });

  if (error) {
    return <div className="p-8 text-destructive">Clinic list failed to load.</div>;
  }

  return (
    <div className="min-h-screen bg-muted/40">
      <header className="border-b bg-background px-6 py-4">
        <h1 className="text-xl font-semibold">Health AI Platform</h1>
        <p className="text-sm text-muted-foreground">Clinic administration — Health AI staff only</p>
      </header>
      <main className="mx-auto max-w-5xl p-6">
        <PlatformClinics clinics={clinics ?? []} />
      </main>
    </div>
  );
}
