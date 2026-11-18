/**
 * The dashboard bulk-book door's question about a filed momsperiod through
 * the booking's real dry run (bulk-book.ts), the VAT block's real check and
 * the real reading of the declaration: only the database is faked, and every
 * write to it is recorded. The unit test beside this one stubs the dry run,
 * so this is where "the question writes nothing" and "it asks about the
 * lines the samlingsverifikat would post" are held.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { makeTransaction } from '@/tests/helpers'
import { bulkBookTransactions } from '../bulk-book'
import { filedPeriodBulkBookWarning } from '../filed-vat-bulk-book'

type Row = Record<string, unknown>

function fakeSupabase(tables: Record<string, Row[]>) {
  const writes: string[] = []
  const from = (table: string) => {
    const rows = tables[table] ?? []
    const builder: Record<string, unknown> = {}
    for (const method of ['select', 'eq', 'in', 'is', 'gte', 'lte', 'gt', 'lt', 'order', 'limit', 'range', 'neq', 'or', 'not', 'ilike', 'like', 'contains', 'filter', 'match', 'overlaps']) {
      builder[method] = () => builder
    }
    for (const method of ['insert', 'update', 'upsert', 'delete']) {
      builder[method] = () => {
        writes.push(`${method} ${table}`)
        return builder
      }
    }
    builder.maybeSingle = async () => ({ data: rows[0] ?? null, error: null })
    builder.single = async () => ({ data: rows[0] ?? null, error: rows[0] ? null : { message: 'no rows' } })
    builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve({ data: rows, error: null }).then(resolve, reject)
    return builder
  }
  const rpc = async (name: string) => {
    if (name !== 'skattekonto_shape_accounts') writes.push(`rpc ${name}`)
    return name === 'skattekonto_shape_accounts' ? { data: ['1630'], error: null } : { data: [], error: null }
  }
  return { client: { from, rpc } as unknown as SupabaseClient, writes }
}

const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), child() { return this } } as unknown as Logger

const TX1 = '11111111-1111-4111-8111-111111111111'
const TX2 = '22222222-2222-4222-8222-222222222222'
const SETTINGS = {
  entity_type: 'aktiebolag',
  fiscal_year_start_month: 1,
  vat_taxable_base_over_40m: false,
  vat_has_eu_trade: false,
  vat_filing_method: null,
  vat_registered: true,
  moms_period: 'quarterly',
  accounting_method: 'accrual',
}
const Q3_FILED = {
  id: 'd-q3',
  tax_deadline_type: 'moms_quarterly',
  tax_period: '2026-Q3',
  is_completed: true,
  completed_at: '2026-11-11T12:00:00.000Z',
  status: 'submitted',
  notes: null,
  due_date: '2026-11-12',
}
/** A kvartalsmoms company with Q3 2026 filed, and two unbooked card purchases of 625 kr each on `date`. */
function company(date: string) {
  const row = (id: string) => ({
    ...makeTransaction({ id, date, amount: -625, currency: 'SEK', journal_entry_id: null }),
    is_ignored: false,
    transaction_voucher_links: [],
  })
  return fakeSupabase({
    transactions: [row(TX1), row(TX2)],
    company_settings: [SETTINGS],
    fiscal_periods: [{ id: 'fp', period_start: '2026-01-01', period_end: '2026-12-31', is_closed: false, locked_at: null }],
    deadlines: [Q3_FILED],
    chart_of_accounts: [
      { account_number: '1930', account_name: 'Företagskonto', is_active: true },
      { account_number: '2641', account_name: 'Debiterad ingående moms', is_active: true },
      { account_number: '6540', account_name: 'IT-tjänster', is_active: true },
      { account_number: '6570', account_name: 'Bankkostnader', is_active: true },
    ],
  })
}
const ctx = (client: SupabaseClient) => ({ supabase: client, companyId: 'c-1', userId: 'user-1', log })
const body = (lines: Array<[string, number, number]>) =>
  ({
    tx_ids: [TX1, TX2],
    entry_description: 'Kortköp september',
    manual_lines: lines.map(([account_number, debit_amount, credit_amount]) => ({
      account_number,
      debit_amount,
      credit_amount,
      currency: 'SEK',
    })),
  }) as never
const WITH_MOMS = body([['6540', 1000, 0], ['2641', 250, 0], ['1930', 0, 1250]])
const WITHOUT_MOMS = body([['6570', 1250, 0], ['1930', 0, 1250]])

describe('the question before a samlingsverifikat, through the real dry run', () => {
  it('the dry run this stands on accepts the batch (else every case below is vacuous)', async () => {
    const db = company('2026-09-27')

    const dry = await bulkBookTransactions(ctx(db.client), WITH_MOMS, { dryRun: true })

    expect(dry, JSON.stringify(dry)).toMatchObject({ ok: true, dryRun: true, preview: { mode: 'create_new', tx_date: '2026-09-27' } })
    expect(db.writes).toEqual([])
  })

  it('asks about purchases with 25 % moms dated in the filed quarter, with the rutor they move, and writes nothing', async () => {
    const db = company('2026-09-27')

    const warning = await filedPeriodBulkBookWarning(ctx(db.client), WITH_MOMS)

    expect(warning?.code).toBe('VAT_PERIOD_ALREADY_FILED')
    expect(warning?.message_sv).toBe(
      'Bokningen ändrar underlaget för en momsdeklaration som redan är inlämnad: 2026-Q3 (inlämnad 2026-11-11). ' +
        'Görs bokningen kan deklarationen behöva rättas.',
    )
    expect(warning?.details.filed_periods).toEqual([
      expect.objectContaining({ tax_period: '2026-Q3', rutor_change: { ruta48: 250, ruta49: -250 } }),
    ])
    expect(db.writes).toEqual([])
  })

  it('asks nothing about the same purchases dated after the filed quarter, and writes nothing', async () => {
    const db = company('2026-10-20')

    expect(await filedPeriodBulkBookWarning(ctx(db.client), WITH_MOMS)).toBeNull()
    expect(db.writes).toEqual([])
  })

  it('asks nothing about a samlingsverifikat without moms in the filed quarter', async () => {
    const db = company('2026-09-27')

    expect(await filedPeriodBulkBookWarning(ctx(db.client), WITHOUT_MOMS)).toBeNull()
    expect(db.writes).toEqual([])
  })
})
