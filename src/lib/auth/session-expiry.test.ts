import { describe, it, expect, vi, beforeAll } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { localDbAvailable } from "@/test/local-db";

/**
 * Session expiry regression (audit finding, Phase 2): a staff member whose
 * JWT has EXPIRED must never resolve a staff context — getStaffContext()
 * must return null so every guard responds 401 instead of granting access.
 *
 * The token is a genuine HS256 JWT signed with the LOCAL auth secret and
 * carrying real user claims (sub = a real owner), but with `exp` in the
 * past — GoTrue rejects it exactly like a timed-out production session.
 * A live valid session is verified as the baseline so the test is not
 * vacuous.
 *
 * Requires: `npm run db:reset-local` + `.env` with local keys. Skips
 * cleanly when the stack is down.
 */

const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const OWNER_EMAIL = process.env.OWNER_EMAIL ?? "";
const OWNER_PASSWORD = process.env.OWNER_PASSWORD ?? "";

// Local Supabase default JWT secret; read from the stack's start-secrets
// when available so a custom secret still passes.
function localJwtSecret(): string {
  const dir = resolve(process.cwd(), "supabase/.temp/start-secrets");
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const envFile = resolve(dir, entry.name, "env/docker.env");
      if (!entry.isDirectory() || !existsSync(envFile)) continue;
      for (const line of readFileSync(envFile, "utf8").split("\n")) {
        const m = line.match(/^SUPABASE_INTERNAL_JWT_SECRET=(.+)$/);
        if (m) return m[1];
      }
    }
  }
  return "super-secret-jwt-token-with-at-least-32-characters-long";
}

function signJwt(payload: Record<string, unknown>): string {
  const secret = localJwtSecret();
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const header = enc({ alg: "HS256", typ: "JWT" });
  const body = enc(payload);
  const signature = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

const staffClientMock = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("@/lib/supabase/server", () => ({
  createStaffClient: async () => staffClientMock.client,
}));

import { getStaffContext } from "@/lib/auth/staff";

const describeDb = describe.skipIf(!localDbAvailable());

describeDb("staff session expiry (real GoTrue)", () => {
  let ownerId: string;

  beforeAll(async () => {
    const admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    const { data: session, error } = await admin.auth.signInWithPassword({
      email: OWNER_EMAIL,
      password: OWNER_PASSWORD,
    });
    expect(error).toBeNull();
    if (!session?.user) throw new Error("owner sign-in failed");
    ownerId = session.user.id;
  });

  it("resolves a staff context for a VALID live session (baseline)", async () => {
    const admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    const { data: session } = await admin.auth.signInWithPassword({
      email: OWNER_EMAIL,
      password: OWNER_PASSWORD,
    });
    const client = createClient(URL, ANON_KEY, { auth: { persistSession: false } });
    await client.auth.setSession(session!.session!);
    staffClientMock.client = client;

    const ctx = await getStaffContext();
    expect(ctx).not.toBeNull();
    expect(ctx!.profileId).toBe(ownerId);
    expect(ctx!.clinicId).toBeTruthy();
  });

  it("returns null for an EXPIRED token carrying real user claims", async () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = signJwt({
      sub: ownerId,
      role: "authenticated",
      aud: "authenticated",
      iss: `${URL}/auth/v1`,
      iat: now - 7200,
      exp: now - 3600,
      email: OWNER_EMAIL,
    });

    const client = createClient(URL, ANON_KEY, { auth: { persistSession: false } });
    await client.auth.setSession({
      access_token: expired,
      refresh_token: "",
    });
    staffClientMock.client = client;

    const ctx = await getStaffContext();
    expect(ctx).toBeNull();
  });

  it("returns null for a token signed with the wrong secret", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { createHmac: hmac } = await import("node:crypto");
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const header = enc({ alg: "HS256", typ: "JWT" });
    const body = enc({ sub: ownerId, role: "authenticated", aud: "authenticated", exp: now + 3600 });
    const signature = hmac("sha256", "attacker-secret").update(`${header}.${body}`).digest("base64url");
    const forged = `${header}.${body}.${signature}`;

    const client = createClient(URL, ANON_KEY, { auth: { persistSession: false } });
    await client.auth.setSession({
      access_token: forged,
      refresh_token: "",
    });
    staffClientMock.client = client;

    const ctx = await getStaffContext();
    expect(ctx).toBeNull();
  });
});