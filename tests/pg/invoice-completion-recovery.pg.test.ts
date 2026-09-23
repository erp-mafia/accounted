import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { it } from 'vitest'
import { getClient } from './setup'

it('blocks only the failed revision, resumes saved work and fences reconnect/retry races', async () => {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(readFileSync(resolve(process.cwd(), 'tests/pg/sql/invoice-completion-recovery.sql'), 'utf8'))
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
})
