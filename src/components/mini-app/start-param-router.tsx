"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Opens the page a Telegram deep link points at (t.me/<bot>/<app>?startapp=…).
 * Only known, well-formed parameters are followed: lab_<uuid> opens that lab
 * result (whose page verifies the patient again). Anything else is ignored.
 */
export function StartParamRouter() {
  const router = useRouter();
  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const search = new URLSearchParams(window.location.search);
    const tg = (window as unknown as { Telegram?: { WebApp?: { initDataUnsafe?: { start_param?: string } } } }).Telegram?.WebApp;
    const param = tg?.initDataUnsafe?.start_param ?? hash.get("tgWebAppStartParam") ?? search.get("startapp");
    const match = param?.match(/^lab_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
    if (!match) return;
    const clinic = search.get("clinic");
    router.replace(`/lab-results/${match[1]}${clinic ? `?clinic=${encodeURIComponent(clinic)}` : ""}`);
  }, [router]);
  return null;
}
