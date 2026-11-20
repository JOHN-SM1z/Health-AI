"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * "/" is the public website for clinics. A patient whose Telegram Mini App opens at the bare domain (a BotFather URL
 * without a path, a startapp deep link) belongs on the patient menu instead: forward them, keeping the launch
 * parameters (clinic, start param, initData in the hash).
 */
export function TelegramEntryRedirect() {
  const router = useRouter();
  useEffect(() => {
    const hash = window.location.hash;
    const fromTelegram =
      hash.includes("tgWebAppData=") ||
      new URLSearchParams(window.location.search).has("startapp") ||
      Boolean((window as unknown as { Telegram?: { WebApp?: { initData?: string } } }).Telegram?.WebApp?.initData);
    if (fromTelegram) router.replace(`/home${window.location.search}${hash}`);
  }, [router]);
  return null;
}
