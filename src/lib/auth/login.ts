/**
 * Employees sign in with a login + password (owner decision 2026-10-10): clinic staff often have no email.
 * Supabase Auth keys accounts by email, so a login maps to an internal address on the reserved `.invalid` TLD
 * (RFC 2606) — it can never receive mail, and no email is ever sent to it. Accounts created before logins existed
 * keep signing in with their real email: the login page accepts either.
 *
 * Shared by the browser (login page) and the server (account creation), so no server-only imports here.
 */

export const STAFF_LOGIN_DOMAIN = "staff.health-ai.invalid";

/** 3–32 characters: lowercase Latin letters, digits, dot, dash, underscore; starts with a letter or digit. */
export const LOGIN_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;

export function normalizeLogin(input: string): string {
  return input.trim().toLowerCase();
}

export function isValidLogin(login: string): boolean {
  return LOGIN_PATTERN.test(login);
}

export function loginToEmail(login: string): string {
  return `${normalizeLogin(login)}@${STAFF_LOGIN_DOMAIN}`;
}

/** What the login page sends to Auth: an email stays an email; anything else is a login. */
export function signInEmail(identifier: string): string {
  const value = identifier.trim();
  return value.includes("@") ? value.toLowerCase() : loginToEmail(value);
}

/** The login behind an internal address, or null for a real email. */
export function loginFromEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const suffix = `@${STAFF_LOGIN_DOMAIN}`;
  return email.toLowerCase().endsWith(suffix) ? email.slice(0, -suffix.length).toLowerCase() : null;
}

/** A login suggestion from a person's name: "Dilnoza Karimova" → "dilnoza.karimova". */
export function suggestLogin(fullName: string): string {
  const base = fullName
    .toLowerCase()
    .replace(/[‘’'ʻʼ`]/g, "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 32);
  return base.length >= 3 ? base : "";
}
