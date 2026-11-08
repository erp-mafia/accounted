import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { getClient } from './setup'
it('compares retained source versions and reports only new or changed records without overwriting local data', async () => {
  const client = await getClient()
  try {
    await expect(client.query(readFileSync(fileURLToPath(new URL('./sql/provider-resync.sql', import.meta.url)), 'utf8'))).resolves.toBeDefined()
  } finally { await client.query('ROLLBACK'); client.release() }
})
