import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { getClient } from './setup'

/**
 * skip_provider_migration_resource (migration 20261005193815, PH 149 and
 * PH 145): a register the provider refuses is recorded with why and the job
 * moves on to the next one, fenced like save_provider_migration_page, and a
 * job with refused registers still completes with what it got. The
 * assertions live in SQL because they drive the fenced job RPCs in one
 * rolled-back transaction, the same way provider-migration-jobs.pg.test.ts
 * does.
 */
it('records a refused register with its reason, advances the cursor once, keeps saved pages and completes the job', async () => {
  const client = await getClient()
  try {
    const sql = readFileSync(fileURLToPath(new URL('./sql/provider-migration-refused-registers.sql', import.meta.url)), 'utf8')
    await expect(client.query(sql)).resolves.toBeDefined()
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
})
