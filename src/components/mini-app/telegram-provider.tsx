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
 * Key for storing Telegram initData across internal page transitions
 * and client-side router navigation in the Mini App / browser.
 */
const INIT_DATA_STORAGE_KEY = "tg_init_data";

function getStoredInitData(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return sessionStorage.getItem(INIT_DATA_STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

function saveInitData(data: string | null) {
  if (typeof window === "undefined" || !data) return;
  try {
    sessionStorage.setItem(INIT_DATA_STORAGE_KEY, data);
  } catch {
    // ignore
  }
}

/**
 * Raw initData, exposed reactively.
 */
let rawInitData: string | null = null;
const initDataListeners = new Set<() => void>();

function publishInitData(data: string | null) {
  rawInitData = data;
  saveInitData(data);
  for (const listener of initDataListeners) listener();
}

/**
 * Attempts to extract initData from various sources:
 * 1. @tma.js/sdk initData.raw()
 * 2. window.Telegram.WebApp.initData
 * 3. URL search params or hash params (#tgWebAppData=...)
 * 4. sessionStorage fallback
 */
function extractInitData(): string | null {
  if (typeof window === "undefined") return null;

  // 1. Check TMA SDK
  try {
    const raw = initData.raw();
    if (raw) return raw;
  } catch {
    // ignore
  }

  // 2. Check window.Telegram.WebApp
  try {
    const tg = (window as unknown as { Telegram?: { WebApp?: { initData?: string } } }).Telegram;
    if (tg?.WebApp?.initData) return tg.WebApp.initData;
  } catch {
    // ignore
  }

  // 3. Check URL query / hash params
  try {
    const hash = window.location.hash.slice(1);
    if (hash) {
      const hashParams = new URLSearchParams(hash);
      const tgWebAppData = hashParams.get("tgWebAppData");
      if (tgWebAppData) return tgWebAppData;
    }
    const searchParams = new URLSearchParams(window.location.search);
    const queryTgWebAppData = searchParams.get("tgWebAppData");
    if (queryTgWebAppData) return queryTgWebAppData;
  } catch {
    // ignore
  }

  // 4. Check sessionStorage
  return getStoredInitData();
}

/**
 * Boots the Telegram Mini App SDK once per page load:
 * init -> initData restored -> WebApp.ready() -> theme vars -> viewport.
 */
export function TelegramProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    try {
      init();
      initData.restore();
      miniApp.ready();
      viewport.expand();
      themeParams.mount();
      const vars = cssVars();
      for (const [key, value] of Object.entries(vars)) {
        document.documentElement.style.setProperty(key, value);
      }
    } catch (e) {
      console.warn("Telegram Mini App init skipped:", e);
    } finally {
      const resolved = extractInitData();
      publishInitData(resolved);
    }
  }, []);

  return <>{children}</>;
}

/** Raw initData string for the current session. */
export function useTelegramInitData(): string | null {
  useSyncExternalStore(
    (onStoreChange) => {
      initDataListeners.add(onStoreChange);
      return () => initDataListeners.delete(onStoreChange);
    },
    () => rawInitData ?? getStoredInitData(),
    () => null,
  );
  return rawInitData ?? getStoredInitData();
}