import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

// supabase/full-db-setup.sql is what a production project is created from
// (pasted into the Supabase SQL editor), so it must be exactly the
// migrations, in order — a hand edit or a forgotten migration would give
// production a different schema from the one every test runs against.
const root = path.resolve(__dirname, "../../..");
const setup = readFileSync(path.join(root, "supabase/full-db-setup.sql"), "utf8");
const migrations = readdirSync(path.join(root, "supabase/migrations"))
  .filter((f) => f.endsWith(".sql"))
  .sort();

describe("supabase/full-db-setup.sql", () => {
  it("is exactly what scripts/build-full-db-setup.mjs generates from the migrations", () => {
    expect(() =>
      execFileSync(process.execPath, [path.join(root, "scripts/build-full-db-setup.mjs"), "--check"], { stdio: "pipe" }),
    ).not.toThrow();
  });

  it("contains every migration once, in order", () => {
    const included = [...setup.matchAll(/^-- FILE: (.+\.sql)$/gm)].map((m) => m[1]);
    expect(included).toEqual(migrations);
  });

  it("commits after each migration that adds enum values, so it runs as one SQL-editor query", () => {
    // The SQL editor runs the whole script as one implicit transaction, and a
    // new enum value cannot be used before its transaction commits.
    const sections = setup.split(/^-- =+\n-- FILE: /m).slice(1);
    const withEnumValues = sections.filter((s) => /^\s*alter\s+type\s+[\w."]+\s+add\s+value/im.test(s));
    expect(withEnumValues.length).toBeGreaterThan(0);
    for (const section of withEnumValues) {
      expect(section.trimEnd().endsWith("commit;"), section.split("\n")[0]).toBe(true);
    }
  });
});
