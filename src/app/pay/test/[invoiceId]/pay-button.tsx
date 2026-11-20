"use client";

import { useState } from "react";

export function TestPayButton({ invoiceId, alreadyPaid }: { invoiceId: string; alreadyPaid: boolean }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">(alreadyPaid ? "done" : "idle");
  const pay = async () => {
    setState("busy");
    const res = await fetch(`/api/payments/test_online/pay/${invoiceId}`, { method: "POST" }).catch(() => null);
    const json = (await res?.json().catch(() => null)) as { ok?: boolean } | null;
    setState(json?.ok ? "done" : "error");
  };
  if (state === "done") return <p className="rounded-lg bg-green-50 p-3 text-sm text-green-800">To‘landi. Ilovaga qayting — navbat raqamingiz o‘sha yerda.</p>;
  return (
    <>
      {state === "error" && <p className="text-sm text-red-700">To‘lovni bajarib bo‘lmadi.</p>}
      <button type="button" disabled={state === "busy"} onClick={pay} className="rounded-xl bg-emerald-700 px-4 py-3 text-white disabled:opacity-50">
        {state === "busy" ? "To‘lanmoqda…" : "To‘lash"}
      </button>
    </>
  );
}
