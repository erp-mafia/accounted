/**
 * pg-real on several workers: one database per worker.
 *
 * The suite commits rows, so two test files cannot share a database at the
 * same moment. With PG_REAL_WORKERS set to 2 or more, tests/pg/global-setup.ts
 * copies the migrated database once per worker before the run, and
 * tests/pg/worker-database.ts points each test file at a copy no other file
 * is using. Without the variable the suite runs as before: one file at a time
 * in the database DATABASE_URL names.
 *
 * No imports here: vitest.config.ts reads workerCount() while it loads.
 */

const DEFAULT_URL = 'postgresql://postgres:postgres@localhost:5432/postgres'

/** The copy every worker database is made from. Nothing connects to it. */
export const TEMPLATE_DATABASE = 'pg_real_template'

/** First key of the advisory lock a test file holds on its database. */
export const SLOT_LOCK_KEY = 20261118

/** How many worker databases the run uses; 0 means the suite runs serially. */
export function workerCount(env: Record<string, string | undefined> = process.env): number {
  const raw = (env.PG_REAL_WORKERS ?? '').trim()
  if (!/^\d+$/.test(raw)) return 0
  const count = Number(raw)
  return count >= 2 ? Math.min(count, 16) : 0
}

export function workerDatabase(slot: number): string {
  return `pg_real_w${slot}`
}

/** The same server and login, another database. */
export function withDatabase(url: string, database: string): string {
  const next = new URL(url)
  next.pathname = `/${database}`
  return next.toString()
}

export function databaseOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, '')) || 'postgres'
}

/**
 * The database the migrations were applied to. worker-database.ts keeps it in
 * PG_REAL_BASE_URL when it points DATABASE_URL at a copy.
 */
export function baseDatabaseUrl(env: Record<string, string | undefined> = process.env): string {
  return env.PG_REAL_BASE_URL ?? env.DATABASE_URL ?? DEFAULT_URL
}

/**
 * For a test file that needs something only the migrated database itself has.
 * pg_cron is the case: it keeps its jobs in one database of the server. Call
 * it at the top of the file, before the first query. Serial runs are already
 * there, so it changes nothing for them.
 */
export function runInBaseDatabase(env: Record<string, string | undefined> = process.env): void {
  if (env.PG_REAL_BASE_URL) env.DATABASE_URL = env.PG_REAL_BASE_URL
}

/**
 * Take the first worker database no other test file holds, 1..count, and
 * wait while every one is taken. The lock is a session-level advisory lock on
 * the migrated database: it goes when the connection closes, so a worker that
 * dies frees its database too.
 */
export async function claimSlot(
  client: { query: (sql: string, values: unknown[]) => Promise<{ rows: Array<{ locked: boolean }> }> },
  count: number,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<number> {
  for (let round = 0; round < 600; round += 1) {
    for (let slot = 1; slot <= count; slot += 1) {
      const { rows } = await client.query('SELECT pg_try_advisory_lock($1, $2) AS locked', [SLOT_LOCK_KEY, slot])
      if (rows[0]?.locked) return slot
    }
    await wait(100)
  }
  throw new Error(`pg-real: no free worker database among ${count} after 60 seconds.`)
}
