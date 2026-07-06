import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================
// Dimension-filtered trial balance (dimensions PR4).
//
// Table-keyed FIFO mock like trial-balance.test.ts, extended with
// `contains`/`not` and per-table call capture so the jsonb containment
// pushdown is assertable.
// ============================================================

type MockResult = { data?: unknown; error?: unknown }
let mockResults: Record<string, MockResult[]>
let containsCalls: { table: string; column: string; value: unknown }[]

function makeBuilder(tableName: string) {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'lt', 'lte', 'gte', 'neq', 'not', 'order', 'range']) {
    b[m] = vi.fn().mockReturnValue(b)
  }
  b.contains = vi.fn().mockImplementation((column: string, value: unknown) => {
    containsCalls.push({ table: tableName, column, value })
    return b
  })
  const consume = (): MockResult => {
    const queue = mockResults[tableName]
    if (!queue || queue.length === 0) return { data: null, error: null }
    return queue.shift()!
  }
  b.single = vi.fn().mockImplementation(async () => consume())
  b.maybeSingle = vi.fn().mockImplementation(async () => consume())
  b.then = (resolve: (v: unknown) => void) => resolve(consume())
  return b
}

function makeClient() {
  return {
    from: vi.fn().mockImplementation((table: string) => makeBuilder(table)),
    rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

vi.mock('../opening-balances', () => ({
  getOpeningBalances: vi.fn(),
}))

import { generateTrialBalance } from '../trial-balance'
import { getOpeningBalances } from '../opening-balances'

const mockOpeningBalances = vi.mocked(getOpeningBalances)

let supabase: ReturnType<typeof makeClient>

beforeEach(() => {
  vi.clearAllMocks()
  mockResults = {}
  containsCalls = []
  supabase = makeClient()
})

const PERIOD = { period_start: '2026-01-01', period_end: '2026-12-31', opening_balance_entry_id: null }

function seedCommon() {
  mockResults = {
    fiscal_periods: [{ data: PERIOD, error: null }],
    journal_entry_lines: [
      {
        data: [
          { id: 'l1', account_number: '3001', debit_amount: 0, credit_amount: 500 },
          { id: 'l2', account_number: '1930', debit_amount: 500, credit_amount: 0 },
        ],
        error: null,
      },
    ],
    chart_of_accounts: [
      {
        data: [
          { account_number: '1930', account_name: 'Företagskonto', account_class: 1 },
          { account_number: '3001', account_name: 'Försäljning', account_class: 3 },
        ],
        error: null,
      },
    ],
  }
}

describe('generateTrialBalance: dimensions option', () => {
  it('pushes the filter down as jsonb containment on the line query', async () => {
    seedCommon()
    mockOpeningBalances.mockResolvedValue({ balances: new Map(), obEntryId: null })

    await generateTrialBalance(supabase, 'company-1', 'period-1', {
      dimensions: { '6': 'P001' },
    })

    expect(containsCalls).toEqual([
      { table: 'journal_entry_lines', column: 'dimensions', value: { '6': 'P001' } },
    ])
  })

  it('does not touch the query when no filter is passed (back-compat)', async () => {
    seedCommon()
    mockOpeningBalances.mockResolvedValue({ balances: new Map(), obEntryId: null })

    await generateTrialBalance(supabase, 'company-1', 'period-1')

    expect(containsCalls).toEqual([])
  })

  it('treats an empty filter object as no filter', async () => {
    seedCommon()
    mockOpeningBalances.mockResolvedValue({ balances: new Map(), obEntryId: null })

    await generateTrialBalance(supabase, 'company-1', 'period-1', { dimensions: {} })

    expect(containsCalls).toEqual([])
  })

  it('drops company-wide opening balances when filtered: amounts are dimension-scoped activity only', async () => {
    seedCommon()
    // Company-wide IB on 1930 that CANNOT be dimension-scoped.
    mockOpeningBalances.mockResolvedValue({
      balances: new Map([['1930', { debit: 9000, credit: 0 }]]),
      obEntryId: null,
    })

    const filtered = await generateTrialBalance(supabase, 'company-1', 'period-1', {
      dimensions: { '6': 'P001' },
    })

    const bank = filtered.rows.find((r) => r.account_number === '1930')
    expect(bank?.opening_debit).toBe(0)
    expect(bank?.closing_debit).toBe(500) // period activity only

    // Unfiltered keeps the IB (control).
    seedCommon()
    const unfiltered = await generateTrialBalance(supabase, 'company-1', 'period-1')
    const bank2 = unfiltered.rows.find((r) => r.account_number === '1930')
    expect(bank2?.opening_debit).toBe(9000)
    expect(bank2?.closing_debit).toBe(9500)
  })

  it('applies the filter to the IB roll-forward query too (fromDate sub-range)', async () => {
    seedCommon()
    // Roll-forward query consumes the first journal_entry_lines result; add a
    // second for the period query.
    mockResults.journal_entry_lines.push({ data: [], error: null })
    mockOpeningBalances.mockResolvedValue({ balances: new Map(), obEntryId: null })

    await generateTrialBalance(supabase, 'company-1', 'period-1', {
      fromDate: '2026-06-01',
      dimensions: { '1': 'KS01' },
    })

    // Both line queries (roll-forward + period) carry the containment filter.
    expect(containsCalls).toHaveLength(2)
    expect(containsCalls.every((c) => c.column === 'dimensions')).toBe(true)
    expect(containsCalls.every((c) => JSON.stringify(c.value) === '{"1":"KS01"}')).toBe(true)
  })
})
