import { Client } from 'pg'
import { afterAll } from 'vitest'
import { baseDatabaseUrl, claimSlot, withDatabase, workerCount, workerDatabase } from './parallel'

/**
 * First setup file of the pg-real project. With PG_REAL_WORKERS set, it takes
 * a worker database for the test file about to run and points DATABASE_URL at
 * it, before tests/pg/setup.ts or the test file reads the variable. The
 * connection that holds the claim stays open until the file is done.
 */

const workers = workerCount()

if (workers > 0) {
  const base = baseDatabaseUrl()
  process.env.PG_REAL_BASE_URL = base
  const coordinator = new Client({ connectionString: base })
  await coordinator.connect()
  const slot = await claimSlot(
    { query: (sql, values) => coordinator.query<{ locked: boolean }>(sql, values) },
    workers,
  )
  process.env.DATABASE_URL = withDatabase(base, workerDatabase(slot))

  afterAll(async () => {
    await coordinator.end().catch(() => {})
  })
}
