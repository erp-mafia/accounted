import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { getClient } from './setup'

it('completes Bokio evidence atomically, preserves edits, resumes safely and isolates tenants', async () => {
  const client = await getClient()
  try {
    await expect(client.query(readFileSync(fileURLToPath(new URL('./sql/bokio-supplier-completion.sql', import.meta.url)), 'utf8'))).resolves.toBeDefined()
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
})
