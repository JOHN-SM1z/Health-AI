"use client";

import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { init, initData, themeParams, viewport, miniApp } from "@tma.js/sdk";

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
  if (themeParams.bgColor()) vars["--tg-bg"] = themeParams.bgColor() as string;
  if (themeParams.secondaryBgColor()) vars["--tg-secondary-bg"] = themeParams.secondaryBgColor() as string;
  if (themeParams.textColor()) vars["--tg-text"] = themeParams.textColor() as string;
  if (themeParams.hintColor()) vars["--tg-hint"] = themeParams.hintColor() as string;
  if (themeParams.buttonColor()) vars["--tg-button"] = themeParams.buttonColor() as string;
  if (themeParams.buttonTextColor()) vars["--tg-button-text"] = themeParams.buttonTextColor() as string;
  if (themeParams.linkColor()) vars["--tg-link"] = themeParams.linkColor() as string;
  if (themeParams.destructiveTextColor()) vars["--tg-destructive"] = themeParams.destructiveTextColor() as string;
  return vars;
}

/**
 * Raw initData, exposed reactively. The SDK does NOT populate it during
 * init(): initData.restore() parses tgWebAppData from the URL, and it only
 * exists when the app runs inside Telegram. Until the provider has restored
 * it, consumers see null; once available, subscribers re-render with the
 * real value.
 */
let rawInitData: string | null = null;
const initDataListeners = new Set<() => void>();

function publishInitData() {
  for (const listener of initDataListeners) listener();
}

/**
 * Boots the Telegram Mini App SDK once per page load:
 * init -> initData restored -> WebApp.ready() -> theme vars -> viewport.
 * In a plain browser (development) init() is a safe no-op-ish call and
 * raw initData stays null — the app must handle that.
 */
export function TelegramProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    try {
      init();
      // Restores initData from the launch params in the URL. Without this,
      // initData.raw() is always undefined and the app can never see the
      // Telegram identity — even inside a properly opened Mini App.
      initData.restore();
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
    } finally {
      rawInitData = initData.raw() ?? null;
      publishInitData();
    }
  }, []);

  return <>{children}</>;
}

/** Raw initData string for the current session (null outside Telegram). */
export function useTelegramInitData(): string | null {
  useSyncExternalStore(
    (onStoreChange) => {
      initDataListeners.add(onStoreChange);
      return () => initDataListeners.delete(onStoreChange);
    },
    () => rawInitData,
  );
  return rawInitData;
}