import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { getClient } from './setup'

/**
 * A Fortnox supplier invoice an import from before fortnox_number holds on
 * another supplier card than the one the background import resolves for its
 * Fortnox supplier is that invoice, and commit_provider_migration_records
 * (current definition: 20261126190000) adopts it instead of storing it a
 * second time. A löpnummer another header holds is left alone, and one two
 * cards hold is refused.
 */
it('adopts a Fortnox invoice the company holds on another supplier card', async () => {
  const client = await getClient()
  try {
    const sql = readFileSync(
      fileURLToPath(new URL('./sql/fortnox-invoice-on-another-card.sql', import.meta.url)),
      'utf8',
    )
    await expect(client.query(sql)).resolves.toBeDefined()
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
})
