import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { getClient } from './setup'

/**
 * claim_provider_migration_job (migration 20261112192901): a 'running' job
 * whose lease lapsed was never released, so its worker was ended. Still at
 * its claim mark, that run is counted as a failure and the fifth in a row
 * parks the job as needs_attention, which Fortsätt importen re-arms; a run
 * that moved the job on before it was ended is a deferral and resets the
 * count, as does the first lapse of a job claimed before the migration (it
 * has no mark to compare). Before, a job whose worker died every time was
 * claimed every five minutes for good. The assertions live in SQL because they drive the fenced
 * job RPCs in one rolled-back transaction, as provider-migration-jobs does.
 */
it('counts a lapsed lease that moved nothing, parks the job on the fifth, and never counts a run that moved it', async () => {
  const client = await getClient()
  try {
    const sql = readFileSync(fileURLToPath(new URL('./sql/provider-migration-lapsed-lease.sql', import.meta.url)), 'utf8')
    await expect(client.query(sql)).resolves.toBeDefined()
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
})
