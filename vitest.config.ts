import { defineConfig } from "vitest/config";
import path from "node:path";
import { loadTestEnvironment } from "./src/test/environment";

loadTestEnvironment();
const databaseRequired = process.env.REQUIRE_TEST_DATABASE === "true";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "server-only": path.resolve(__dirname, "src/test/server-only-stub.ts"),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["src/test/setup.ts"],
    globalSetup: ["src/test/global-setup.ts"],
    include: ["src/**/*.test.ts"],
    // Real Auth/Storage journeys make many requests per assertion. Bound
    // concurrency so local Docker and CI don't turn load into false failures.
    maxWorkers: databaseRequired ? 2 : undefined,
    testTimeout: databaseRequired ? 30_000 : 5_000,
    hookTimeout: databaseRequired ? 60_000 : 10_000,
  },
});
