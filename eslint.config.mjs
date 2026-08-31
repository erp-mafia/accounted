import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
      }],
    },
  },
  // eslint-plugin-react-hooks 7 (pulled in by eslint-config-next) ships new
  // React Compiler-powered rules at error severity. ~33 legacy components
  // predate them; refactoring those effects is behavior-sensitive work that
  // happens per component, not in a lint sweep. Same pattern as no-console
  // below: warn (not error) until the legacy sites are migrated, then flip
  // each rule back to "error" so the floor is enforced. New violations still
  // surface as warnings in every lint run and PR review.
  {
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/static-components": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
    },
  },
  // No raw console.* in lib/ or app/api/. Use createLogger from @/lib/logger
  // so log lines carry requestId + structured context. lib/logger.ts and
  // app/api/log/route.ts are the two intentional exemptions because they ARE
  // the logger plumbing.
  {
    files: ["lib/**/*.ts", "lib/**/*.tsx", "app/api/**/*.ts", "app/api/**/*.tsx"],
    ignores: [
      "lib/logger.ts",
      "app/api/log/route.ts",
      // Test files have legitimate console use for assertions / debugging.
      "**/__tests__/**",
      "**/*.test.ts",
      "**/*.bench.test.ts",
      "**/*.pg.test.ts",
    ],
    rules: {
      // warn (not error) until the remaining ~20 routes/lib files migrate.
      // Flip to "error" once the count drops to zero so the floor is enforced.
      "no-console": "warn",
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Claude Code session worktrees are full repo copies: without this,
    // local `npm run lint` / `check:lint` walks them (and their node_modules
    // siblings), inflating the report until the ratchet's JSON parse fails.
    ".claude/worktrees/**",
    // Runtime state the Supabase CLI writes under supabase/ when the local
    // stack is up (edge-runtime scratch files, start secrets). Generated, not
    // authored, and gitignored: linting it reports errors nobody can fix.
    "supabase/.temp/**",
    "supabase/.branches/**",
    // The Spectest suite has its own tsconfig and dependency tree; it is
    // typechecked by `tsc --noEmit` inside spectest/, not by the app's rules.
    "spectest/node_modules/**",
  ]),
]);

export default eslintConfig;
