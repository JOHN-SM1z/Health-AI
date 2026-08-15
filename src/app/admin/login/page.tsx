"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { HeartPulse } from "lucide-react";
import { createClient } from "@/lib/supabase/browser";
import { AButton, AInput, AError, Card } from "@/components/admin/ui";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (!email || !password) {
      setError("Email va parolni kiriting");
      return;
    }
    setLoading(true);
    setError(null);
    const supabase = createClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);

    if (signInError) {
      setError("Kirish amalga oshmadi. Email yoki parol noto‘g‘ri.");
      return;
    }
    router.push("/admin");
    router.refresh();
  };

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="brand-tile mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl text-white">
            <HeartPulse className="h-7 w-7" />
          </div>
          <p className="font-numeric text-[11px] font-medium uppercase tracking-[0.16em] text-ink-muted">
            Health AI — Xodimlar
          </p>
          <h1 className="font-display mt-2 text-2xl font-bold tracking-tight text-foreground">
            Panelga kirish
          </h1>
          <p className="mt-1.5 text-sm text-ink-muted">Admin va shifokor paneliga kirish</p>
        </div>
        <Card className="flex flex-col gap-3.5 p-6 shadow-[var(--shadow-pop)]">
          {error && <AError message={error} />}
          <label className="text-sm">
            <span className="mb-1.5 block text-xs font-semibold text-ink-muted">Email</span>
            <AInput
              value={email}
              onChange={setEmail}
              type="email"
              autoComplete="email"
              placeholder="xodim@klinika.uz"
              aria-label="Email"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1.5 block text-xs font-semibold text-ink-muted">Parol</span>
            <AInput
              value={password}
              onChange={setPassword}
              type="password"
              autoComplete="current-password"
              placeholder="••••••••"
              aria-label="Parol"
            />
          </label>
          <AButton size="lg" loading={loading} onClick={submit} className="mt-2">
            Kirish
          </AButton>
        </Card>
        <p className="mt-5 text-center text-xs text-ink-muted/80">
          Hisob yo‘qmi? Administrator yoki owner hisobini yaratish bo‘yicha READMEga qarang.
        </p>
      </div>
    </div>
  );
}
