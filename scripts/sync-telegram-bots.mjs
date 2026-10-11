/**
 * Points every active clinic bot at the current app address: its webhook and its chat menu button
 * ("Qabulga yozilish" → the clinic's Mini App). Run once after the app moves to a new domain (healthai.uz):
 *
 *   on the Mac:         node --env-file=.env scripts/sync-telegram-bots.mjs
 *   in the app image:   docker compose --env-file app.env exec app node scripts/sync-telegram-bots.mjs
 *
 * Needs NEXT_PUBLIC_APP_URL (https), SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY and
 * TELEGRAM_WEBHOOK_SECRET — the values the app runs with (the webhook secret is derived from it exactly as in
 * src/lib/telegram/bots.ts). Plain Node, no packages: the app image's trimmed node_modules has no Supabase client.
 * Prints bot usernames and ok/error only; never a token.
 */
import { createHmac } from "node:crypto";

const app = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/+$/, "");
const url = (process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, "");
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
if (!/^https:\/\//.test(app) || !url || !serviceKey || !webhookSecret) {
  console.error("Set NEXT_PUBLIC_APP_URL (https://…), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and TELEGRAM_WEBHOOK_SECRET.");
  process.exit(1);
}

/** The database's REST API with the server key (the apikey header works for legacy JWT and sb_secret_ keys). */
async function rest(path, init = {}) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: serviceKey, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`REST ${res.status}`);
  return res.status === 204 ? null : res.json();
}

// Overridden only by the script's test (src/lib/telegram/sync-bots-script.test.ts).
const TELEGRAM_API = process.env.TELEGRAM_API_BASE ?? "https://api.telegram.org";

async function telegram(token, method, body) {
  const res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

let bots;
try {
  bots = await rest("clinic_telegram_integrations?select=clinic_id,telegram_username,telegram_bot_token&enabled=eq.true&status=eq.active");
} catch (e) {
  console.error("Could not read the clinic bots:", e instanceof Error ? e.message : String(e));
  process.exit(1);
}

let failures = 0;
for (const b of bots) {
  const secret = createHmac("sha256", webhookSecret).update(b.telegram_bot_token).digest("hex");
  const hook = await telegram(b.telegram_bot_token, "setWebhook", {
    url: `${app}/api/telegram/webhook?bot=${encodeURIComponent(b.telegram_username)}`,
    secret_token: secret,
    drop_pending_updates: false,
  });
  const menu = await telegram(b.telegram_bot_token, "setChatMenuButton", {
    menu_button: { type: "web_app", text: "Qabulga yozilish", web_app: { url: `${app}/book?clinic=${encodeURIComponent(b.clinic_id)}` } },
  });
  await rest(`clinic_telegram_integrations?clinic_id=eq.${b.clinic_id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ webhook_status: hook.ok ? "active" : "error", webhook_error: hook.ok ? null : String(hook.description ?? "").slice(0, 500) }),
  });
  if (!hook.ok || !menu.ok) failures++;
  console.log(`@${b.telegram_username}: webhook ${hook.ok ? "ok" : `error (${hook.description})`}, menu button ${menu.ok ? "ok" : `error (${menu.description})`}`);
}
console.log(`${bots.length} bot(s), ${failures} with errors → ${app}`);
process.exit(failures ? 1 : 0);
