import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
const root = resolve(__dirname, "../../..");
const activeDir = join(root, "supabase/migrations");
const active = readdirSync(activeDir).filter((file) => file.endsWith(".sql"));
const lineage = JSON.parse(readFileSync(join(root, "supabase/migration-lineage.json"), "utf8")) as {
  canonicalCommit: string; canonicalMigrations: Array<{ file: string; sha256: string }>; legacyArchive: string;
};
describe("canonical migration lineage", () => {
  it("has one active migration per version", () => {
    expect(new Set(active.map((file) => file.split("_")[0])).size).toBe(active.length);
  });
  it("preserves every original canonical migration byte for byte", () => {
    expect(lineage.canonicalCommit).toMatch(/^[0-9a-f]{40}$/);
    for (const migration of lineage.canonicalMigrations) {
      expect(createHash("sha256").update(readFileSync(join(activeDir, migration.file))).digest("hex"), migration.file).toBe(migration.sha256);
    }
  });
  it("preserves conflicting pilot files in the archive without replaying them", () => {
    const manifestPath = join(root, "supabase", lineage.legacyArchive);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { files: Array<{ file: string; sha256: string }> };
    const archive = resolve(manifestPath, "..");
    expect(manifest.files.length).toBeGreaterThan(0);
    for (const file of manifest.files) {
      expect(active).not.toContain(file.file);
      expect(createHash("sha256").update(readFileSync(join(archive, file.file))).digest("hex")).toBe(file.sha256);
    }
  });
});
