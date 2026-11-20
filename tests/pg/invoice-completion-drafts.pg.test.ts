import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { it } from 'vitest'
import { getClient } from './setup'

it('completes an imported row-less draft and leaves empty in-app drafts alone (crm#1245)', async () => {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(readFileSync(resolve(process.cwd(), 'tests/pg/sql/invoice-completion-drafts.sql'), 'utf8'))
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
})
