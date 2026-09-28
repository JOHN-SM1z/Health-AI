"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/browser";
import { AButton, AError, AInput, Card } from "@/components/admin/ui";

const MIN_LENGTH = 12;

/**
 * A signed-in staff member changes their own password — first of all the
 * temporary one the clinic owner handed over. The current password is
 * checked again before the change, so an unattended open session cannot
 * be used to take the account over.
 */
export function ChangePasswordForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setDone(false);
    if (!current || !next) return setError("Joriy va yangi parolni kiriting");
    if (next.length < MIN_LENGTH) return setError(`Yangi parol kamida ${MIN_LENGTH} belgidan iborat bo‘lishi kerak`);
    if (next !== repeat) return setError("Yangi parol va takrori bir xil emas");
    if (next === current) return setError("Yangi parol joriy paroldan farq qilishi kerak");

    setBusy(true);
    setError(null);
    const supabase = createClient();
    try {
      const { data } = await supabase.auth.getUser();
      const email = data.user?.email;
      if (!email) return setError("Sessiya tugagan. Qaytadan kiring.");
      const { error: checkError } = await supabase.auth.signInWithPassword({ email, password: current });
      if (checkError) return setError("Joriy parol noto‘g‘ri");
      const { error: updateError } = await supabase.auth.updateUser({ password: next });
      if (updateError) return setError("Parolni o‘zgartirib bo‘lmadi. Birozdan keyin qayta urinib ko‘ring.");
      setCurrent("");
      setNext("");
      setRepeat("");
      setDone(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="flex max-w-md flex-col gap-3">
      {error && <AError message={error} />}
      {done && (
        <p role="status" className="rounded-lg bg-pine-tint px-3 py-2 text-sm font-medium text-pine-deep">
          Parol o‘zgartirildi. Keyingi safar yangi parol bilan kiring.
        </p>
      )}
      <AInput type="password" value={current} onChange={setCurrent} placeholder="Joriy parol" aria-label="Joriy parol" />
      <AInput type="password" value={next} onChange={setNext} placeholder={`Yangi parol (kamida ${MIN_LENGTH} belgi)`} aria-label="Yangi parol" />
      <AInput type="password" value={repeat} onChange={setRepeat} placeholder="Yangi parolni takrorlang" aria-label="Yangi parol takrori" />
      <AButton onClick={() => void submit()} loading={busy}>
        Parolni o‘zgartirish
      </AButton>
    </Card>
  );
}
