import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * scripts/sync-telegram-bots.mjs — run after a domain move (deploy/uz/README.md). Against a stand-in REST API and a
 * stand-in Telegram: every active bot gets its webhook on the new address with the secret the app derives, and its
 * menu button on the clinic's Mini App; the integration row is updated; no token is ever printed.
 */

const TOKEN = "123456:SECRET-TOKEN-never-printed";
const WEBHOOK_SECRET = "webhook-secret-for-test";
const CLINIC = "f5329947-da01-4044-a87b-45e191b5a23d";

type Call = { method: string; path: string; body: unknown };
const calls: Call[] = [];
let server: Server;
let base = "";

const body = (req: IncomingMessage) =>
  new Promise<unknown>((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => resolve(raw ? JSON.parse(raw) : null));
  });

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const path = req.url ?? "";
    calls.push({ method: req.method ?? "", path, body: await body(req) });
    if (path.startsWith("/rest/v1/clinic_telegram_integrations") && req.method === "GET") {
      expect(req.headers.apikey).toBe("service-key");
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify([{ clinic_id: CLINIC, telegram_username: "Health_AI_uz_bot", telegram_bot_token: TOKEN }]));
    }
    if (path.startsWith("/rest/v1/clinic_telegram_integrations") && req.method === "PATCH") {
      res.statusCode = 204;
      return res.end();
    }
    if (path.startsWith(`/bot${TOKEN}/`)) {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ ok: true, result: true }));
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const run = (env: Record<string, string>) =>
  new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(process.execPath, [join(process.cwd(), "scripts", "sync-telegram-bots.mjs")], {
      // Only the variables given: nothing from this machine's own .env reaches the script.
      env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });

describe("sync-telegram-bots script", () => {
  it("re-points every active bot's webhook (with the app's derived secret) and menu button at the new address", async () => {
    const { code, out } = await run({
      NEXT_PUBLIC_APP_URL: "https://healthai.uz/",
      SUPABASE_URL: base,
      SUPABASE_SERVICE_ROLE_KEY: "service-key",
      TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
      TELEGRAM_API_BASE: base,
    });
    expect(code).toBe(0);
    expect(out).toContain("@Health_AI_uz_bot: webhook ok, menu button ok");
    expect(out).not.toContain(TOKEN);

    const webhook = calls.find((c) => c.path.endsWith("/setWebhook"));
    expect(webhook?.body).toEqual({
      url: "https://healthai.uz/api/telegram/webhook?bot=Health_AI_uz_bot",
      secret_token: createHmac("sha256", WEBHOOK_SECRET).update(TOKEN).digest("hex"),
      drop_pending_updates: false,
    });
    const menu = calls.find((c) => c.path.endsWith("/setChatMenuButton"));
    expect(menu?.body).toEqual({
      menu_button: { type: "web_app", text: "Qabulga yozilish", web_app: { url: `https://healthai.uz/book?clinic=${CLINIC}` } },
    });
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.path).toContain(`clinic_id=eq.${CLINIC}`);
    expect(patch?.body).toEqual({ webhook_status: "active", webhook_error: null });
  });

  it("refuses to run without an https address or the server settings", async () => {
    const { code, out } = await run({ NEXT_PUBLIC_APP_URL: "http://healthai.uz", SUPABASE_URL: base, SUPABASE_SERVICE_ROLE_KEY: "k", TELEGRAM_WEBHOOK_SECRET: "s" });
    expect(code).toBe(1);
    expect(out).toContain("NEXT_PUBLIC_APP_URL (https://…)");
  });
});
