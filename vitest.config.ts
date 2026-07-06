import { defineConfig } from 'vitest/config'
import path from 'path'

const alias = { '@': path.resolve(__dirname, '.') }

const unitProject = {
  resolve: { alias },
  test: {
    name: 'unit',
    globals: true,
    environment: 'node' as const,
    include: ['**/*.test.ts'],
    // `.claude/worktrees/*` are ephemeral agent checkouts whose `@/*` imports
    // resolve back to this root: never part of the suite.
    exclude: ['**/node_modules/**', '**/*.pg.test.ts', '**/.claude/**'],
  },
}

const pgRealProject = {
  resolve: { alias },
  test: {
    name: 'pg-real',
    globals: true,
    environment: 'node' as const,
    include: ['**/*.pg.test.ts'],
    exclude: ['**/node_modules/**', '**/.claude/**'],
    setupFiles: ['tests/pg/setup.ts'],
    // One-connection-at-a-time to avoid cross-file DB contention.
    fileParallelism: false,
    testTimeout: 15000,
  },
}

// Only register the pg-real project when DATABASE_URL is set. Local devs
// running a bare `vitest run` would otherwise hit the schema sanity check
// against a non-existent DB. `npm run test:pg` is the opt-in entry point.
const projects = process.env.DATABASE_URL
  ? [unitProject, pgRealProject]
  : [unitProject]

export default defineConfig({
  resolve: { alias },
  test: {
    globals: true,
    environment: 'node',
    projects,
  },
})
