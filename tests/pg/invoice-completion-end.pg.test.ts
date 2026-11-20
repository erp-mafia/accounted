import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { it } from 'vitest'
import { getClient } from './setup'

it('gives an invoice up after its last try, keeps failed ones hourly below their cap, and parks idle companies', async () => {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(readFileSync(resolve(process.cwd(), 'tests/pg/sql/invoice-completion-end.sql'), 'utf8'))
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
})
