import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { getClient } from './setup'

/**
 * retry_provider_migration_job and provider_migration_counts (migration
 * 20261118221500, crm#2002): an invoice the register import declined as
 * outside the imported fiscal years is judged again by a retry once an SIE
 * import has completed after it was declined, and counted as such for the
 * review. A skip no import has changed since, a skip with a reason of its own
 * and the records of an accepted job are left alone. The assertions live in
 * SQL because they drive the fenced job RPCs in one rolled-back transaction,
 * as provider-migration-review-accept does.
 */
it('re-queues the invoices declined as outside the imported years once more years are imported, and nothing else', async () => {
  const client = await getClient()
  try {
    const sql = readFileSync(fileURLToPath(new URL('./sql/provider-migration-rejudge-outside-years.sql', import.meta.url)), 'utf8')
    await expect(client.query(sql)).resolves.toBeDefined()
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
})
