#!/usr/bin/env node
/**
 * Keys for the self-hosted Supabase stack: one random JWT secret, and the anon and service-role API keys signed with
 * it (HS256, 10 years). Writes them to a private file (mode 600) — never to the screen — for supabase/.env and
 * deploy/uz/app.env:
 *
 *   node deploy/uz/scripts/generate-keys.mjs /opt/healthai/secrets/supabase-keys.env
 */
import { createHmac, randomBytes } from "node:crypto";
import { openSync, writeSync, closeSync } from "node:fs";

const out = process.argv[2];
if (!out) {
  console.error("usage: generate-keys.mjs <output file>");
  process.exit(1);
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const jwtSecret = randomBytes(48).toString("base64url");
const sign = (role) => {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ role, iss: "supabase", iat: now, exp: now + 10 * 365 * 24 * 3600 }));
  const signature = createHmac("sha256", jwtSecret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
};

const lines = [
  `JWT_SECRET=${jwtSecret}`,
  `ANON_KEY=${sign("anon")}`,
  `SERVICE_ROLE_KEY=${sign("service_role")}`,
  `POSTGRES_PASSWORD=${randomBytes(24).toString("hex")}`,
  `DASHBOARD_PASSWORD=${randomBytes(18).toString("base64url")}`,
  `SECRET_KEY_BASE=${randomBytes(48).toString("hex")}`,
  `VAULT_ENC_KEY=${randomBytes(16).toString("hex")}`,
  "",
];
const fd = openSync(out, "w", 0o600);
writeSync(fd, lines.join("\n"));
closeSync(fd);
console.log(`written to ${out} (mode 600); values not shown`);
