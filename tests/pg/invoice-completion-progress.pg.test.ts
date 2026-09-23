import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { it } from 'vitest'
import { getClient } from './setup'

it('resumes discovery, fences stale workers, preserves ambiguity and commits cron/wizard rows and history atomically', async () => {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(readFileSync(resolve(process.cwd(), 'tests/pg/sql/invoice-completion-progress.sql'), 'utf8'))
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
})
