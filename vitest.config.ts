import { defineConfig } from "vitest/config";
import path from "node:path";

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
    // DB-backed suites create and sign in real GoTrue users (bcrypt) in their
    // hooks — up to six sequentially — which overruns the 10s default when
    // the full suite runs in parallel on a loaded machine.
    hookTimeout: 30_000,
  },
});