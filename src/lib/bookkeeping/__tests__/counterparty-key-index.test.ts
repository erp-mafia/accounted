/**
 * idx_transactions_booked_counterparty_key (migration 20261123193000) stores
 * normalize_counterparty_key's result for every booked bank row. Postgres
 * does not rebuild an expression index when the function behind it is
 * redefined, so a later migration that redefines the function must rebuild
 * the index in the same file; otherwise rows written before it are looked up
 * under their old key.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const MIGRATIONS = join(__dirname, '..', '..', '..', '..', 'supabase', 'migrations')
const INDEX_MIGRATION = '20261123193000_transactions_booked_counterparty_key_index.sql'
const INDEX = 'idx_transactions_booked_counterparty_key'

const REDEFINES = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?normalize_counterparty_key\s*\(/i
const REBUILDS = new RegExp(`REINDEX\\s+INDEX\\s+(?:CONCURRENTLY\\s+)?(?:public\\.)?${INDEX}\\b`, 'i')

describe('normalize_counterparty_key and the index that stores its result', () => {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()

  it('the index migration is in the tree and indexes the function', () => {
    expect(files).toContain(INDEX_MIGRATION)
    const sql = readFileSync(join(MIGRATIONS, INDEX_MIGRATION), 'utf8')
    expect(sql).toContain(`CREATE INDEX CONCURRENTLY ${INDEX}`)
    expect(sql).toContain('public.normalize_counterparty_key(coalesce(nullif(merchant_name, \'\'), nullif(original_description, \'\'), description))')
  })

  it('the function reads the rows by the indexed expression, word for word', () => {
    const fn = readFileSync(join(MIGRATIONS, '20261123193100_booking_precedents.sql'), 'utf8')
    expect(fn).toContain(
      "public.normalize_counterparty_key(coalesce(nullif(t.merchant_name, ''), nullif(t.original_description, ''), t.description)) = k.counterparty_key",
    )
    expect(fn).toContain('AND t.journal_entry_id IS NOT NULL')
  })

  it('every later migration that redefines the function rebuilds the index', () => {
    const later = files.filter((f) => f > INDEX_MIGRATION)
    const missing = later.filter((f) => {
      const sql = readFileSync(join(MIGRATIONS, f), 'utf8')
      return REDEFINES.test(sql) && !REBUILDS.test(sql)
    })
    expect(missing).toEqual([])
  })
})
