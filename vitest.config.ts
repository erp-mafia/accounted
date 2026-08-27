import { defineConfig } from 'vitest/config'
import path from 'path'

const alias = {
  '@': path.resolve(__dirname, '.'),
  // `server-only` is a build-time guard whose real entry point always throws;
  // Next.js swaps it out during bundling, Vitest cannot. Without this stub any
  // test that transitively imports a server-only module fails at import time.
  'server-only': path.resolve(__dirname, 'tests/stubs/server-only.ts'),
}

const unitProject = {
  resolve: { alias },
  test: {
    name: 'unit',
    globals: true,
    environment: 'node' as const,
    include: ['**/*.test.ts'],
    // `.claude/worktrees/*` are ephemeral agent checkouts whose `@/*` imports
    // resolve back to this root: never part of the suite.
    // Two additions to the exclude list, both learned the hard way:
    //   * `*.tool.test.ts` also matches `**/*.test.ts`, so without it the unit
    //     project runs the PostgREST suite with no stack up.
    //   * `.next/standalone` is a traced COPY of the repo left by a local
    //     build, so `npm run build && npm test` collects those files a second
    //     time. Only two match here today, but the duplication is silent and
    //     grows with the build's tracing.
    exclude: [
      '**/node_modules/**',
      '**/*.pg.test.ts',
      '**/*.tool.test.ts',
      '**/.claude/**',
      '**/.next/**',
    ],
  },
}

const pgRealProject = {
  resolve: { alias },
  test: {
    name: 'pg-real',
    globals: true,
    environment: 'node' as const,
    include: ['**/*.pg.test.ts'],
    // `.next/standalone` holds a traced copy of these files after a local
    // build; 128 of them match this project's glob.
    exclude: ['**/node_modules/**', '**/.claude/**', '**/.next/**'],
    setupFiles: ['tests/pg/setup.ts'],
    // One-connection-at-a-time to avoid cross-file DB contention.
    fileParallelism: false,
    testTimeout: 15000,
  },
}

// MCP tools queried through a REAL supabase-js client against a REAL
// PostgREST. Separate from pg-real because that project holds a `pg` Pool and
// writes SQL, which cannot see the half of a tool that PostgREST resolves: the
// `.select()` column strings, the resource embeds, the or=(...) grammar.
const toolPgProject = {
  resolve: { alias },
  test: {
    name: 'tool-pg',
    globals: true,
    environment: 'node' as const,
    include: ['**/*.tool.test.ts'],
    // See the unit project's note: `.next/standalone` is a build artifact that
    // would otherwise be collected as a second copy of this suite.
    exclude: ['**/node_modules/**', '**/.claude/**', '**/.next/**'],
    setupFiles: ['tests/tool-pg/setup.ts'],
    // The suite shares one database; parallel files would race on seeded rows.
    fileParallelism: false,
    testTimeout: 30000,
  },
}

// Only register the pg-real project when DATABASE_URL is set. Local devs
// running a bare `vitest run` would otherwise hit the schema sanity check
// against a non-existent DB. `npm run test:pg` is the opt-in entry point, and
// `npm run test:tools` is the equivalent for tool-pg.
const projects = [
  unitProject,
  ...(process.env.DATABASE_URL ? [pgRealProject] : []),
  ...(process.env.TOOL_PG_REST_URL ? [toolPgProject] : []),
]

export default defineConfig({
  resolve: { alias },
  test: {
    globals: true,
    environment: 'node',
    projects,
  },
})
