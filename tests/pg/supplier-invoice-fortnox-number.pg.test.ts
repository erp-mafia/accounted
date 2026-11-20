import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { getClient } from './setup'

/**
 * Covers 20261012161644_supplier_invoice_fortnox_number (crm#1157): the
 * Fortnox löpnummer has its own unique column; the import stores it,
 * recognises a stored invoice by it, takes an invoice imported before the
 * column by the löpnummer in its supplier number on the same supplier and
 * header, and refuses rather than guesses on another header or another
 * löpnummer.
 */
it('keeps the Fortnox löpnummer beside the supplier number and never stores a Fortnox invoice twice', async () => {
  const client = await getClient()
  try {
    const sql = readFileSync(
      fileURLToPath(new URL('./sql/supplier-invoice-fortnox-number.sql', import.meta.url)),
      'utf8',
    )
    await expect(client.query(sql)).resolves.toBeDefined()
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
})
