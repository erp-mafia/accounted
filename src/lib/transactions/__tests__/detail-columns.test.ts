import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSchemaFromMigrations, parseSelectSpec } from '@/tests/schema/schema-guard'
import { TRANSACTION_DETAIL_COLUMNS } from '@/lib/transactions/detail-columns'

/**
 * The phantom-column guard (tests/schema/no-phantom-columns.test.ts) cannot
 * read a select passed as a constant, so the two doors that select this list
 * (v1 transaction detail, MCP gnubok_get_transaction) are checked here against
 * the schema replayed from the migrations instead.
 */
describe('TRANSACTION_DETAIL_COLUMNS', () => {
  it('names only columns the transactions table has', () => {
    const schema = buildSchemaFromMigrations(path.resolve(__dirname, '..', '..', '..', '..', 'supabase', 'migrations'))
    const table = schema.tables.get('transactions')
    expect(table).toBeDefined()
    const parsed = parseSelectSpec(TRANSACTION_DETAIL_COLUMNS)
    expect(parsed.embeds).toEqual([])
    expect(parsed.unparsed).toEqual([])
    const missing = parsed.columns.filter((column) => !table!.columns.has(column))
    expect(missing).toEqual([])
    expect(parsed.columns).toContain('external_id')
  })
})
