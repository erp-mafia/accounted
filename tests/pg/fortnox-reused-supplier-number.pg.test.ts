import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { getClient } from './setup'

/**
 * crm#1157 step 2: once Fortnox supplier invoices carry the supplier's own
 * number, a supplier that reuses one (crm#1039) must not cost an invoice in
 * commit_provider_migration_records (current definition:
 * 20261012161644_supplier_invoice_fortnox_number). Each Fortnox record stays
 * its own row with its own löpnummer, a re-run finds each by it, and the
 * reused-number rule refuses what it refuses for every provider.
 */
it('keeps every Fortnox invoice of a supplier that reuses its invoice number', async () => {
  const client = await getClient()
  try {
    const sql = readFileSync(
      fileURLToPath(new URL('./sql/fortnox-reused-supplier-number.sql', import.meta.url)),
      'utf8',
    )
    await expect(client.query(sql)).resolves.toBeDefined()
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
})
