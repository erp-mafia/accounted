import { describe, it, expect } from 'vitest'
import { loadBankingSummary, loadSieSummary, TX_ROLLUP_MAX_ROWS } from '../inputs'
import { createPagedMockSupabase, manyRows } from '@/tests/helpers'

// accounted#17: both transaction rollups read one PostgREST page (a written
// .limit of 5000 and 2000, answered with 1,000 rows), so a company with more
// bank lines got its volume, unbooked count and counterpart totals from a
// slice. The paged mock serves at most 1,000 rows a read, as production does.

const DAY = 86_400_000
const isoDaysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString().slice(0, 10)

function bankLine(i: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `tx-${String(i).padStart(6, '0')}`,
    description: 'Leverantoren AB',
    amount: -100,
    currency: 'SEK',
    amount_sek: null,
    exchange_rate: null,
    date: isoDaysAgo(Math.floor(i / 10)),
    journal_entry_id: i < 1500 ? null : `je-${i}`,
    ...overrides,
  }
}

describe('loadBankingSummary past one page', () => {
  it('sums every bank line of the year, not the newest 1,000', async () => {
    const { supabase } = createPagedMockSupabase({ transactions: manyRows(2500, (i) => bankLine(i)) })

    const summary = await loadBankingSummary(supabase as never, 'company-1')

    expect(summary).not.toBeNull()
    expect(summary!.top_counterparties[0]).toMatchObject({ name: 'Leverantoren AB', abs_amount: 250_000 })
    expect(summary!.volume_rows_with_sek).toBe(2500)
    expect(summary!.unbooked_count).toBe(1500)
    expect(summary!.monthly_volume).toBe(Math.round(250_000 / 12))
  })

  it('at the row cap, averages over the months the newest rows cover', async () => {
    // 20,001 lines, newest first, the oldest kept one 100 days back. The cap
    // drops the oldest line; the kept ones span about 3.3 months, not 12.
    const rows = manyRows(TX_ROLLUP_MAX_ROWS + 1, (i) =>
      bankLine(i, { date: isoDaysAgo(Math.floor((i * 100) / (TX_ROLLUP_MAX_ROWS - 1))), journal_entry_id: 'je' }),
    )
    const { supabase } = createPagedMockSupabase({ transactions: rows })

    const summary = await loadBankingSummary(supabase as never, 'company-1')

    expect(summary!.volume_rows_with_sek).toBe(TX_ROLLUP_MAX_ROWS)
    const months = 100 / (365.25 / 12)
    expect(summary!.monthly_volume).toBeGreaterThan(Math.round((TX_ROLLUP_MAX_ROWS * 100) / (months + 0.1)))
    expect(summary!.monthly_volume).toBeLessThan(Math.round((TX_ROLLUP_MAX_ROWS * 100) / (months - 0.1)))
  })
})

describe('loadSieSummary past one page', () => {
  it('ranks counterparts over every transaction, not the first 1,000', async () => {
    const { supabase } = createPagedMockSupabase({
      sie_imports: [{ id: 'imp-1', fiscal_year_start: '2025-01-01', fiscal_year_end: '2025-12-31' }],
      transactions: manyRows(2500, (i) => bankLine(i)),
    })

    const summary = await loadSieSummary(supabase as never, 'company-1')

    expect(summary!.top_counterparties[0]).toMatchObject({ name: 'Leverantoren AB', abs_amount: 250_000 })
    expect(summary!.year_count).toBe(1)
  })
})
