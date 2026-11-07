import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { getClient } from './setup'
it('requires an authorized manual decision and preserves history without new accounting', async () => {
  const client = await getClient()
  try {
    await expect(client.query(readFileSync(fileURLToPath(new URL('./sql/historical-receivable-review.sql', import.meta.url)), 'utf8'))).resolves.toBeDefined()
  } finally { await client.query('ROLLBACK'); client.release() }
})
