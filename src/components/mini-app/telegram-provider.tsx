"use client";

import { useEffect, type ReactNode } from "react";
import { init, initDataRaw, themeParams, viewport, miniApp } from "@telegram-apps/sdk";

type ThemeVars = {
  "--tg-bg": string;
  "--tg-secondary-bg": string;
  "--tg-text": string;
  "--tg-hint": string;
  "--tg-button": string;
  "--tg-button-text": string;
  "--tg-link": string;
  "--tg-destructive": string;
};

function cssVars(): Partial<ThemeVars> {
  const vars: Partial<ThemeVars> = {};
  if (themeParams.backgroundColor()) vars["--tg-bg"] = themeParams.backgroundColor() as string;
  if (themeParams.secondaryBackgroundColor()) vars["--tg-secondary-bg"] = themeParams.secondaryBackgroundColor() as string;
  if (themeParams.textColor()) vars["--tg-text"] = themeParams.textColor() as string;
  if (themeParams.hintColor()) vars["--tg-hint"] = themeParams.hintColor() as string;
  if (themeParams.buttonColor()) vars["--tg-button"] = themeParams.buttonColor() as string;
  if (themeParams.buttonTextColor()) vars["--tg-button-text"] = themeParams.buttonTextColor() as string;
  if (themeParams.linkColor()) vars["--tg-link"] = themeParams.linkColor() as string;
  if (themeParams.destructiveTextColor()) vars["--tg-destructive"] = themeParams.destructiveTextColor() as string;
  return vars;
}

/**
 * Boots the Telegram Mini App SDK once per page load:
 * init -> WebApp.ready() -> theme vars bound -> viewport expanded.
 * In a plain browser (development) init() is a safe no-op-ish call and
 * initDataRaw() returns null — the app must handle that.
 */
export function TelegramProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    try {
      init();
      miniApp.ready();
      viewport.expand();
      themeParams.mount();
      const vars = cssVars();
      for (const [key, value] of Object.entries(vars)) {
        document.documentElement.style.setProperty(key, value);
      }
    } catch (e) {
      // Outside Telegram (browser dev) some calls are unavailable — ignore.
      console.warn("Telegram Mini App init skipped:", e);
    }
  }, []);

  return <>{children}</>;
}

/** Raw initData string for the current session (null outside Telegram). */
export function useTelegramInitData(): string | null {
  return initDataRaw() ?? null;
}