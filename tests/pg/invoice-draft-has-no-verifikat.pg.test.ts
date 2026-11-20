import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { getClient } from './setup'

it('never lets a draft hold a verifikat, and issues a draft the import links to its source verifikat', async () => {
  const client = await getClient()
  try {
    const sql = readFileSync(fileURLToPath(new URL('./sql/invoice-draft-has-no-verifikat.sql', import.meta.url)), 'utf8')
    await expect(client.query(sql)).resolves.toBeDefined()
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
})
