import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { getClient } from './setup'

/**
 * provider_migration_counts (migration 20260920190600, #2789): a migrated
 * kreditfaktura counts as unlinked when it IS unlinked once its link phase
 * has run, including one that names an invoice the import could not resolve,
 * and the paired ones are reported too. The assertions live in SQL because
 * they drive the fenced job RPCs in one rolled-back transaction, the same way
 * provider-migration-jobs.pg.test.ts does.
 */
it('counts a referenced but unresolved credit note as unlinked, reports the paired ones, and keeps company RLS', async () => {
  const client = await getClient()
  try {
    const sql = readFileSync(fileURLToPath(new URL('./sql/provider-migration-credit-note-counts.sql', import.meta.url)), 'utf8')
    await expect(client.query(sql)).resolves.toBeDefined()
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
})
