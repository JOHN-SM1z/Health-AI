import postgres from "postgres";

// The database suites run in parallel against one database, each in its own
// clinic, so a referral-expiry sweep scoped to a clinic touches only its own
// suite. The scheduled job sweeps every clinic, though: a suite testing it
// could record another suite's short-lived referral as expired while that
// suite still asserts the state between expires_at and the sweep ("access has
// ended, nothing has recorded it yet"). Tests that observe that state hold this
// advisory lock shared; a test that runs a global sweep holds it exclusively.
const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const LOCK_KEY = 7_214_300_051;

async function holding<T>(mode: "shared" | "exclusive", run: () => Promise<T>): Promise<T> {
  const lock = postgres(DB_URL, { max: 1, onnotice: () => {} });
  try {
    await lock.unsafe(`select pg_advisory_lock${mode === "shared" ? "_shared" : ""}(${LOCK_KEY})`);
    return await run();
  } finally {
    await lock.end({ timeout: 5 }); // ending the session releases the lock
  }
}

/**
 * Runs an expiry window — from before the short-lived referral exists until
 * the last check that relies on nothing having recorded its expiry — with no
 * global sweep from another suite in between.
 */
export const withoutGlobalSweeps = <T>(run: () => Promise<T>) => holding("shared", run);

/** Runs a test that sweeps every clinic once no other suite is inside an expiry window. */
export const asOnlyGlobalSweep = <T>(run: () => Promise<T>) => holding("exclusive", run);
