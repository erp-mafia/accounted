import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { getClient } from './setup'

it('writes the verifikat\'s SEK amount onto a linked foreign-currency invoice only, fenced and all-or-nothing', async () => {
  const client = await getClient()
  try {
    const sql = readFileSync(fileURLToPath(new URL('./sql/provider-migration-source-rate-links.sql', import.meta.url)), 'utf8')
    await expect(client.query(sql)).resolves.toBeDefined()
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
})
