import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockSupabase } from '@/tests/helpers'

const { supabase, mockResult } = createMockSupabase()

import { generateMonthlyBreakdown } from '../monthly-breakdown'

// Minimal chainable query mock: every filter/order method returns the same
// object; .single()/.range() resolve to the queued result. Tolerant of
// query-shape changes such as an added .order() (see fetch-all.ts ordering
// invariant) so the tests don't hardcode the exact method chain.
function chain(result: unknown) {
  const c: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'gte', 'lte', 'lt', 'neq', 'order']) {
    c[m] = () => c
  }
  c.single = () => Promise.resolve(result)
  c.range = () => Promise.resolve(result)
  return c
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('generateMonthlyBreakdown', () => {
  it('returns empty months when no fiscal period found', async () => {
    mockResult({ data: null, error: { message: 'not found' } })

    const result = await generateMonthlyBreakdown(supabase as never, 'company-1', 'period-1')
    expect(result.months).toEqual([])
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

    const result = await generateMonthlyBreakdown(supabase as never, 'company-1', 'period-1')
    expect(result.months.length).toBe(12)
    expect(result.months[0].label).toBe('Jan')
    expect(result.months[0].income).toBe(0)
    expect(result.months[0].expenses).toBe(0)
    expect(result.months[11].label).toBe('Dec')
  })

  it('correctly classifies revenue (class 3) and expense (class 4-7) accounts', async () => {
    // Two-step entry-lines fetch (lib/bookkeeping/entry-lines.ts):
    // call 1 = fiscal period, call 2 = journal_entries, call 3 = lines by
    // entry id (the parent entry is reattached under `journal_entry`).
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

    const result = await generateMonthlyBreakdown(supabase as never, 'company-1', 'period-1')

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

    const result = await generateMonthlyBreakdown(supabase as never, 'company-1', 'period-1')
    const jan = result.months.find((m) => m.label === 'Jan')!
    // Class 1 and 2 are ignored
    // Class 8 debit (8400 interest expense) → expense
    expect(jan.expenses).toBe(500)
    // Class 8 credit (8300 interest income) → income
    expect(jan.income).toBe(200)
  })
})
