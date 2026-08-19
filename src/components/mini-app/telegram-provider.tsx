"use client";

import { useEffect, useSyncExternalStore, type ReactNode } from "react";
// Intentionally avoid importing @tma.js/sdk at module load time: the package
// can run environment checks during import which throw when the page is
// opened outside the Telegram Web App. Load it dynamically inside the effect.

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

type ThemeParamGetter = () => string | null | undefined;

type ThemeParamsApi = Partial<
  Record<
    "bgColor" | "secondaryBgColor" | "textColor" | "hintColor" | "buttonColor" | "buttonTextColor" | "linkColor" | "destructiveTextColor",
    ThemeParamGetter
  >
> & {
  mount?: () => void;
};

type TelegramSdk = {
  init?: () => void;
  initData?: {
    restore?: () => void;
    raw?: () => string | null | undefined;
  };
  miniApp?: { ready?: () => void };
  viewport?: { expand?: () => void };
  themeParams?: ThemeParamsApi;
};

function cssVars(tp?: ThemeParamsApi): Partial<ThemeVars> {
  const vars: Partial<ThemeVars> = {};
  if (tp?.bgColor && typeof tp.bgColor === "function" && tp.bgColor()) vars["--tg-bg"] = tp.bgColor() as string;
  if (tp?.secondaryBgColor && typeof tp.secondaryBgColor === "function" && tp.secondaryBgColor())
    vars["--tg-secondary-bg"] = tp.secondaryBgColor() as string;
  if (tp?.textColor && typeof tp.textColor === "function" && tp.textColor()) vars["--tg-text"] = tp.textColor() as string;
  if (tp?.hintColor && typeof tp.hintColor === "function" && tp.hintColor()) vars["--tg-hint"] = tp.hintColor() as string;
  if (tp?.buttonColor && typeof tp.buttonColor === "function" && tp.buttonColor()) vars["--tg-button"] = tp.buttonColor() as string;
  if (tp?.buttonTextColor && typeof tp.buttonTextColor === "function" && tp.buttonTextColor())
    vars["--tg-button-text"] = tp.buttonTextColor() as string;
  if (tp?.linkColor && typeof tp.linkColor === "function" && tp.linkColor()) vars["--tg-link"] = tp.linkColor() as string;
  if (tp?.destructiveTextColor && typeof tp.destructiveTextColor === "function" && tp.destructiveTextColor())
    vars["--tg-destructive"] = tp.destructiveTextColor() as string;
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
 * Attempts to extract initData from various sources (without importing the
 * TMA SDK synchronously):
 * 1. window.Telegram.WebApp.initData
 * 2. URL search params or hash params (#tgWebAppData=...)
 * 3. sessionStorage fallback
 */
function extractInitData(): string | null {
  if (typeof window === "undefined") return null;

  // 1. Check window.Telegram.WebApp
  try {
    const tg = (window as unknown as { Telegram?: { WebApp?: { initData?: string } } }).Telegram;
    if (tg?.WebApp?.initData) return tg.WebApp.initData;
  } catch {
    // ignore
  }

  // 2. Check URL query / hash params
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

  // 3. Check sessionStorage
  return getStoredInitData();
}

/**
 * The SDK throws a diagnostic when its launch parameters are absent. That is
 * normal for a direct browser visit, so only initialize it when Telegram has
 * actually supplied a launch context.
 */
function hasTelegramLaunchContext() {
  if (extractInitData()) return true;
  try {
    const tg = (window as unknown as { Telegram?: { WebApp?: unknown } }).Telegram;
    return Boolean(tg?.WebApp);
  } catch {
    return false;
  }
}

/**
 * Boots the Telegram Mini App SDK once per page load:
 * load the SDK dynamically to avoid import-time environment checks that
 * would throw when opened outside Telegram, then try to initialize it.
 */
export function TelegramProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    let mounted = true;

    (async () => {
      if (!hasTelegramLaunchContext()) {
        publishInitData(null);
        return;
      }

      let sdk: TelegramSdk | null = null;
      try {
        sdk = (await import("@tma.js/sdk")) as TelegramSdk;
      } catch {
        // If the SDK cannot be loaded, preserve the launch data extracted from
        // the Telegram bridge/URL so navigation continues to work.
      }

      if (!mounted) return;

      if (sdk) {
        try {
          try {
            sdk.init?.();
            sdk.initData?.restore?.();
            sdk.miniApp?.ready?.();
            sdk.viewport?.expand?.();
            sdk.themeParams?.mount?.();

            const vars = cssVars(sdk.themeParams);
            for (const [key, value] of Object.entries(vars)) {
              if (value) document.documentElement.style.setProperty(key, value);
            }
          } catch (e) {
            console.warn("Telegram Mini App init skipped:", e);
          }
        } finally {
          // Prefer SDK-provided raw value when available, otherwise fall back to
          // legacy sources (window, URL, sessionStorage).
          try {
            const raw = sdk.initData?.raw?.();
            if (raw) {
              publishInitData(raw);
              return;
            }
          } catch {
            // ignore
          }

          const resolved = extractInitData();
          publishInitData(resolved);
        }
      } else {
        const resolved = extractInitData();
        publishInitData(resolved);
      }
    })();

    return () => {
      mounted = false;
    };
  }, []);

  return <>{children}</>;
}

/** Raw initData string for the current session. */
export function useTelegramInitData(): string | null {
  return useSyncExternalStore(
    (onStoreChange) => {
      initDataListeners.add(onStoreChange);
      return () => initDataListeners.delete(onStoreChange);
    },
    () => rawInitData ?? getStoredInitData(),
    () => null,
  );
}
