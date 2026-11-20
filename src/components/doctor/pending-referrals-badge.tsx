"use client";

import { useEffect, useState } from "react";

const POLL_MS = 60_000;

/** The number of referrals waiting for this doctor's answer, next to "Yo‘llanmalar". */
export function PendingReferralsBadge() {
  const [pending, setPending] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/doctor/referrals/pending-count", { cache: "no-store" });
        const body = (await res.json()) as { ok?: boolean; data?: { pending?: number } };
        if (alive && body.ok) setPending(body.data?.pending ?? 0);
      } catch {
        /* the badge stays as it was */
      }
    };
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  if (pending === 0) return null;
  return (
    <span
      className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-clay px-1.5 font-numeric text-[10px] font-bold text-white"
      aria-label={`${pending} ta yangi yo‘llanma`}
    >
      {pending}
    </span>
  );
}
