import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { getClient } from './setup'

/**
 * Covers 20261006184512_provider_migration_reused_supplier_number (crm#1039):
 * a supplier number reused on another invoice date imports without a number,
 * the reference kept as payment_reference; the same number and date stays a
 * refusal; a run without its source map adopts the moved invoice; the unique
 * index still guards real numbers; the Bokio completion pass recognises it.
 */
it('imports a reused supplier number on another date as payment_reference and keeps refusing duplicates', async () => {
  const client = await getClient()
  try {
    const sql = readFileSync(
      fileURLToPath(new URL('./sql/provider-migration-reused-supplier-number.sql', import.meta.url)),
      'utf8',
    )
    await expect(client.query(sql)).resolves.toBeDefined()
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
})
