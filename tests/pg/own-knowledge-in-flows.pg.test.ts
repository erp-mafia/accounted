import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'vitest'
import { getClient } from './setup'

describe('own knowledge given to flows (company_agent_knowledge.own_skill_id)', () => {
  it("adds only the company's own added knowledge, once, never as a default, and drops it with the item", async () => {
    const client = await getClient()
    try {
      await client.query(readFileSync(join(process.cwd(), 'tests/pg/own-knowledge-in-flows.sql'), 'utf8'))
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })
})
