import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'vitest'
import { getPool } from './setup'

describe('sandbox seed attempt lifecycle', () => {
  it('serializes claims, isolates users, preserves partial data and fences stale completions', async () => {
    const client = await getPool().connect()
    try {
      await client.query(readFileSync(resolve('tests/pg/sandbox-seed-attempts.sql'), 'utf8'))
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })
})
