import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'vitest'
import { getClient } from './setup'

describe('community_feedback real RLS, guard and stats', () => {
  it('keeps each row to its person, votes only on live community items, freezes the kind and counts across tenants', async () => {
    const client = await getClient()
    try {
      await client.query(readFileSync(join(process.cwd(), 'tests/pg/community-feedback.sql'), 'utf8'))
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })
})
