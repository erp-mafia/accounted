import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'vitest'
import { getClient } from './setup'

describe('community publishing: review notes and stats for every published item', () => {
  it('keeps the review note Accounted-only, lets a sent-back item be shared again, and gives GitHub-only items their kind, author and industries', async () => {
    const client = await getClient()
    try {
      await client.query(readFileSync(join(process.cwd(), 'tests/pg/community-publishing.sql'), 'utf8'))
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })
})
