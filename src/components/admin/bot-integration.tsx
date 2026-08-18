"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, AButton, AInput, ABadge, AError } from "@/components/admin/ui";
import { Bot as BotIcon } from "lucide-react";
import { adminApi, AdminApiError } from "@/lib/admin/client";

type Integration = {
  telegram_bot_id: number | null;
  telegram_username: string | null;
  telegram_bot_name: string | null;
  status: "disabled" | "active" | "error" | null;
  enabled: boolean;
  webhook_status: string | null;
  webhook_error: string | null;
  last_error: string | null;
  validated_at: string | null;
};

type GetResponse = { integration: Integration | null };
type PostResponse = {
  ok: boolean;
  username?: string;
  webhookOk?: boolean;
  webhookError?: string;
};

const STATUS_TONE: Record<string, "green" | "red" | "neutral" | "amber"> = {
  active: "green",
  error: "red",
  disabled: "neutral",
};

export function BotIntegrationPanel() {
  const [integration, setIntegration] = useState<Integration | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await adminApi.get<GetResponse>("/api/admin/bot");
      setIntegration(res.integration ?? null);
    } catch {
      setIntegration(null);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const activate = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await adminApi.post<PostResponse>("/api/admin/bot", {
        action: "activate",
        telegramBotToken: token.trim(),
      });
      setResult(
        res.webhookOk
          ? `Bot @${res.username} ishlab turibdi. Webhook o‘rnatildi. ✅`
          : `Bot @${res.username} faollashtirildi, ammo webhook o‘rnatilmadi: ${res.webhookError ?? "noma‘lum"}`,
      );
      setToken("");
      await load();
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Faollashtirib bo‘lmadi");
    } finally {
      setBusy(false);
    }
  };

  const deactivate = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      await adminApi.post("/api/admin/bot", { action: "deactivate" });
      setResult("Bot o‘chirildi.");
      await load();
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "O‘chirib bo‘lmadi");
    } finally {
      setBusy(false);
    }
  };

  const status = integration?.status ?? "disabled";

  return (
    <Card className="flex max-w-xl flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="font-display font-bold text-foreground">Telegram bot</p>
        {loaded && <ABadge tone={STATUS_TONE[status] ?? "neutral"}>{status}</ABadge>}
      </div>

      {error && <AError message={error} />}
      {result && <p className="text-sm text-pine-deep">{result}</p>}

      {integration ? (
        <div className="space-y-1 text-sm text-ink-muted">
          {integration.telegram_username && <p>@ {integration.telegram_username}</p>}
          {integration.telegram_bot_name && <p>Bot nomi: {integration.telegram_bot_name}</p>}
          {integration.validated_at && (
            <p>Tasdiqlangan: {new Date(integration.validated_at).toLocaleString("uz-UZ")}</p>
          )}
          {integration.webhook_status && (
            <p>Webhook: {integration.webhook_status}{integration.webhook_error ? ` — ${integration.webhook_error}` : ""}</p>
          )}
          {integration.last_error && <p className="text-danger">Xatolik: {integration.last_error}</p>}
        </div>
      ) : (
        <p className="flex items-center gap-2 text-sm text-ink-muted">
          <BotIcon className="h-4 w-4" /> Bot hali ulamangan. @BotFather dan yaratgan bot tokenini kiriting.
        </p>
      )}

      <div className="flex flex-col gap-2">
        <AInput
          value={token}
          onChange={setToken}
          placeholder="1234567890:AAF-… (bot token, faqat saqlashda yuboriladi)"
          aria-label="Bot tokeni"
          type="password"
          autoComplete="off"
        />
        <div className="flex gap-2">
          <AButton onClick={() => void activate()} loading={busy} disabled={!token.trim()}>
            Faollashtirish
          </AButton>
          {integration?.enabled && (
            <AButton variant="danger" onClick={() => void deactivate()} loading={busy}>
              O‘chirish
            </AButton>
          )}
        </div>
      </div>
    </Card>
  );
}
