/**
 * The dashboard categorize door's question about a filed momsperiod through
 * the booking's real dry run (categorize-core), the VAT block's real check
 * and the real reading of the declaration: only the database is faked, and
 * every write to it is recorded. The unit test beside this one stubs the dry
 * run, so this is where "the question writes nothing" and "it asks about the
 * lines the booking would post" are held.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { makeTransaction } from '@/tests/helpers'
import { filedPeriodCategorizeWarning } from '../filed-vat-categorize'

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
  const rpc = async (name: string) =>
    name === 'skattekonto_shape_accounts' ? { data: ['1630'], error: null } : { data: [], error: null }
  return { client: { from, rpc } as unknown as SupabaseClient, writes }
}

const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), child() { return this } } as unknown as Logger

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
/** A kvartalsmoms company with Q3 2026 filed, and one unbooked card purchase of 625 kr on `date`. */
function company(date: string) {
  const tx = makeTransaction({ id: 'tx-1', date, amount: -625, currency: 'SEK', journal_entry_id: null })
  return fakeSupabase({
    transactions: [{ ...tx, transaction_voucher_links: [] }],
    company_settings: [SETTINGS],
    fiscal_periods: [{ id: 'fp', period_start: '2026-01-01', period_end: '2026-12-31', is_closed: false, locked_at: null }],
    deadlines: [Q3_FILED],
    chart_of_accounts: [],
  })
}
const ask = (client: SupabaseClient, booking: Record<string, unknown>) =>
  filedPeriodCategorizeWarning(client, 'user-1', 'c-1', 'tx-1', booking as never, { onBooked: 'update_flags', log })

describe('the question before a category booking, through the real dry run', () => {
  it('asks about a purchase with 25 % moms dated in the filed quarter, with the rutor it moves, and writes nothing', async () => {
    const db = company('2026-09-27')

    const warning = await ask(db.client, { is_business: true, category: 'expense_software', vat_treatment: 'standard_25' })

    expect(warning?.code).toBe('VAT_PERIOD_ALREADY_FILED')
    expect(warning?.message_sv).toBe(
      'Bokningen ändrar underlaget för en momsdeklaration som redan är inlämnad: 2026-Q3 (inlämnad 2026-11-11). ' +
        'Bokförs raden kan deklarationen behöva rättas.',
    )
    expect(warning?.details.filed_periods).toEqual([
      expect.objectContaining({ tax_period: '2026-Q3', rutor_change: { ruta48: 125, ruta49: -125 } }),
    ])
    expect(db.writes).toEqual([])
  })

  it('asks nothing about the same purchase dated after the filed quarter, and writes nothing', async () => {
    const db = company('2026-10-20')

    expect(await ask(db.client, { is_business: true, category: 'expense_software', vat_treatment: 'standard_25' })).toBeNull()
    expect(db.writes).toEqual([])
  })

  it('asks nothing about a booking without moms in the filed quarter', async () => {
    const db = company('2026-09-27')

    expect(await ask(db.client, { is_business: true, category: 'expense_bank_fees' })).toBeNull()
    expect(db.writes).toEqual([])
  })
})
