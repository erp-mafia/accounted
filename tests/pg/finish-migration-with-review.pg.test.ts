import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { getClient } from './setup'
it('finishes only reviewable executions, retaining evidence and allowing later resumption', async () => {
  const client = await getClient()
  try {
    await expect(client.query(readFileSync(fileURLToPath(new URL('./sql/finish-migration-with-review.sql', import.meta.url)), 'utf8'))).resolves.toBeDefined()
  } finally { await client.query('ROLLBACK'); client.release() }
})
