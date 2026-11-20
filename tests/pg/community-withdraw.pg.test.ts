import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'vitest'
import { getClient } from './setup'

describe('community withdraw: back to private, hidden from every AI', () => {
  it('returns a withdrawn item to private without review evidence, hides its atom, keeps a send-back note and lets the author delete it', async () => {
    const client = await getClient()
    try {
      await client.query(readFileSync(join(process.cwd(), 'tests/pg/community-withdraw.sql'), 'utf8'))
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })
})
