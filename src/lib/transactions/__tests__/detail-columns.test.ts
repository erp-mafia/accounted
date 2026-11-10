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
    // The bank's own text and ids (an agent tells a resent row apart by them).
    for (const column of ['original_description', 'provider_transaction_id', 'end_to_end_id', 'value_date']) {
      expect(parsed.columns).toContain(column)
    }
  })

  /**
   * Read parity: a column Accounted stores on a bank row is on the detail
   * read, or named here with the reason it is left out. A migration adding a
   * column fails this test until someone decides which, so "stored but no
   * read returns it" (the agents' most reported read gap) cannot come back
   * silently. Prefer moving a column onto the read over adding it here.
   */
  const LEFT_OUT: Record<string, string> = {
    company_id: 'tenancy: the caller named the company',
    user_id: 'a person id; agent reads name people through lib/attribution, never by id',
    bank_connection_id: 'internal connection row; cash_account_id names the account',
    bank_file_import_id: 'internal import batch id',
    raw_document_id: 'the archived raw bank page, an internal audit artefact',
    enrichment: 'raw enrichment payload; its readable parts are columns already on the read',
    enriched_at: 'internal timestamp of the enrichment run; is_enriched is on the read',
    potential_rot_rut_payout_request_id: 'not decided yet (2026-11-09): ROT/RUT payout suggestion pointer',
    mcc_code: 'not decided yet (2026-11-09): card merchant category code, no screen shows it',
    notes: 'not decided yet (2026-11-09)',
    bank_transaction_code: 'not decided yet (2026-11-09): ISO 20022 bank transaction code',
    proprietary_bank_transaction_code: 'not decided yet (2026-11-09)',
    link_basis: 'not decided yet (2026-11-09): why a link was made, read through the voucher',
    link_evidence: 'not decided yet (2026-11-09)',
  }

  it('returns every transactions column, or names it as left out with a reason', () => {
    const schema = buildSchemaFromMigrations(path.resolve(__dirname, '..', '..', '..', '..', 'supabase', 'migrations'))
    const table = schema.tables.get('transactions')!
    // gnubok_get_transaction also selects is_ignored and is_booked (returned as booked).
    const onRead = new Set([...parseSelectSpec(TRANSACTION_DETAIL_COLUMNS).columns, 'is_ignored', 'is_booked'])
    const unaccounted = [...table.columns.keys()].filter((column) => !onRead.has(column) && !(column in LEFT_OUT))
    expect(unaccounted).toEqual([])
    // The list only shrinks: a name the read now returns, or the table no longer has, goes.
    const stale = Object.keys(LEFT_OUT).filter((column) => onRead.has(column) || !table.columns.has(column))
    expect(stale).toEqual([])
  })
})
