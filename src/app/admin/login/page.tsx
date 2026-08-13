"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
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
    <div className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-4 px-4">
      <div className="text-center">
        <h1 className="text-xl font-bold text-slate-900">Health AI — Xodimlar</h1>
        <p className="mt-1 text-sm text-slate-500">Admin va shifokor paneliga kirish</p>
      </div>
      <Card className="flex flex-col gap-3">
        {error && <AError message={error} />}
        <label className="text-sm">
          <span className="mb-1 block text-xs font-medium text-slate-500">Email</span>
          <AInput value={email} onChange={setEmail} type="email" placeholder="xodim@klinika.uz" />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs font-medium text-slate-500">Parol</span>
          <AInput value={password} onChange={setPassword} type="password" placeholder="••••••••" />
        </label>
        <AButton size="lg" loading={loading} onClick={submit}>
          Kirish
        </AButton>
      </Card>
      <p className="text-center text-xs text-slate-400">
        Hisob yo‘qmi? Administrator yoki owner hisobini yaratish bo‘yicha READMEga qarang.
      </p>
    </div>
  );
}