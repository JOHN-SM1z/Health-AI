#!/usr/bin/env node
// Regenerates supabase/full-db-setup.sql from supabase/migrations/ in order.
//
//   node scripts/build-full-db-setup.mjs          write the file
//   node scripts/build-full-db-setup.mjs --check  exit 1 if the file is stale
//
// The Supabase SQL editor sends the whole script as ONE query, which Postgres
// runs as one implicit transaction. A value added with ALTER TYPE … ADD VALUE
// cannot be used before its transaction commits, so after every migration
// that adds enum values the script commits, and the next statements start a
// new implicit transaction. (Each migration file stays as written: the
// Supabase CLI already runs every migration in a transaction of its own.)
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(root, "supabase", "migrations");
const target = join(root, "supabase", "full-db-setup.sql");
const RULE = "-- =====================================================================";

export function buildFullDbSetup() {
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  const header = [
    RULE,
    "-- Health AI — FULL DATABASE SETUP (production)",
    "-- Auto-generated from supabase/migrations/ in order. Run ONCE on an",
    "-- EMPTY database via Supabase Dashboard > SQL Editor > New query.",
    "-- Seed data (supabase/seed.sql) is LOCAL-DEV-ONLY and is NOT included.",
    "-- Regenerate with: node scripts/build-full-db-setup.mjs",
    RULE,
  ].join("\n");
  const sections = files.map((file) => {
    const sql = readFileSync(join(migrationsDir, file), "utf8").replace(/\s+$/, "");
    const addsEnumValues = /^\s*alter\s+type\s+[\w."]+\s+add\s+value/im.test(sql);
    const commit = addsEnumValues
      ? "\n\n-- New enum values must be committed before any later statement uses them.\ncommit;"
      : "";
    return `${RULE}\n-- FILE: ${file}\n${RULE}\n${sql}${commit}`;
  });
  return `${header}\n\n${sections.join("\n\n")}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const next = buildFullDbSetup();
  if (process.argv.includes("--check")) {
    if (readFileSync(target, "utf8") !== next) {
      console.error("supabase/full-db-setup.sql is out of date: run node scripts/build-full-db-setup.mjs");
      process.exit(1);
    }
    console.log("supabase/full-db-setup.sql is up to date");
  } else {
    writeFileSync(target, next);
    console.log(`wrote supabase/full-db-setup.sql from ${readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).length} migrations`);
  }
}
