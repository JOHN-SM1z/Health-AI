import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "node_modules/**",
    "coverage/**",
    ".freebuff/**",
    // Local supabase runtime files (generated, not part of the app).
    "supabase/.temp/**",
    "supabase/seed.sql",
    // Third-party agent skill templates (not project code).
    ".agents/**",
  ]),
  {
    rules: {
      // Data fetching via an async loader called from useEffect is the
      // standard pattern here; the rule flags it because it cannot prove
      // the setState calls happen after the await.
      "react-hooks/set-state-in-effect": "off",
    },
  },
]);

export default eslintConfig;
