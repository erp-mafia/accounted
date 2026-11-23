import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockSupabase } from '@/tests/helpers'

const { supabase, mockResult } = createMockSupabase()

import { assembleMonthlyBreakdown, generateMonthlyBreakdown } from '../monthly-breakdown'

// Minimal chainable query mock: every filter/order method returns the same
// object; .single()/.range() resolve to the queued result. Tolerant of
// query-shape changes such as an added .order() (see fetch-all.ts ordering
// invariant) so the tests don't hardcode the exact method chain.
function chain(result: unknown) {
  const c: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'gte', 'lte', 'lt', 'neq', 'order', 'contains']) {
    c[m] = () => c
  }
  c.single = () => Promise.resolve(result)
  c.maybeSingle = () => Promise.resolve(result)
  c.range = () => Promise.resolve(result)
  return c
}

// A dimension filter keeps the line-level path (the daily sums the RPC reads
// cannot be split by dimension); without one the months come from
// get_kpi_report_aggregates.
const DIMS = { dimensions: { '6': 'P001' } }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('generateMonthlyBreakdown', () => {
  it('returns empty months when no fiscal period found', async () => {
    supabase.from.mockImplementation(() => chain({ data: null, error: null }))

    const result = await generateMonthlyBreakdown(supabase as never, 'company-1', 'period-1')
    expect(result.months).toEqual([])
  })

  // A failed read used to come back as { months: [] }: an empty chart that
  // looked like a company without bookings.
  it('throws when the fiscal period read fails', async () => {
    supabase.from.mockImplementation(() => chain({ data: null, error: { message: 'timeout', code: '57014' } }))

    await expect(generateMonthlyBreakdown(supabase as never, 'company-1', 'period-1')).rejects.toMatchObject({
      code: '57014',
    })
  })

  it('throws when the journal line read fails', async () => {
    let callCount = 0
    supabase.from.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return chain({ data: { period_start: '2024-01-01', period_end: '2024-12-31' }, error: null })
      }
      return chain({ data: null, error: { message: 'timeout', code: '57014' } })
    })
    supabase.rpc.mockResolvedValueOnce({ data: [], error: null })

    await expect(generateMonthlyBreakdown(supabase as never, 'company-1', 'period-1', DIMS)).rejects.toThrow()
  })

  it('returns empty months when no journal entries exist', async () => {
    // First call: fiscal period
    mockResult({
      data: { period_start: '2024-01-01', period_end: '2024-12-31' },
      error: null,
    })

    // We need two sequential calls with different results.
    // The proxy-based mock returns the same result for all calls,
    // so we re-mock after the first await completes.
    // Instead, test that an empty lines result returns initialized months.

    // For this test, override at the supabase.from level to return different chains
    let callCount = 0
    supabase.from.mockImplementation(() => {
      callCount++
      return callCount === 1
        ? chain({ data: { period_start: '2024-01-01', period_end: '2024-12-31' }, error: null })
        : chain({ data: [], error: null })
    })
    supabase.rpc.mockResolvedValueOnce({ data: [], error: null })

    const result = await generateMonthlyBreakdown(supabase as never, 'company-1', 'period-1', DIMS)
    expect(result.months.length).toBe(12)
    expect(result.months[0].label).toBe('Jan')
    expect(result.months[0].income).toBe(0)
    expect(result.months[0].expenses).toBe(0)
    expect(result.months[11].label).toBe('Dec')
  })

  it('correctly classifies revenue (class 3) and expense (class 4-7) accounts', async () => {
    // call 1 = fiscal period, then the year-end set (year_end_chain_entry_ids,
    // an RPC: none here), then the two-step entry-lines fetch
    // (lib/bookkeeping/entry-lines.ts): call 2 = journal_entries, call 3 =
    // lines by entry id (the parent entry is reattached under `journal_entry`).
    let callCount = 0
    supabase.from.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return chain({ data: { period_start: '2024-01-01', period_end: '2024-03-31' }, error: null })
      }
      if (callCount === 2) {
        return chain({
          data: [
            { id: 'e1', entry_date: '2024-01-15', status: 'posted', company_id: 'company-1', fiscal_period_id: 'period-1' },
            { id: 'e2', entry_date: '2024-01-20', status: 'posted', company_id: 'company-1', fiscal_period_id: 'period-1' },
            { id: 'e3', entry_date: '2024-02-10', status: 'posted', company_id: 'company-1', fiscal_period_id: 'period-1' },
            { id: 'e4', entry_date: '2024-02-15', status: 'posted', company_id: 'company-1', fiscal_period_id: 'period-1' },
          ],
          error: null,
        })
      }
      return chain({
        data: [
          { account_number: '3001', debit_amount: 0, credit_amount: 10000, journal_entry_id: 'e1' },
          { account_number: '5010', debit_amount: 3000, credit_amount: 0, journal_entry_id: 'e2' },
          { account_number: '3001', debit_amount: 0, credit_amount: 5000, journal_entry_id: 'e3' },
          { account_number: '6200', debit_amount: 1500, credit_amount: 0, journal_entry_id: 'e4' },
        ],
        error: null,
      })
    })

    supabase.rpc.mockResolvedValueOnce({ data: [], error: null })
    const result = await generateMonthlyBreakdown(supabase as never, 'company-1', 'period-1', DIMS)

    // January
    const jan = result.months.find((m) => m.label === 'Jan')!
    expect(jan.income).toBe(10000)
    expect(jan.expenses).toBe(3000)
    expect(jan.net).toBe(7000)

    // February
    const feb = result.months.find((m) => m.label === 'Feb')!
    expect(feb.income).toBe(5000)
    expect(feb.expenses).toBe(1500)
    expect(feb.net).toBe(3500)

    // March should be zero
    const mar = result.months.find((m) => m.label === 'Mar')!
    expect(mar.income).toBe(0)
    expect(mar.expenses).toBe(0)
  })

  it('ignores balance sheet accounts (class 1, 2) but includes class 8 financial items', async () => {
    // Two-step entry-lines fetch: call 1 = fiscal period, call 2 =
    // journal_entries, call 3 = lines by entry id.
    let callCount = 0
    supabase.from.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return chain({ data: { period_start: '2024-01-01', period_end: '2024-01-31' }, error: null })
      }
      if (callCount === 2) {
        return chain({
          data: [
            { id: 'e1', entry_date: '2024-01-15', status: 'posted', company_id: 'company-1', fiscal_period_id: 'period-1' },
            { id: 'e2', entry_date: '2024-01-20', status: 'posted', company_id: 'company-1', fiscal_period_id: 'period-1' },
            { id: 'e3', entry_date: '2024-01-25', status: 'posted', company_id: 'company-1', fiscal_period_id: 'period-1' },
          ],
          error: null,
        })
      }
      return chain({
        data: [
          { account_number: '1930', debit_amount: 10000, credit_amount: 0, journal_entry_id: 'e1' },
          { account_number: '2611', debit_amount: 0, credit_amount: 2500, journal_entry_id: 'e1' },
          { account_number: '8400', debit_amount: 500, credit_amount: 0, journal_entry_id: 'e2' },
          { account_number: '8300', debit_amount: 0, credit_amount: 200, journal_entry_id: 'e3' },
        ],
        error: null,
      })
    })

    supabase.rpc.mockResolvedValueOnce({ data: [], error: null })
    const result = await generateMonthlyBreakdown(supabase as never, 'company-1', 'period-1', DIMS)
    const jan = result.months.find((m) => m.label === 'Jan')!
    // Class 1 and 2 are ignored
    // Class 8 debit (8400 interest expense) → expense
    expect(jan.expenses).toBe(500)
    // Class 8 credit (8300 interest income) → income
    expect(jan.income).toBe(200)
  })

  it('leaves årets resultat (8990-8999) out of the month, whichever account the omföring used', async () => {
    let callCount = 0
    supabase.from.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return chain({ data: { period_start: '2024-01-01', period_end: '2024-01-31' }, error: null })
      }
      if (callCount === 2) {
        return chain({
          data: [
            { id: 'e1', entry_date: '2024-01-15', status: 'posted', company_id: 'company-1', fiscal_period_id: 'period-1' },
            { id: 'e2', entry_date: '2024-01-31', status: 'posted', company_id: 'company-1', fiscal_period_id: 'period-1' },
          ],
          error: null,
        })
      }
      return chain({
        data: [
          { account_number: '1930', debit_amount: 10000, credit_amount: 0, journal_entry_id: 'e1' },
          { account_number: '3041', debit_amount: 0, credit_amount: 10000, journal_entry_id: 'e1' },
          // The previous system's omföring through 8990, and a rest through 8999.
          { account_number: '8990', debit_amount: 9999.5, credit_amount: 0, journal_entry_id: 'e2' },
          { account_number: '8999', debit_amount: 0.5, credit_amount: 0, journal_entry_id: 'e2' },
          { account_number: '2099', debit_amount: 0, credit_amount: 10000, journal_entry_id: 'e2' },
        ],
        error: null,
      })
    })

    // The line path (a dimension filter); without one the same predicate is
    // get_kpi_report_aggregates' (20261023081500), pinned by its pg test.
    supabase.rpc.mockResolvedValueOnce({ data: [], error: null })
    const result = await generateMonthlyBreakdown(supabase as never, 'company-1', 'period-1', DIMS)
    const jan = result.months.find((m) => m.label === 'Jan')!
    expect(jan.income).toBe(10000)
    expect(jan.expenses).toBe(0)
  })
})

describe('generateMonthlyBreakdown: year-end exclusion', () => {
  it("leaves out the period's 'exclude-all-year-end' set, read from year_end_chain_entry_ids", async () => {
    // Regression: the resultatavslut posts the mirror image of every P&L
    // account, so the fiscal-year-end month reported the whole year's revenue
    // as negative income. Measured in real ledgers,
    // worst case a month understated by millions. The set holds the
    // year_end entries, the storno chain of an undone bokslut and a
    // resultatavslut booked in a previous system or by hand (20261024140100).
    const filters: Array<{ method: string; args: unknown[] }> = []
    let callCount = 0
    supabase.from.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return chain({ data: { period_start: '2024-01-01', period_end: '2024-12-31' }, error: null })
      }
      // Record the entry-side filters so the exclusion is asserted, not assumed.
      const c: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'gte', 'lte', 'lt', 'neq', 'not', 'order', 'or', 'contains']) {
        c[m] = (...args: unknown[]) => {
          filters.push({ method: m, args })
          return c
        }
      }
      c.single = () => Promise.resolve({ data: [], error: null })
      c.range = () => Promise.resolve({ data: [], error: null })
      return c
    })
    supabase.rpc.mockResolvedValueOnce({ data: ['ye-1', 'ye-storno-1', 'imported-closing-1'], error: null })

    await generateMonthlyBreakdown(supabase as never, 'company-1', 'period-1', DIMS)

    expect(supabase.rpc).toHaveBeenCalledWith('year_end_chain_entry_ids', {
      p_company_id: 'company-1',
      p_fiscal_period_id: 'period-1',
    })
    expect(filters).toContainEqual({ method: 'not', args: ['id', 'in', '(ye-1,ye-storno-1,imported-closing-1)'] })
  })

  it('fails instead of charting the year-end entries when the set cannot be read', async () => {
    supabase.from.mockImplementation(() =>
      chain({ data: { period_start: '2024-01-01', period_end: '2024-12-31' }, error: null }),
    )
    supabase.rpc.mockResolvedValueOnce({ data: null, error: { message: 'timeout', code: '57014' } })

    await expect(generateMonthlyBreakdown(supabase as never, 'company-1', 'period-1', DIMS)).rejects.toMatchObject({
      code: '57014',
    })
  })
})

describe('generateMonthlyBreakdown: no dimension filter', () => {
  it('reads the months from get_kpi_report_aggregates with no IB entry left out', async () => {
    supabase.from.mockImplementation(() =>
      chain({ data: { period_start: '2024-01-01', period_end: '2024-03-31' }, error: null }),
    )
    supabase.rpc.mockResolvedValueOnce({
      data: {
        tb: [],
        tb_ex_year_end: [],
        ob: [],
        monthly: [
          { year: 2024, month: 1, income: 10000, expenses: 3000 },
          { year: 2024, month: 2, income: 5000.004, expenses: 1500 },
        ],
      },
      error: null,
    })

    const result = await generateMonthlyBreakdown(supabase as never, 'company-1', 'period-1')

    expect(supabase.rpc).toHaveBeenCalledWith('get_kpi_report_aggregates', {
      p_company_id: 'company-1',
      p_fiscal_period_id: 'period-1',
      p_ob_entry_id: null,
    })
    expect(result.months).toEqual([
      { label: 'Jan', income: 10000, expenses: 3000, net: 7000 },
      { label: 'Feb', income: 5000, expenses: 1500, net: 3500 },
      { label: 'Mar', income: 0, expenses: 0, net: 0 },
    ])
    // No line reads: only the fiscal period comes from a table.
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('throws when the aggregates read fails, instead of drawing an empty chart', async () => {
    supabase.from.mockImplementation(() =>
      chain({ data: { period_start: '2024-01-01', period_end: '2024-12-31' }, error: null }),
    )
    supabase.rpc.mockResolvedValueOnce({ data: null, error: { message: 'timeout', code: '57014' } })

    await expect(generateMonthlyBreakdown(supabase as never, 'company-1', 'period-1')).rejects.toMatchObject({
      code: '57014',
    })
  })
})

describe('assembleMonthlyBreakdown: month labels', () => {
  it('labels a calendar year by month name only', () => {
    const { months } = assembleMonthlyBreakdown('2026-01-01', '2026-12-31', [])
    expect(months.map((m) => m.label)).toEqual([
      'Jan', 'Feb', 'Mar', 'Apr', 'Maj', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dec',
    ])
  })

  // An 18-month first räkenskapsår has July twice: without the year the two
  // months read the same, and React keyed the bars by label.
  it('names the year on every month when the months span calendar years', () => {
    const { months } = assembleMonthlyBreakdown('2025-07-17', '2026-12-31', [
      { year: 2025, month0: 6, income: 100, expenses: 0 },
      { year: 2026, month0: 6, income: 0, expenses: 40 },
    ])
    const labels = months.map((m) => m.label)
    expect(labels).toHaveLength(18)
    expect(labels[0]).toBe('Jul 2025')
    expect(labels[5]).toBe('Dec 2025')
    expect(labels[6]).toBe('Jan 2026')
    expect(labels[17]).toBe('Dec 2026')
    expect(new Set(labels).size).toBe(18)
    expect(months.find((m) => m.label === 'Jul 2025')).toMatchObject({ income: 100, expenses: 0, net: 100 })
    expect(months.find((m) => m.label === 'Jul 2026')).toMatchObject({ income: 0, expenses: 40, net: -40 })
  })

  it('names the year on a broken räkenskapsår', () => {
    const { months } = assembleMonthlyBreakdown('2025-05-01', '2026-04-30', [])
    expect(months.map((m) => m.label)).toEqual([
      'Maj 2025', 'Jun 2025', 'Jul 2025', 'Aug 2025', 'Sep 2025', 'Okt 2025', 'Nov 2025', 'Dec 2025',
      'Jan 2026', 'Feb 2026', 'Mar 2026', 'Apr 2026',
    ])
  })
})
