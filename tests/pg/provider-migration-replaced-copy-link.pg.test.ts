import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { getClient } from './setup'

it('moves a registration link from the reversed copy an SIE re-sync left, only for the same source voucher and year', async () => {
  const client = await getClient()
  try {
    const sql = readFileSync(fileURLToPath(new URL('./sql/provider-migration-replaced-copy-link.sql', import.meta.url)), 'utf8')
    await expect(client.query(sql)).resolves.toBeDefined()
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
})
