import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'vitest'
import { getClient } from './setup'

describe('company_agent_knowledge real RLS and guard', () => {
  it('isolates tenants, keeps viewers read-only, adds only live packs and pins a choice to its agent', async () => {
    const client = await getClient()
    try {
      await client.query(readFileSync(join(process.cwd(), 'tests/pg/company-agent-knowledge.sql'), 'utf8'))
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })
})
